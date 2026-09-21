// Local device TTS — macOS `say` (+ffmpeg), Windows SAPI, Linux espeak.
// WAV-producing platforms return "wav" so they don't depend on ffmpeg.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const execFileAsync = promisify(execFile);

let _voicesCache = null;

async function fetchVoicesMac() {
  const { stdout } = await execFileAsync("say", ["-v", "?"]);
  const voices = [];
  for (const line of stdout.split("\n")) {
    const m = line.match(/^([^\s].*?)\s{2,}([a-z]{2}_[A-Z]{2})/);
    if (!m) continue;
    const name = m[1].trim();
    const locale = m[2].trim();
    const lang = locale.split("_")[0];
    const country = locale.split("_")[1];
    voices.push({ id: name, name, locale, lang, country, gender: "" });
  }
  return voices;
}

async function fetchVoicesWin() {
  const script = [
    "Add-Type -AssemblyName System.Speech;",
    "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;",
    "$s.GetInstalledVoices() | ForEach-Object { $v = $_.VoiceInfo;",
    "[PSCustomObject]@{ Name=$v.Name; Culture=$v.Culture.Name; Gender=$v.Gender } }",
    "| ConvertTo-Json -Compress",
  ].join(" ");
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script],
    { windowsHide: true }
  );
  const raw = JSON.parse(stdout.trim() || "[]");
  const list = Array.isArray(raw) ? raw : [raw];
  return list.map((v) => {
    const culture = v.Culture || "en-US";
    const [lang, country = ""] = culture.split("-");
    const genderMap = { 1: "Male", 2: "Female", Male: "Male", Female: "Female" };
    return {
      id: v.Name, name: v.Name,
      locale: culture.replace("-", "_"),
      lang, country,
      gender: genderMap[v.Gender] || "",
    };
  });
}

// espeak(-ng) `--voices` is a plain-text table whose column count and spacing
// differ between builds, so it is scanned token-by-token: the first token that
// looks like a BCP-47 code is the voice id, the next readable word is the name.
const LOCALE_TOKEN = /^[a-z]{2,3}(-[a-z0-9]{2,4}){0,2}$/i;

function parseEspeakVoices(stdout) {
  const voices = [];
  const seen = new Set();
  for (const line of stdout.split("\n")) {
    const tokens = line.trim().split(/\s+/).filter(Boolean);
    const idx = tokens.findIndex((t) => LOCALE_TOKEN.test(t));
    if (idx === -1 || idx > 2) continue;      // header/blank lines have no leading code
    const id = tokens[idx].toLowerCase();
    if (seen.has(id)) continue;               // one entry per language
    seen.add(id);
    const name = tokens.slice(idx + 1).find((t) => t.toLowerCase() !== id && !/^\d+$/.test(t)) || id;
    const [lang, country = ""] = id.split("-");
    voices.push({ id, name, locale: `${lang}_${country.toUpperCase()}`, lang, country: country.toUpperCase(), gender: "" });
  }
  return voices;
}

async function fetchVoicesLinux() {
  for (const bin of ["espeak-ng", "espeak"]) {
    try {
      const { stdout } = await execFileAsync(bin, ["--voices"]);
      const voices = parseEspeakVoices(stdout);
      if (voices.length) return voices;
    } catch { /* try next backend */ }
  }
  return [];
}

function listPlatformVoices() {
  if (process.platform === "win32") return fetchVoicesWin();
  if (process.platform === "darwin") return fetchVoicesMac();
  return fetchVoicesLinux();
}

export async function fetchLocalDeviceVoices() {
  if (_voicesCache) return _voicesCache;
  try {
    const voices = await listPlatformVoices();
    _voicesCache = voices;
    return voices;
  } catch {
    return [];
  }
}

// `say` parses a leading "-" in an argv text as an option, and long texts hit the
// argv size limit, so the text always goes through stdin.
function execWithStdin(cmd, args, input) {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, (err) => (err ? reject(err) : resolve()));
    child.stdin.end(input);
  });
}

async function synthesizeMac(text, voiceId) {
  const dir = await mkdtemp(join(tmpdir(), "tts-"));
  const aiffPath = join(dir, "out.aiff");
  try {
    const args = voiceId ? ["-v", voiceId, "-f", "-", "-o", aiffPath] : ["-f", "-", "-o", aiffPath];
    await execWithStdin("say", args, text);
    try {
      await execFileAsync("ffmpeg", ["-y", "-i", aiffPath, "-codec:a", "libmp3lame", "-qscale:a", "4", join(dir, "out.mp3")]);
      return { base64: (await readFile(join(dir, "out.mp3"))).toString("base64"), format: "mp3" };
    } catch (err) {
      // ffmpeg is not a macOS built-in; afconvert is, so the absence of ffmpeg must
      // not take the whole provider down (a genuine ffmpeg failure still throws).
      if (err?.code !== "ENOENT") throw err;
      const wavPath = join(dir, "out.wav");
      await execFileAsync("afconvert", ["-f", "WAVE", "-d", "LEI16", aiffPath, wavPath]);
      return { base64: (await readFile(wavPath)).toString("base64"), format: "wav" };
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// The text is user-controlled: it goes to a temp file read by PowerShell, never
// spliced into a command line or an env var (env vars cap out around 32KB).
async function synthesizeWin(text, voiceId) {
  const dir = await mkdtemp(join(tmpdir(), "tts-"));
  const wavPath = join(dir, "out.wav");
  const textPath = join(dir, "in.txt");
  try {
    await writeFile(textPath, text, "utf8");
    const script = [
      "Add-Type -AssemblyName System.Speech;",
      "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;",
      "if ($env:TTS_VOICE) { try { $s.SelectVoice($env:TTS_VOICE) } catch {} }",
      "$s.SetOutputToWaveFile($env:TTS_OUT);",
      "$s.Speak((Get-Content -Raw -Encoding UTF8 -LiteralPath $env:TTS_IN));",
      "$s.Dispose()",
    ].join(" ");
    await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script],
      { windowsHide: true, env: { ...process.env, TTS_VOICE: voiceId || "", TTS_OUT: wavPath, TTS_IN: textPath } }
    );
    return { base64: (await readFile(wavPath)).toString("base64"), format: "wav" };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function synthesizeLinux(text, voiceId) {
  const dir = await mkdtemp(join(tmpdir(), "tts-"));
  const wavPath = join(dir, "out.wav");
  try {
    let lastError;
    for (const bin of ["espeak-ng", "espeak"]) {
      const args = voiceId ? ["-v", voiceId, "-w", wavPath, text] : ["-w", wavPath, text];
      try {
        await execFileAsync(bin, args);
        return { base64: (await readFile(wavPath)).toString("base64"), format: "wav" };
      } catch (err) {
        lastError = err;
      }
    }
    throw new Error(`No local TTS backend found (espeak-ng/espeak): ${lastError?.message}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Local engines render whole sentences (measured worst case with a voice/language
// mismatch: ~100KB of WAV per CJK char). The audio travels as one base64 string,
// so an unbounded prompt blows up memory — ~4000 chars crosses Node's max string
// length and the request dies with ERR_STRING_TOO_LONG instead of an answer.
const MAX_LOCAL_TEXT = 1000;

export default {
  noAuth: true,
  async synthesize(text, model) {
    if (text.length > MAX_LOCAL_TEXT) {
      throw new Error(`local-device TTS accepts at most ${MAX_LOCAL_TEXT} characters per request (got ${text.length}) — split the text or use a cloud provider`);
    }
    if (process.platform === "win32") return synthesizeWin(text, model);
    if (process.platform === "darwin") return synthesizeMac(text, model);
    return synthesizeLinux(text, model);
  },
};

/**
 * OpenCode Free over the official CLI (subprocess transport).
 *
 * Upstream now gates the zen free tier to real OpenCode clients, so the spoofed
 * HTTP handshake is rejected. This drives the installed `opencode` binary
 * instead — the sanctioned client path — and re-emits its `run --format json`
 * events as OpenAI SSE.
 */
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import os from "node:os";
import { DATA_DIR } from "@/lib/dataDir.js";
import { proxyAwareFetch, normalizeProxyUrl } from "../utils/proxyFetch.js";
import { getThinkingLevels } from "../providers/thinkingLevels.js";
import { HTTP_STATUS, MEMORY_CONFIG, OPENCODE_CLI_CONFIG } from "../config/runtimeConfig.js";

const WORKSPACE_DIR_NAME = "opencode-cli";
// The pinned workspace is static per process: re-creating the dir, sweeping
// attachments and re-reading the config on every turn would put 10+ sync syscalls
// on the request path for nothing. Self-healing stays inside this window.
const WORKSPACE_ENSURE_INTERVAL_MS = 60 * 1000;
let workspaceEnsuredAt = 0;
// The model id is client-controlled (this provider passes through any id) and becomes
// one argv token. Whitespace or a control character inside it survives into cmd.exe's
// line-based parser on the Windows path and truncates the whole command line.
const MODEL_ID_RE = /^[A-Za-z0-9._:/@[\]()-]+$/;
const CLI_PROVIDER_PREFIX = "opencode/";
// opencode resolves its default model at session start; a user's global config may
// point that default back at 9router, which would loop. Pin one of our own ids.
const WORKSPACE_DEFAULT_MODEL = "opencode/nemotron-3.5-lightning-free";
const CLI_URL = "opencode-cli://run";
// The prompt travels as a single argv string, so the platform per-argument ceiling
// binds before our own budget: Linux MAX_ARG_STRLEN is 128KB per argument and the
// CreateProcess command line caps at 32KB on Windows (E2BIG / silent truncation
// above those). macOS only limits the 1MB total, so the full budget fits.
const MAX_PROMPT_BYTES = Math.min(
  180 * 1024,
  process.platform === "win32" ? 30 * 1024 : process.platform === "linux" ? 120 * 1024 : 180 * 1024
);
const MAX_SESSIONS = 1000;
const ERROR_TYPE = "opencode_cli_error";
// Ceiling for the message an error frame carries: upstream can hand back a whole
// response body, and the string reaches the client, the request log and the dashboard.
const ERROR_MESSAGE_MAX = 600;
const ATTACHMENTS_DIR_NAME = "attachments";
// Only the newest MAX_ATTACHMENTS images of the turns actually being sent are
// attached; MAX_IMAGES_COLLECTED bounds collection so a long image-heavy history
// cannot balloon memory before that selection.
const MAX_ATTACHMENTS = 8;
const MAX_IMAGES_COLLECTED = 32;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const IMAGE_FETCH_TIMEOUT_MS = 15 * 1000;
const ATTACHMENT_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const IMAGE_EXTS = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "image/svg+xml": "svg",
};

function envFlag(name) {
  const raw = process.env[name];
  return raw == null ? "" : String(raw).trim().toLowerCase();
}

// ─── Windows spawn safety ────────────────────────────────────────────────────

// Modern Node refuses to spawn .cmd/.bat shims without a shell (EINVAL), and a
// bare command name can only be PATH-resolved through cmd.exe on Windows.
function needsShell(bin) {
  return process.platform === "win32" && (!!bin && (!bin.includes(path.sep) || /\.(cmd|bat)$/i.test(bin)));
}

// Node joins argv with plain spaces when shell:true and cmd.exe re-parses the
// result, so every argument must be quoted or a prompt containing & | < > "
// would break out of the command. "..." + doubled inner quotes is cmd's escape;
// "%" cannot be neutralized (expansion leaks env text into the prompt but cannot
// execute).
function cmdQuote(arg) {
  return `"${String(arg).replace(/"/g, '""')}"`;
}

function spawnArgs(bin, args) {
  return needsShell(bin) ? args.map(cmdQuote) : args;
}

// ─── Binary discovery / availability ─────────────────────────────────────────

function candidateBins() {
  const override = envFlag("CLI_OPENCODE_BIN");
  if (override) return [override];
  const home = os.homedir();
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    // npm's global prefix on Windows is %APPDATA%\npm (Roaming), not LocalAppData.
    const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
    return [
      path.join(home, ".opencode", "bin", "opencode.exe"),
      path.join(localAppData, "opencode", "bin", "opencode.exe"),
      path.join(appData, "npm", "opencode.cmd"),
      path.join(localAppData, "npm", "opencode.cmd"),
      path.join(home, ".bun", "bin", "opencode.exe"),
      "opencode.cmd",
    ];
  }
  return [
    path.join(home, ".opencode", "bin", "opencode"),
    path.join(home, ".local", "bin", "opencode"),
    path.join(home, ".bun", "bin", "opencode"),
    "/opt/homebrew/bin/opencode",
    "/usr/local/bin/opencode",
    "/usr/bin/opencode",
    "opencode",
  ];
}

export function resolveOpencodeBin() {
  const candidates = candidateBins();
  for (const candidate of candidates) {
    if (!candidate.includes(path.sep)) continue; // PATH-resolved fallback is last
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch { /* unreadable candidate — keep probing */ }
  }
  return candidates[candidates.length - 1];
}

function spawnVersionProbe(bin) {
  return new Promise((resolve) => {
    let settled = false;
    let child;
    const settle = (value) => { if (!settled) { settled = true; resolve(value); } };
    try {
      child = spawn(bin, spawnArgs(bin, ["--version"]), {
        stdio: ["ignore", "pipe", "ignore"],
        shell: needsShell(bin),
      });
    } catch { settle({ ok: false, major: null }); return; }
    let out = "";
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
      settle({ ok: false, major: null });
    }, OPENCODE_CLI_CONFIG.versionProbeMs);
    if (timer.unref) timer.unref();
    child.on("error", () => { clearTimeout(timer); settle({ ok: false, major: null }); });
    child.stdout.on("data", (chunkData) => { out = (out + chunkData.toString("utf8")).slice(0, 200); });
    child.on("close", (code) => { clearTimeout(timer); settle({ ok: code === 0, major: parseCliMajor(out) }); });
  });
}

// "opencode v2.0.29" and a bare "1.18.32" both reduce to the major, which is what
// decides the argv shape (2.x dropped --variant). null when unparseable, so the
// caller falls back to the flag form every probed 1.x build accepted.
function parseCliMajor(out) {
  const m = String(out || "").match(/(\d+)\s*\./);
  return m ? Number(m[1]) : null;
}

let availability = null; // { bin, ok, checkedAt, major }
let availabilityProbe = null; // in-flight dedupe: a TTL expiry must not fan out one probe per request

/**
 * Cached "is a usable opencode binary installed". Servers/Docker images without
 * the CLI keep the HTTP transport, so this gates the delegation in opencode.js.
 */
export async function isOpenCodeCliAvailable({ force = false } = {}) {
  const forced = envFlag("OPENCODE_TRANSPORT");
  if (forced === "http" || forced === "off") return false;
  if (forced === "cli" || forced === "on") {
    const bin = resolveOpencodeBin();
    // Forcing the transport skips the health verdict, not the version: 1.x and 2.x
    // take the thinking level differently, and guessing wrong fails every such turn.
    const major = availability?.bin === bin && availability.major != null
      ? availability.major
      : (await spawnVersionProbe(bin)).major;
    availability = { bin, ok: true, checkedAt: Date.now(), major };
    return true;
  }
  if (!force && availability && Date.now() - availability.checkedAt < OPENCODE_CLI_CONFIG.availabilityTtlMs) {
    return availability.ok;
  }
  if (!force && availabilityProbe) return availabilityProbe;
  availabilityProbe = (async () => {
    try {
      const bin = resolveOpencodeBin();
      const { ok, major } = await spawnVersionProbe(bin);
      availability = { bin, ok, checkedAt: Date.now(), major };
      return ok;
    } finally {
      availabilityProbe = null;
    }
  })();
  return availabilityProbe;
}

export function getCliInfo() {
  return { bin: availability?.bin || resolveOpencodeBin(), ok: availability?.ok ?? null, major: availability?.major ?? null };
}

// The child must egress through the same proxy the HTTP transport would use:
// upstream region-gates the zen free tier by source IP, and the server process
// is typically started WITHOUT proxy env, so `{ ...process.env }` alone sends the
// CLI out the server's own region-blocked IP. Mirror proxyAwareFetch precedence
// (connection proxy beats env) and its URL normalization (pools store raw
// "host:port" values, so they must be normalized before reaching the child).
export function buildCliEnv(proxyOptions) {
  const env = { ...process.env };
  const enabled = proxyOptions?.connectionProxyEnabled === true || proxyOptions?.enabled === true;
  const raw = enabled
    ? String(proxyOptions?.connectionProxyUrl ?? proxyOptions?.url ?? "").trim()
    : "";
  const url = normalizeProxyUrl(raw) || "";
  // Bun rejects non-http(s) proxy env (UnsupportedProxyProtocol) while undici's
  // ProxyAgent is http(s)-only too — a socks5:// pool value degrades to a direct
  // connection on the HTTP path, so mirror that instead of failing the child.
  if (!url || !/^https?:\/\//i.test(url)) return env;
  env.HTTPS_PROXY = url;
  env.HTTP_PROXY = url;
  env.ALL_PROXY = url;
  env.https_proxy = url;
  env.http_proxy = url;
  env.all_proxy = url;
  const noProxy = String(proxyOptions?.connectionNoProxy ?? proxyOptions?.noProxy ?? "").trim();
  if (noProxy) {
    env.NO_PROXY = noProxy;
    env.no_proxy = noProxy;
  }
  return env;
}

let freeModelsCache = null; // { ids: Set, at: number }
let freeModelsProbe = null; // in-flight dedupe: concurrent dashboard loads must not each spawn `opencode models`
let modelsProbeFailedAt = 0;
const MODELS_FAILURE_BACKOFF_MS = 60 * 1000;

/**
 * The CLI's own `opencode models opencode` listing is the ground truth for which
 * zen ids the free tier actually serves — the public /models endpoint also lists
 * ids the CLI refuses (mimo-v2.6-flash-free appeared there on 2026-09-22 while
 * the CLI omitted it). Returns null when no CLI is installed or the listing
 * fails, so callers fall back to suffix-only filtering.
 */
export async function listCliFreeModels({ ttlMs = OPENCODE_CLI_CONFIG.availabilityTtlMs } = {}) {
  if (freeModelsCache && Date.now() - freeModelsCache.at < ttlMs) {
    return freeModelsCache.ids;
  }
  // A broken/slow CLI must not stall every dashboard page open for the full
  // probe timeout — sit out a backoff window after a failure instead.
  if (Date.now() - modelsProbeFailedAt < MODELS_FAILURE_BACKOFF_MS) {
    return null;
  }
  // `opencode models` is a full CLI boot (~1s+); fan out at most one per cache window.
  if (freeModelsProbe) return freeModelsProbe;
  freeModelsProbe = (async () => {
    try {
      const ids = await spawnModelsListing(getCliInfo().bin);
      if (!ids) {
        modelsProbeFailedAt = Date.now();
        return null;
      }
      freeModelsCache = { ids, at: Date.now() };
      return ids;
    } finally {
      freeModelsProbe = null;
    }
  })();
  return freeModelsProbe;
}

function spawnModelsListing(bin) {
  return new Promise((resolve) => {
    let settled = false;
    let child;
    const settle = (value) => { if (!settled) { settled = true; resolve(value); } };
    try {
      // No positional provider filter: opencode 2.0.29 rejects it ("Unexpected
      // positional argument", exit 1), which cost the whole whitelist. The listing is
      // "<provider>/<id>" per line and only opencode/ ids are kept below, so asking
      // for everything and filtering here works on 1.x and 2.x alike.
      child = spawn(bin, spawnArgs(bin, ["models"]), {
        stdio: ["ignore", "pipe", "ignore"],
        shell: needsShell(bin),
      });
    } catch { settle(null); return; }
    let out = "";
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
      settle(null);
    }, OPENCODE_CLI_CONFIG.versionProbeMs);
    if (timer.unref) timer.unref();
    child.on("error", () => { clearTimeout(timer); settle(null); });
    child.stdout.on("data", (chunkData) => { out += chunkData.toString("utf8"); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return settle(null);
      const ids = new Set();
      for (const line of out.split("\n")) {
        // Strip every CSI sequence (colors, erase-line), not just color codes —
        // leftover "\x1b[0K" would make a model line unrecognizable and silently
        // drop that id from the whitelist.
        const clean = line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").trim();
        if (clean.startsWith(CLI_PROVIDER_PREFIX)) ids.add(clean.slice(CLI_PROVIDER_PREFIX.length));
      }
      settle(ids.size ? ids : null);
    });
  });
}

// ─── Image attachments ───────────────────────────────────────────────────────

// Vision input is bridged by materializing the image and handing it to
// `opencode run -f`, which attaches it to the message as a real media part.
function sweepStaleAttachments(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // no attachments yet
  }
  const cutoff = Date.now() - ATTACHMENT_MAX_AGE_MS;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const file = path.join(dir, entry.name);
    try {
      if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file);
    } catch { /* raced with another cleanup — harmless */ }
  }
}

async function materializeAttachments(images, workspaceDir, proxyOptions, log, signal) {
  if (!images?.length) return [];
  const dir = path.join(workspaceDir, ATTACHMENTS_DIR_NAME);
  fs.mkdirSync(dir, { recursive: true });
  // Parallel: serial fetches would stack up to 8 × 15s of dead time before the
  // CLI even spawns. map preserves order, so [image #N] markers stay aligned.
  const written = await Promise.all(images.map(async (image) => {
    if (signal?.aborted) return null;
    try {
      let bytes;
      let mime = image.mime || "";
      if (image.base64) {
        bytes = Buffer.from(image.base64, "base64");
      } else if (image.url) {
        const res = await proxyAwareFetch(image.url, {
          signal: AbortSignal.timeout(IMAGE_FETCH_TIMEOUT_MS),
        }, proxyOptions);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        mime = (res.headers.get("content-type") || "").split(";")[0] || mime;
        // Bail before buffering: a oversized remote image would otherwise be
        // downloaded whole and only then dropped by the byte cap.
        const declared = Number(res.headers.get("content-length") || 0);
        if (declared > MAX_IMAGE_BYTES) {
          log?.warn?.("OPENCODE", `image attachment declares ${declared}B > cap → skipped`);
          return null;
        }
        // Read with a cap: without content-length nothing bounded arrayBuffer().
        const reader = res.body?.getReader();
        if (!reader) return null;
        const parts = [];
        let total = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.length;
          if (total > MAX_IMAGE_BYTES) {
            await reader.cancel().catch(() => {});
            log?.warn?.("OPENCODE", "image attachment exceeds cap mid-stream → dropped");
            return null;
          }
          parts.push(Buffer.from(value));
        }
        bytes = Buffer.concat(parts);
      } else {
        return null;
      }
      if (!bytes?.length) return null;
      if (bytes.length > MAX_IMAGE_BYTES) {
        log?.warn?.("OPENCODE", `image attachment ${bytes.length}B exceeds cap → dropped`);
        return null;
      }
      const ext = IMAGE_EXTS[mime] || "png";
      // Unique per write: the attachments dir is shared across conversations (and
      // across 9router instances on one DATA_DIR), so a content-hash-only name would
      // let one request's cleanup unlink another's in-flight file.
      const hash = crypto.createHash("sha1").update(bytes).digest("hex").slice(0, 16);
      const file = path.join(dir, `${hash}-${crypto.randomUUID().slice(0, 8)}.${ext}`);
      fs.writeFileSync(file, bytes, { flag: "wx" });
      return file;
    } catch (e) {
      log?.warn?.("OPENCODE", `image attachment failed: ${e.message}`);
      return null;
    }
  }));
  return [...new Set(written.filter(Boolean))];
}

function removeAttachments(files) {
  for (const file of files) {
    try { fs.unlinkSync(file); } catch { /* already gone */ }
  }
}

// ─── Pinned workspace ────────────────────────────────────────────────────────

/**
 * opencode keys session storage by project directory, so every turn has to run in
 * the same dir. The config written here also denies all tool permissions:
 * `opencode run` defaults to the build agent, which would otherwise edit files and
 * run shell on the host serving 9router.
 */
export function ensureCliWorkspace() {
  const dir = path.join(DATA_DIR, WORKSPACE_DIR_NAME);
  const now = Date.now();
  if (workspaceEnsuredAt && now - workspaceEnsuredAt < WORKSPACE_ENSURE_INTERVAL_MS) return dir;
  fs.mkdirSync(dir, { recursive: true });
  sweepStaleAttachments(path.join(dir, ATTACHMENTS_DIR_NAME));
  const cfgPath = path.join(dir, "opencode.json");
  const wanted = JSON.stringify(
    { $schema: "https://opencode.ai/config.json", model: WORKSPACE_DEFAULT_MODEL, permission: "deny" },
    null,
    2
  );
  let current = null;
  try { current = fs.readFileSync(cfgPath, "utf8"); } catch { /* first run */ }
  if (current !== wanted) writeConfigAtomically(cfgPath, wanted);
  // Stamped only once the dir and config are really there: stamping first would make
  // a failed mkdir (read-only DATA_DIR, ENOSPC) skip the retry for a whole window and
  // hand every turn a cwd that does not exist.
  workspaceEnsuredAt = now;
  return dir;
}

// Dev and production instances share one DATA_DIR, so a plain writeFileSync can be
// read half-written by the other's CLI child (a torn config makes opencode fail the
// turn). Rename is atomic, and each writer gets its own temp file.
function writeConfigAtomically(cfgPath, wanted) {
  const tmp = `${cfgPath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(tmp, wanted);
    fs.renameSync(tmp, cfgPath);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
    throw e;
  }
}

// ─── Request body → prompt text ──────────────────────────────────────────────

function imageFromBlock(block) {
  // openai chat: {type:"image_url", image_url:{url}} · responses: {type:"input_image", image_url:"..."}
  // claude: {type:"image", source:{type:"base64"|"url", media_type, data|url}}
  const raw = block.image_url ?? (block.source ? block.source : null);
  if (!raw) return null;
  if (typeof raw === "string") return { url: raw };
  if (typeof raw !== "object") return null;
  if (raw.type === "base64" && typeof raw.data === "string") {
    return { base64: raw.data, mime: raw.media_type || "image/png" };
  }
  const candidate = raw.url || raw.data;
  if (typeof candidate !== "string") return null;
  if (candidate.startsWith("data:")) {
    const m = candidate.match(/^data:([^;,]+);base64,(.*)$/s);
    if (m) return { base64: m[2], mime: m[1] };
    return null;
  }
  if (/^https?:\/\//i.test(candidate)) return { url: candidate };
  return null;
}

// OpenAI chat shape carries tool calls at the message level (content often null);
// render them like the claude tool_use blocks so a tool result never appears in
// the replayed history without the assistant turn that requested it.
function renderToolCalls(toolCalls) {
  if (!Array.isArray(toolCalls)) return "";
  return toolCalls
    .filter((tc) => tc && typeof tc === "object")
    .map((tc) => {
      const args = tc.function?.arguments ?? tc.arguments ?? {};
      return `[assistant called tool ${tc.function?.name || tc.name || "?"} with ${typeof args === "string" ? args : JSON.stringify(args)}]`;
    })
    .join("\n");
}

function blockText(content, images, turnAt) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (!block) continue;
    if (typeof block === "string") { parts.push(block); continue; }
    switch (block.type) {
      case "text":
      case "input_text":
      case "output_text":
        parts.push(String(block.text || ""));
        break;
      case "tool_use":
        parts.push(`[assistant called tool ${block.name || "?"} with ${JSON.stringify(block.input ?? {})}]`);
        break;
      case "tool_result":
        parts.push(`[tool result: ${typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? "")}]`);
        break;
      case "image":
      case "image_url":
      case "input_image": {
        const image = imageFromBlock(block);
        if (image && images.length < MAX_IMAGES_COLLECTED) {
          images.push({ ...image, turn: turnAt });
          parts.push(`[image #${images.length}]`);
        } else {
          parts.push("[image omitted]");
        }
        break;
      }
      default: {
        // Gemini parts carry no `type`.
        if (typeof block.text === "string") parts.push(block.text);
        else if (block.inlineData) {
          const image = imageFromBlock({ source: { type: "base64", media_type: block.inlineData.mimeType, data: block.inlineData.data } });
          if (image && images.length < MAX_IMAGES_COLLECTED) {
            images.push({ ...image, turn: turnAt });
            parts.push(`[image #${images.length}]`);
          } else {
            parts.push("[image omitted]");
          }
        }
        break;
      }
    }
  }
  return parts.filter(Boolean).join("\n");
}

// A system block may arrive as a string, an array of blocks, or a Gemini
// {parts:[...]} wrapper.
function systemText(value, images) {
  if (value == null) return "";
  const source = Array.isArray(value) ? value : Array.isArray(value?.parts) ? value.parts : value;
  const rendered = blockText(source, images, 0);
  return rendered || (typeof source === "string" ? source : "");
}

/**
 * Flatten chat / claude / responses bodies into `{ system, turns }`. Every turn
 * keeps its original role so the session-prefix check below can align a client's
 * follow-up request with what we already delivered.
 */
export function normalizeConversation(body) {
  const b = body || {};
  const items = Array.isArray(b.messages) ? b.messages
    : Array.isArray(b.input) ? b.input
      : Array.isArray(b.contents) ? b.contents
        // The Responses API also accepts a bare string `input`; treat it as one user turn.
        : typeof b.input === "string" ? [{ role: "user", content: b.input }]
          : [];
  const systemParts = [];
  const turns = [];
  const images = [];
  const add = (role, text) => {
    const trimmed = String(text || "").trim();
    if (trimmed) turns.push({ role, text: trimmed });
  };

  for (const value of [b.system, b.instructions, b.systemInstruction]) {
    const rendered = systemText(value, images);
    if (rendered) systemParts.push(rendered);
  }
  const toolNames = new Map();
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    if (item.type === "reasoning" || item.type === "item_reference") continue;

    // Index this item's turn will take, so its images can be re-attached only when
    // that turn is actually part of the prompt being sent.
    const at = turns.length;
    if (item.role === "system") {
      const rendered = systemText(item.content, images);
      if (rendered) systemParts.push(rendered);
      continue;
    }
    if (item.type === "function_call") {
      add("assistant", `[assistant called tool ${item.name || "?"} with ${typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments ?? {})}]`);
      continue;
    }
    if (item.type === "function_call_output") {
      add("tool", `[tool result: ${typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? "")}]`);
      continue;
    }
    for (const tc of Array.isArray(item.tool_calls) ? item.tool_calls : []) {
      if (tc?.id) toolNames.set(tc.id, tc?.function?.name || tc?.name || "?");
    }
    if (Array.isArray(item.content)) {
      for (const block of item.content) {
        if (block?.type === "tool_use" && block.id) toolNames.set(block.id, block.name || "?");
      }
    }
    const itemBody = item.content ?? item.parts ?? item.text;
    if (item.role === "tool") {
      add("tool", `[tool result ${toolNames.get(item.tool_call_id) || item.name || "?"}: ${blockText(itemBody, images, at) || JSON.stringify(itemBody ?? "")}]`);
      continue;
    }
    const text = blockText(itemBody, images, at);
    const callText = renderToolCalls(item.tool_calls);
    add(item.role === "assistant" || item.role === "model" ? "assistant" : "user", callText ? (text ? `${text}\n${callText}` : callText) : text);
  }

  return { system: systemParts.filter(Boolean).join("\n\n"), turns, images };
}

function renderTurns(turns) {
  return turns.map((t) => `${t.role}: ${t.text}`).join("\n\n");
}

// An oversized transcript must never eat the caller's instructions or the question
// being asked, so bytes are allocated ask → system → history: the final message
// survives whole, a runaway system block gets tail-trimmed, and history is
// squeezed from its oldest end. Guarantees the result fits limitBytes.
function renderFirstPrompt(system, turns, limitBytes) {
  const headLabel = "Instructions for your reply:";
  const histLabel = "Conversation so far:";
  const askLabel = "Reply to this as the assistant, without describing what you would do:";
  const askText = turns[turns.length - 1]?.text || "...";
  const history = turns.length > 1 ? renderTurns(turns.slice(0, -1)) : "";
  // +8 covers the three label newlines and the two "\n\n" block joins exactly (7),
  // reserved even when a block is absent — the estimate never under-counts.
  let left = Math.max(1, limitBytes - Buffer.byteLength(headLabel + histLabel + askLabel) - 8);

  const keptAsk = fitTail(askText, left);
  left -= Buffer.byteLength(keptAsk);

  let head = "";
  if (system) {
    const keptSystem = fitTail(system, left);
    head = `${headLabel}\n${keptSystem}`;
    left -= Buffer.byteLength(keptSystem);
  }

  const keptHistory = fitOldestOut(history, left);
  return [head, keptHistory && `${histLabel}\n${keptHistory}`, `${askLabel}\n${keptAsk}`]
    .filter(Boolean)
    .join("\n\n");
}

// Keep the newest whole lines that fit the budget (a single oversized line is
// byte-trimmed from its front); linear, never re-measures the remaining text.
function fitOldestOut(text, budget) {
  if (!text || budget <= 0) return "";
  if (Buffer.byteLength(text) <= budget) return text;
  const lines = text.split("\n");
  let bytes = 0;
  let start = lines.length;
  while (start > 0) {
    const add = Buffer.byteLength(lines[start - 1]) + (start === lines.length ? 0 : 1);
    if (bytes + add > budget) break;
    bytes += add;
    start--;
  }
  return start < lines.length ? lines.slice(start).join("\n") : fitTail(text, budget);
}

function fitTail(text, limit) {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= limit) return text;
  let start = buf.length - limit;
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++; // never split a UTF-8 sequence
  return buf.subarray(start).toString("utf8");
}

// ─── Conversation → opencode session ─────────────────────────────────────────

/**
 * `reflected` = client turn entries already inside the opencode session, counting
 * the assistant reply we produced. A follow-up whose prefix still hashes to
 * `prefixHash` (entries before that reply) can therefore send only its new tail;
 * anything else (edited/branched history, changed system prompt) falls back to a
 * fresh session that replays the whole conversation.
 */
const sessions = new Map(); // key → { sid, reflected, prefixHash, systemHash, lastUsed }
const chains = new Map();   // key → tail of the per-conversation turn queue

const cleanup = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of sessions) {
    if (now - entry.lastUsed > MEMORY_CONFIG.sessionTtlMs) sessions.delete(key);
  }
}, MEMORY_CONFIG.sessionCleanupIntervalMs);
if (cleanup.unref) cleanup.unref();

function hashTurns(turns) {
  return crypto.createHash("sha256").update(JSON.stringify(turns.map((t) => [t.role, t.text]))).digest("hex").slice(0, 24);
}

function imageNote(attached, total) {
  // Say out loud which markers have no bytes behind them, otherwise the model
  // invents an answer for an image it never received.
  return `\n\nNote: only the last ${attached} of ${total} images are attached; earlier [image #N] references have no image data.`;
}

export function planPrompt({ key, system, turns, images = [] }) {
  const entry = sessions.get(key);
  const systemHash = crypto.createHash("sha256").update(system || "").digest("hex").slice(0, 16);
  if (entry?.sid && turns.length > entry.reflected && systemHash === entry.systemHash) {
    const boundary = entry.reflected - 1; // the reply we issued last turn
    if (turns[boundary]?.role === "assistant" && hashTurns(turns.slice(0, boundary)) === entry.prefixHash) {
      const tail = turns.slice(entry.reflected);
      // Images belonging to already-delivered turns live inside the opencode
      // session; re-sending them double-bills tokens and can crowd out the
      // attachment the user just added, so only the new tail's images travel.
      const tailImages = images.filter((image) => image.turn >= entry.reflected);
      const keptTail = tailImages.slice(-MAX_ATTACHMENTS);
      const note = keptTail.length < tailImages.length ? imageNote(keptTail.length, tailImages.length) : "";
      const prompt = fitOldestOut(renderTurns(tail), MAX_PROMPT_BYTES - Buffer.byteLength(note)) + note;
      if (prompt.trim()) {
        sessions.delete(key);
        entry.lastUsed = Date.now(); // the TTL sweeper must not evict an active conversation
        sessions.set(key, entry); // LRU touch so the cap evicts cold conversations first
        return {
          sid: entry.sid,
          prompt,
          systemHash,
          replayed: tail.length,
          images: keptTail,
        };
      }
    }
  }
  const kept = images.slice(-MAX_ATTACHMENTS);
  const note = kept.length < images.length ? imageNote(kept.length, images.length) : "";
  const prompt = renderFirstPrompt(system, turns, MAX_PROMPT_BYTES - Buffer.byteLength(note)) + note;
  return {
    sid: null,
    prompt,
    systemHash,
    replayed: turns.length,
    images: kept,
  };
}

// The downstream session seed is per-connection, so a connection running several
// parallel conversations would otherwise share (and thrash) one opencode session.
// The first user turn keeps them apart; an edited first message simply starts a
// fresh session, which the full-replay fallback already handles.
function sessionKey(credentials, providerSessionId, turns) {
  const identity = credentials?.connectionId || credentials?.id || "default";
  const anchor = turns?.length ? fingerprint(turns[0]) : "anon";
  return `${identity}:${providerSessionId || "anon"}:${anchor}`;
}

function fingerprint(turn) {
  return crypto.createHash("sha256").update(`${turn.role}\0${turn.text}`).digest("hex").slice(0, 16);
}

// Live-verified against opencode 1.19.0: continuing a session the CLI no longer
// knows about exits 1, prints nothing on stdout and writes "Error: Session not found"
// to stderr. The stored sid has to go on that failure — recordSession below refreshes
// `lastUsed` for every failed turn, so without the delete a conversation whose session
// aged out upstream keeps passing the dead `-s` and never recovers.
const SESSION_GONE_RE = /session not found/i;
// The CLI's session id is the only token this transport hands back to argv on the
// next turn (`-s`), so adopt it only when it is a safe single argv token (`ses_` +
// URL-safe characters). Anything else keeps the conversation on the full-replay path.
const SESSION_ID_RE = /^ses_[0-9A-Za-z_-]{1,128}$/;

function recordSession({ key, turns, sid, replyText, systemHash, error }) {
  if (error && SESSION_GONE_RE.test(String(error.message || ""))) {
    sessions.delete(key);
    return;
  }
  if (!sid) return;
  if (!replyText) {
    const existing = sessions.get(key);
    if (existing) existing.lastUsed = Date.now();
    return;
  }
  if (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
  // Re-insert: an overwrite keeps a Map's insertion position, which would make the
  // hottest conversation the first one the cap evicts.
  sessions.delete(key);
  sessions.set(key, {
    sid,
    reflected: turns.length + 1, // delivered turns + the reply we just made
    prefixHash: hashTurns(turns),
    systemHash,
    lastUsed: Date.now(),
  });
}

// One opencode session assumes sequential turns, so turns of the same conversation
// never overlap. Distinct conversations are distinct sessions and DO run concurrently
// in the shared project dir (verified with two parallel `opencode run`s on 1.19.0) —
// queueing them behind each other would make a single 5-minute turn stall every other
// chat on the connection, which is what clients that send no session header hit.
function enqueueTurn(key, task) {
  const prev = chains.get(key) || Promise.resolve();
  const run = prev.then(task, task);
  // A task that started a CLI turn carries `release`: the queue must keep the
  // conversation's next turn parked until that process settled, otherwise two turns
  // of one opencode session overlap (and the later finish() overwrites the session
  // record with the older sid, silently dropping the newer exchange from history).
  const guarded = run.then((out) => out?.release).catch(() => undefined);
  chains.set(key, guarded);
  guarded.then(() => { if (chains.get(key) === guarded) chains.delete(key); });
  // The caller gets its response as soon as it is built — streaming must not wait for
  // the turn to finish, only the NEXT turn of the same conversation does.
  return run.then((out) => out?.result ?? out);
}

// ─── CLI turn ────────────────────────────────────────────────────────────────

function splitThinkingSuffix(model) {
  const raw = String(model || "");
  const m = raw.match(/^(.*?)\(([^()]+)\)\s*$/);
  return { base: (m ? m[1] : raw).trim(), variant: m ? m[2].trim() : "" };
}

// opencode titles a session from the first user turn; leading dashes would be
// eaten as CLI flags, so flatten to one line and drop them. Cap by code points —
// a UTF-16-unit slice could split a surrogate pair and ship a lone surrogate,
// which execve encodes as U+FFFD in the title. NUL flattens to a space: execve
// rejects NUL bytes in argv outright.
export function sessionTitle(turns) {
  const first = (turns || []).find((t) => t?.role === "user")?.text || "";
  const flat = first.replace(/[\0\s]+/g, " ").replace(/^[-\s]+/, "").trim();
  return Array.from(flat).slice(0, 60).join("");
}

export function buildCliArgs({ model, body, sid, prompt, files, title, cliMajor = null }) {
  const { base, variant } = resolveVariant(model, body);
  // 2.x dropped --variant ("Unrecognized flag", exit 1, help dumped to stdout —
  // live-verified on 2.0.29) and takes the level inside the model id instead:
  // "provider/model#variant". An unprobed major keeps the flag every 1.x accepted.
  const foldsVariant = variant && cliMajor >= 2;
  const args = ["run", "--format", "json", "-m", `${CLI_PROVIDER_PREFIX}${base}${foldsVariant ? `#${variant}` : ""}`];
  if (variant && !foldsVariant) args.push("--variant", variant);
  // A fresh `run` otherwise spends an extra LLM call minting a session title;
  // supplying one skips it (verified: agent=title calls 1 → 0 per turn).
  if (title) args.push("--title", title);
  if (sid) args.push("-s", sid);
  for (const file of files || []) args.push("--file", file);
  // `--file` is an array option: without `--` it swallows the trailing prompt and
  // the CLI then fails with "File not found: <prompt>" (verified against 1.18.31).
  // prompt == null means it travels over stdin instead (see startTurn) — the
  // Windows cmd.exe shim path — so there is no positional argument to guard.
  if (prompt != null) args.push("--", prompt);
  return args;
}

// Declared levels come from the HTTP lane, and some free models accept a
// reasoning_effort there but have no variant route in the CLI's own table:
// `opencode run -m opencode/big-pickle#low` and the same for
// longcat-2.5-preview-free answer "Variant unavailable … [provider.no-route]"
// (live, 2026-10-18) while POST /inference/v1/chat/completions with
// reasoning_effort low returns 200 for both. space-bunny-free does have a
// variant route, so this is per model, not a free-tier rule. Forwarding the ask
// on this transport fails the whole turn, so it travels as no flag at all — the
// models still think by default (the plain big-pickle run reported reasoning
// tokens). Probe a new free id with `#low` before adding it here.
const CLI_VARIANTLESS_MODELS = new Set(["big-pickle", "longcat-2.5-preview-free"]);

// The CLI only accepts variants the model actually offers; forwarding an arbitrary
// reasoning_effort verbatim makes the whole request 400. Clamp to the model's
// declared thinking levels (mirrors the HTTP path's normalizeOpencodeReasoning)
// and drop the flag entirely for unsupported or "none"/"auto" values.
function resolveVariant(model, body) {
  const { base, variant } = splitThinkingSuffix(model);
  if (CLI_VARIANTLESS_MODELS.has(base)) return { base, variant: "" };
  const fromBody = typeof body?.reasoning_effort === "string" ? body.reasoning_effort
    : typeof body?.reasoning?.effort === "string" ? body.reasoning.effort
      : "";
  const requested = variant || fromBody;
  if (!requested || requested === "auto" || requested === "none") return { base, variant: "" };
  const levels = getThinkingLevels("opencode", base);
  const level = requested.toLowerCase().trim();
  if (levels?.includes(level)) return { base, variant: level };
  if (level === "max" || level === "ultra") {
    const clamped = ["xhigh", "high", "medium", "low"].find((l) => levels?.includes(l));
    if (clamped) return { base, variant: clamped };
  }
  return { base, variant: "" };
}

function errorFrame({ message, code, status } = {}) {
  const payload = {
    error: {
      // Bounded: an upstream message can carry a whole response body, and this string
      // reaches the client, the request log and the dashboard.
      message: String(message || "OpenCode CLI error").slice(0, ERROR_MESSAGE_MAX),
      type: ERROR_TYPE,
      ...(code ? { code: String(code) } : {}),
      // The SSE→JSON handlers read error.status to keep the real upstream code (a 403
      // free-tier gate must not be reported as a generic 502 to the account loop).
      ...(Number.isInteger(status) ? { status } : {}),
    },
  };
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function describeErrorEvent(evt) {
  const err = evt?.error || {};
  // 1.x nests the upstream detail under `error.data` (`name`, `responseBody`,
  // `statusCode`); 2.x flattens it onto `error` itself and renames the fields
  // (`type`, `response.body`, `status`) — live-captured on 2.0.29:
  //   {"type":"error","sessionID":"ses_…","error":{"type":"provider.auth",
  //    "message":"…free tier…","status":403,"response":{"body":"{\"type\":\"error\",
  //    \"error\":{\"type\":\"FreeTierError\",…}}"}}}
  const data = err.data || err;
  const name = String(err.name || err.type || data.name || data.type || "");
  const raw = data.message || err.message || name || "OpenCode CLI reported an error";
  // A bare "Unexpected server error. Check server logs for details." tells the caller
  // nothing (that is what a retired model id returns). The upstream envelope carries
  // the discriminating tokens: the parsed error type (FreeTierError / RegionError /
  // FreeUsageLimitError), else the CLI error name, plus its log ref.
  let upstreamType = "";
  const envelope = data.responseBody ?? data.response?.body;
  try { upstreamType = String(JSON.parse(envelope)?.error?.type || ""); } catch { /* not a JSON envelope */ }
  const clues = [upstreamType || (name && name !== raw ? name : ""), data.ref && `ref ${data.ref}`]
    .filter(Boolean)
    .join(", ");
  // The clue rides at the end and errorFrame caps the whole string, so a long upstream
  // message would otherwise truncate away the one part worth reading.
  const suffix = clues ? ` [${clues}]` : "";
  return {
    message: `${String(raw).slice(0, Math.max(0, ERROR_MESSAGE_MAX - suffix.length))}${suffix}`,
    status: Number(data.statusCode ?? data.status) || null,
  };
}

/**
 * One turn through the CLI. Shaped like BaseExecutor.execute() plus
 * `responseFormat:"openai"`, because the chunks we emit are OpenAI chat chunks —
 * chatCore must translate the response from OpenAI, not from the model's registry
 * targetFormat (which describes the HTTP endpoints this transport bypasses).
 */
export function runOpenCodeCli({ model, body, credentials, providerSessionId, signal, log, proxyOptions }) {
  const dir = ensureCliWorkspace();
  const cliInfo = getCliInfo();
  const bin = cliInfo.bin;
  // cmd.exe (the only way to run a bare name or a .cmd/.bat shim on Windows) parses
  // its command line one line at a time, so a multi-line prompt in argv — which every
  // real request is, since the rendered prompt joins labels and turns with newlines —
  // gets truncated/corrupted. opencode reads the message from stdin when it is not a
  // TTY (run.ts: `Bun.stdin.text()` → resolveRunInput), so the shell path pipes the
  // prompt instead. The direct-spawn path (.exe / mac / linux) keeps argv, which is
  // verified working and preserves newlines through CreateProcess/execve untouched.
  const useStdin = needsShell(bin);
  // Nothing below this line touches the queue: rejecting a malformed request must not
  // wait behind whichever turn is currently running.
  if (!MODEL_ID_RE.test(String(model || ""))) {
    return emptyResult(`OpenCode CLI: unsupported model id "${String(model || "").slice(0, 60)}"`, 400, "invalid_model");
  }
  const { system, turns, images } = normalizeConversation(body);
  if (!turns.length) return emptyResult("OpenCode CLI: request contained no text to send");
  const key = sessionKey(credentials, providerSessionId, turns);
  // One queue per conversation: an opencode session assumes sequential turns, while
  // two different conversations are two different sessions and may run side by side.
  return enqueueTurn(key, async () => {
    const plan = planPrompt({ key, system, turns, images });
    // NUL bytes make spawn throw ERR_INVALID_ARG_VALUE (execve forbids them in
    // argv); stripping at this single choke point keeps the argv, stdin, and
    // promptBytes views of the prompt identical.
    plan.prompt = plan.prompt.replace(/\0/g, "");
    if (signal?.aborted) return emptyResult("OpenCode CLI: aborted by client", 499);
    const attachments = await materializeAttachments(plan.images, dir, proxyOptions, log, signal);
    if (signal?.aborted) {
      removeAttachments(attachments);
      return emptyResult("OpenCode CLI: aborted by client", 499);
    }
    // A prompt-derived title would put user text back into argv, undoing the
    // cmd.exe path's deliberate stdin-only hardening, so skip it there; an
    // existing session already carries its title.
    const cliTitle = (plan.sid || useStdin) ? "" : sessionTitle(turns);
    const args = buildCliArgs({
      model,
      body,
      sid: plan.sid,
      prompt: useStdin ? null : plan.prompt,
      files: attachments,
      title: cliTitle,
      cliMajor: cliInfo.major,
    });
    log?.info?.("OPENCODE", `CLI ${plan.sid ? "continue" : "new"} session model=${model} key=${key.slice(0, 56)} turns=${plan.replayed} images=${attachments.length} prompt=${Buffer.byteLength(plan.prompt)}B via=${useStdin ? "stdin" : "argv"}`);
    const turn = startTurn({ bin, args, dir, key, plan, turns, model, signal, log, attachments, proxyOptions, stdinPrompt: useStdin ? plan.prompt : null });
    // Hold the response just long enough to learn whether the turn died before any
    // content. A 200 carrying an error frame is a success to combo.js (`result.ok`) and
    // writes no usage row (`saveUsageStats` skips 0/0), so a gated turn used to be both
    // invisible in the ledger and fatal to the caller's fallback chain.
    const failure = OPENCODE_CLI_CONFIG.peekMs > 0 ? await turn.peeked : null;
    if (failure) {
      // Let the child exit before handing back: the queue has no `release` to hold on
      // to once this task returns a plain result.
      await turn.settled;
      log?.warn?.("OPENCODE", `CLI failed before any output (${failure.status || failure.code || "?"}): ${String(failure.message).slice(0, 200)}`);
      return emptyResult(failure.message, Number(failure.status) || 502, failure.code || "cli_failed");
    }
    return { result: turn.response, release: turn.settled };
  });
}

function emptyResult(message, status = 400, code) {
  // A JSON body (not an SSE error frame): chatCore routes non-ok responses through
  // parseUpstreamError, which JSON-parses the body — an SSE frame would surface as
  // raw "data: {...}" text to the client.
  const payload = JSON.stringify({
    error: {
      message: String(message || "OpenCode CLI error").slice(0, ERROR_MESSAGE_MAX),
      type: ERROR_TYPE,
      code: code || (status === 499 ? "aborted" : "empty_prompt"),
      status,
    },
  });
  return Promise.resolve({
    response: new Response(payload, {
      status,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-cache" },
    }),
    url: CLI_URL,
    headers: {},
    responseFormat: "openai",
    transformedBody: { transport: "opencode-cli", error: message },
  });
}

function buildStream(write) {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      const emit = (text) => { try { controller.enqueue(enc.encode(text)); } catch { /* client gone */ } };
      const close = () => { try { controller.close(); } catch { /* already closed */ } };
      write(emit, close);
    },
  });
}

function jsonResponse(stream, status, extra = {}) {
  return Promise.resolve({
    response: new Response(stream, {
      status,
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
    }),
    url: CLI_URL,
    headers: {},
    responseFormat: "openai",
    ...extra,
  });
}

function startTurn({ bin, args, dir, key, plan, turns, model, signal, log, attachments = [], proxyOptions = null, stdinPrompt = null }) {
  const replyModel = splitThinkingSuffix(model).base; // the "(level)" suffix is ours, not a model id
  const responseId = `chatcmpl-opencode-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  const created = Math.floor(Date.now() / 1000);
  const state = { sid: plan.sid, reply: "", usage: null, roleSent: false, done: false };
  let killChild = () => {};
  // Resolved by finish() — the per-conversation queue waits on it (see enqueueTurn)
  // while the caller only ever awaits `response`. The ceiling is a safety valve: a
  // stream that errored before finish() ran would otherwise park this conversation
  // forever, and the CLI child keeps running.
  let settleTurn = () => {};
  const settled = new Promise((resolve) => { settleTurn = resolve; });
  const releaseCeiling = setTimeout(() => { killChild(); settleTurn(); }, OPENCODE_CLI_CONFIG.totalMs + OPENCODE_CLI_CONFIG.killGraceMs + 5000);
  if (releaseCeiling.unref) releaseCeiling.unref();

  // Resolved with the failure object when the turn's FIRST frame is an in-band error
  // (nothing has been streamed to the client yet, so an HTTP status can still be
  // chosen), or with null to mean "commit the 200 stream". The peekMs timer commits on
  // its own so a slow-but-healthy turn never waits on it.
  let settlePeek = () => {};
  const peeked = new Promise((resolve) => { settlePeek = resolve; });
  let peekSettled = false;
  const peek = (failure) => { if (!peekSettled) { peekSettled = true; settlePeek(failure || null); } };
  const peekTimer = OPENCODE_CLI_CONFIG.peekMs > 0 ? setTimeout(() => peek(null), OPENCODE_CLI_CONFIG.peekMs) : null;
  if (peekTimer?.unref) peekTimer.unref();

  const stream = buildStream((emit, close) => {
    let stderrTail = "";
    let strayOut = ""; // non-JSON stdout: a broken CLI reports plain text here
    // Declared up here: finish() runs on paths (early abort) that predate the spawn.
    let beatTimer = null;
    const chunk = (delta, finishReason = null, usage) => {
      const body = {
        id: responseId,
        object: "chat.completion.chunk",
        created,
        model: replyModel,
        choices: [{ index: 0, delta, logprobs: null, finish_reason: finishReason }],
      };
      if (usage) body.usage = usage;
      peek(null); // real content: the 200 is now committed either way
      emit(`data: ${JSON.stringify(body)}\n\n`);
    };
    const delta = (text) => {
      if (!state.roleSent) { chunk({ role: "assistant", content: "" }); state.roleSent = true; }
      chunk({ content: text });
    };
    const finish = ({ error = null, finishReason = "stop" } = {}) => {
      if (state.done) return;
      state.done = true;
      clearTimeout(totalTimer);
      clearTimeout(idleTimer);
      if (peekTimer) clearTimeout(peekTimer);
      if (signal) signal.removeEventListener("abort", onAbort);
      if (error) {
        // Nothing streamed yet → this failure can still become a real status, which is
        // what combo fallback and the ledger key on. A client hang-up is NOT such a
        // failure: chatCore already reports 499 through the stream path, and turning it
        // into a non-2xx here would file the caller's own abort as a provider error.
        if (!state.roleSent) peek(error.code === "aborted" ? null : error);
        emit(errorFrame({ message: error.message, code: error.code ?? error.status, status: error.status }));
      } else if (!state.reply.trim()) {
        // The CLI can exit 0 without any assistant text when upstream drops the
        // request — that is a failure, not an empty-but-successful reply.
        const detail = (stderrTail.trim() || strayOut.trim()).slice(0, 300);
        const empty = { message: `OpenCode CLI returned no assistant text${detail ? `: ${detail}` : ""}`, code: "empty_reply" };
        if (!state.roleSent) peek(empty);
        emit(errorFrame({ message: empty.message, code: "empty_reply" }));
      } else {
        if (!state.roleSent) chunk({ role: "assistant", content: "" });
        chunk({}, finishReason, state.usage || undefined);
        emit("data: [DONE]\n\n");
      }
      recordSession({ key, turns, sid: state.sid, replyText: error ? null : state.reply, systemHash: plan.systemHash, error });
      removeAttachments(attachments);
      clearTimeout(releaseCeiling);
      if (beatTimer) clearInterval(beatTimer);
      close();
      settleTurn();
    };

    // opencode `--format json` writes a `text` event only once a part completes, so
    // stdout stays silent for the entire generation. An inter-chunk idle timer would
    // abort legitimate slow/reasoning turns, so idleMs guards only the startup window
    // (spawn → first byte, normally step_start); the first output clears it for good
    // and totalMs becomes the sole ceiling.
    let idleTimer = setTimeout(() => {
      idleTimer = null;
      log?.warn?.("OPENCODE", `CLI produced no output within ${OPENCODE_CLI_CONFIG.idleMs}ms`);
      killChild();
      finish({ error: { message: `OpenCode CLI produced no output for ${Math.round(OPENCODE_CLI_CONFIG.idleMs / 1000)}s` } });
    }, OPENCODE_CLI_CONFIG.idleMs);
    if (idleTimer.unref) idleTimer.unref();
    const clearIdle = () => { if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; } };

    const totalTimer = setTimeout(() => {
      log?.warn?.("OPENCODE", `CLI exceeded ${Math.round(OPENCODE_CLI_CONFIG.totalMs / 1000)}s`);
      killChild();
      finish({ error: { message: "OpenCode CLI timed out" } });
    }, OPENCODE_CLI_CONFIG.totalMs);
    if (totalTimer.unref) totalTimer.unref();

    // 499 keeps a caller's own hang-up out of the provider-failure path: the account
    // loop and the request bookkeeping both branch on the status.
    const abortedError = { message: "Aborted by client", code: "aborted", status: HTTP_STATUS.CLIENT_CLOSED_REQUEST };
    const onAbort = () => { killChild(); finish({ error: abortedError }); };
    if (signal) {
      if (signal.aborted) { finish({ error: abortedError }); return; }
      signal.addEventListener("abort", onAbort, { once: true });
    }

    let child;
    try {
      child = spawn(bin, spawnArgs(bin, args), {
        cwd: dir,
        env: buildCliEnv(proxyOptions),
        // stdin is a pipe only when the prompt travels over it (Windows cmd.exe shim);
        // otherwise "ignore" → /dev/null, which gives opencode's unconditional
        // `Bun.stdin.text()` an immediate EOF so it never blocks waiting for input.
        stdio: [stdinPrompt != null ? "pipe" : "ignore", "pipe", "pipe"],
        // Bare names and .cmd shims can only run through cmd.exe on Windows
        // (args get cmd-quoted above); an absolute .exe path must NOT go through
        // cmd at all so the prompt's arbitrary text stays a plain argv string.
        shell: needsShell(bin),
      });
    } catch (e) {
      // Node's argument-validation errors embed the rejected argv value verbatim
      // (up to the whole prompt); keep the error frame bounded like every other
      // detail path here (300/600 chars).
      finish({ error: { message: `Failed to spawn opencode CLI: ${String(e?.message || e).slice(0, 300)}` } });
      return;
    }

    if (stdinPrompt != null) {
      // EPIPE here just means the CLI exited before draining stdin (bad model, broken
      // install); the close/error handlers already report that, so swallow it rather
      // than let an unhandled 'error' on the stdin stream take the process down.
      child.stdin.on("error", () => { /* child gone before it read the prompt */ });
      try { child.stdin.end(stdinPrompt); } catch { /* spawn already failing; handlers report */ }
    }

    const kill = () => {
      if (child.killed) return;
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
      const hard = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* ignore */ } }, OPENCODE_CLI_CONFIG.killGraceMs);
      if (hard.unref) hard.unref();
    };
    killChild = kill;

    // A batch turn keeps stdout silent until a part completes, so the client is left
    // staring at an idle SSE response. An SSE comment every heartbeatMs says "still
    // generating": spec-compliant clients ignore comment lines, stream.js drops them
    // in translate mode, and the SSE→JSON aggregators only read `data:` lines — so it
    // can never be mistaken for content, and it stops proxies timing the stream out.
    if (OPENCODE_CLI_CONFIG.heartbeatMs > 0) {
      beatTimer = setInterval(() => { if (!state.done) emit(": opencode is generating\n\n"); }, OPENCODE_CLI_CONFIG.heartbeatMs);
      if (beatTimer.unref) beatTimer.unref();
    }

    child.on("error", (err) => {
      const notFound = String(err?.message || "").includes("ENOENT");
      // Binary vanished since the probe (or the spawn shape is broken): drop the
      // cached verdict so the next request re-probes / falls back to HTTP.
      availability = null;
      finish({
        error: {
          message: notFound
            ? `opencode CLI not found (${bin}). Install OpenCode or set CLI_OPENCODE_BIN.`
            : `opencode CLI spawn failed: ${err?.message}`,
        },
      });
    });

    const onEvent = (line) => {
      let evt;
      try { evt = JSON.parse(line); } catch {
        strayOut = (strayOut + line + "\n").slice(-600);
        return; // banner / non-JSON noise
      }
      if (!evt || typeof evt !== "object") return;
      if (evt.type === "error") {
        const err = describeErrorEvent(evt);
        log?.warn?.("OPENCODE", `CLI error event: ${err.message}`);
        finish({ error: err });
        return;
      }
      // The CLI's reported session is authoritative: if -s was stale and it
      // started fresh, adopt the new id instead of re-recording the dead one.
      if (typeof evt.sessionID === "string" && SESSION_ID_RE.test(evt.sessionID)) state.sid = evt.sessionID;
      if (evt.type === "text") {
        // `opencode run --format json` emits a `text` event only once a part is
        // complete (part.time.end), so each event is a whole part — not an
        // incremental token delta. A reply split across parts (text, tool, text)
        // must keep its separators or the client sees the parts run together; mirror
        // opencode's own plain-text rendering, which breaks parts apart.
        const text = evt.part?.text;
        if (typeof text === "string" && text) {
          const sep = state.reply ? "\n\n" : "";
          state.reply += sep + text;
          delta(sep + text);
        }
        return;
      }
      if (evt.type === "step_finish" && evt.part?.tokens) {
        const t = evt.part.tokens;
        const input = t.input || 0;
        const output = (t.output || 0) + (t.reasoning || 0);
        // opencode splits cached tokens OUT of input (cache.read/cache.write);
        // they are still prompt-side context the model processed, so fold them
        // into prompt_tokens to stay comparable with the HTTP transport's usage.
        const cached = (t.cache?.read || 0) + (t.cache?.write || 0);
        state.usage = state.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
        state.usage.prompt_tokens += input + cached;
        state.usage.completion_tokens += output;
        state.usage.total_tokens += input + cached + output;
      }
    };

    // Decode as a stream, never per chunk: a pipe chunk boundary can land in the
    // middle of a multi-byte character (every CJK reply), and `chunk.toString("utf8")`
    // turns that half into U+FFFD — the line then fails JSON.parse and the whole text
    // part is lost to strayOut.
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    let buf = "";
    child.stdout.on("data", (chunkData) => {
      if (state.done) return; // trailing output after an error/abort: ignore
      clearIdle(); // first byte ends the startup-idle phase; generation is silent by design
      buf += stdoutDecoder.write(chunkData);
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) onEvent(line);
        if (state.done) return;
      }
    });
    child.stderr.on("data", (chunkData) => {
      stderrTail = (stderrTail + stderrDecoder.write(chunkData)).slice(-600);
    });
    child.on("close", (code) => {
      if (buf.trim()) onEvent(buf.trim());
      if (state.done) return;
      if (code !== 0 && !state.roleSent) {
        // The CLI process itself failed (broken install, missing binary): drop the
        // cached verdict so the next request re-probes and can fall back to the
        // HTTP transport instead of hitting the same broken binary for the TTL.
        availability = null;
        const detail = stderrTail.trim() || strayOut.trim();
        finish({ error: { message: `opencode CLI exited with code ${code}${detail ? `: ${detail.slice(0, 300)}` : ""}` } });
      } else {
        finish();
      }
    });
  });

  return {
    settled,
    peeked,
    response: jsonResponse(stream, 200, {
      transformedBody: {
        transport: "opencode-cli",
        model: replyModel,
        session: plan.sid || "new",
        turns: plan.replayed,
        promptBytes: Buffer.byteLength(plan.prompt),
      },
    }),
  };
}

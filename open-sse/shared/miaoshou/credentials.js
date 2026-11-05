// Read the 妙手 (CatPaw) desktop app's local Passport session.
//
// 妙手 is an Electron app (`com.catx.catpaw`, data dir ~/Library/Application
// Support/catpaw-moon on macOS). Its signed-in session is NOT in a cookie jar
// file: the renderer holds an AES-encrypted blob in `catx-credential.json`
// (`ssoTokenEnc`) and the main process passes the DECRYPTED X-Passport-Token to
// the agent CLI it spawns as `CATPAW_CONFIG_CONTENT` env. Reading that env from
// the running `catpaw-cli server` process is therefore the reliable path, and it
// matches what the app itself uses (verified 2026-11-05: the token taken from
// the process env answered /api/agent/models with the full catalog).
//
// Fallback for a running-but-idle app: `~/.meituan-catpaw/auth.json` holds the
// same token in plaintext under auth.accessToken — it is written by the CLI's
// bootstrap and was byte-identical to the process value on this machine.
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { normalizeSessionCookieHeader, extractCookieValue } from "../../utils/webCookieAuth.js";

const execFileAsync = promisify(execFile);

const CATPAW_API = "https://ai.catpaw.meituan.com";
const TOKEN_ENV = "CATPAW_CONFIG_CONTENT";
const TOKEN_COOKIE = "X-Passport-Token";

/**
 * THE canonical Passport-token parser — one copy shared by the executor, the
 * import route and webIdentity's probe (three hand-rolled variants drifted
 * before: the import route's regex could not read a cookie-editor JSON blob the
 * executor happily parses, so the same paste connected but failed at runtime).
 *
 * Accepts whatever shape the caller has: a credentials object
 * (apiKey/accessToken/cookie/providerSpecificData.cookie) whose value may be
 * the raw token, `X-Passport-Token=<token>`, a full `name=value; name=value`
 * Cookie header, or a cookie-editor JSON blob. Empty → no credential.
 */
export function extractMiaoshouToken(credentials) {
  const raw =
    credentials?.apiKey ||
    credentials?.accessToken ||
    credentials?.providerSpecificData?.cookie ||
    credentials?.cookie ||
    "";
  if (typeof raw !== "string" || !raw.trim()) return "";
  const normalized = normalizeSessionCookieHeader(raw, TOKEN_COOKIE);
  if (!normalized) return "";
  const fromJar = extractCookieValue(normalized, TOKEN_COOKIE);
  if (fromJar) return fromJar;
  // Bare token: normalizeSessionCookieHeader turns `abc` into `X-Passport-Token=abc`.
  return normalized.replace(new RegExp(`^${TOKEN_COOKIE}=`), "").trim();
}

function candidateAuthJsonPaths() {
  const home = homedir();
  return [
    join(home, ".meituan-catpaw", "auth.json"),
    // Enterprise/internal builds use a different data folder; keep the two
    // layouts the CLI is known to write.
    join(home, ".catpaw", "auth.json"),
    join(home, ".catdesk", "auth.json"),
  ];
}

/**
 * Pull the token out of one `ps eww` line. The env value is a JSON object that
 * may contain spaces, so it is decoded with a real JSON parser from the marker
 * to the first balanced object rather than by splitting on whitespace.
 */
export function tokenFromProcessEnv(text) {
  const marker = `${TOKEN_ENV}=`;
  const at = String(text || "").indexOf(marker);
  if (at === -1) return "";
  const json = String(text).slice(at + marker.length);
  let depth = 0;
  let inString = false;
  let escaped = false;
  let end = -1;
  for (let i = 0; i < json.length; i += 1) {
    const ch = json[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  if (end === -1) return "";
  try {
    const config = JSON.parse(json.slice(0, end));
    const token = config?.authTokens?.["x-passport-token"] || config?.cookie?.match(/X-Passport-Token=([^;]+)/)?.[1];
    return typeof token === "string" ? token.trim() : "";
  } catch {
    return "";
  }
}

async function listProcesses() {
  try {
    const { stdout } = await execFileAsync("ps", ["eww", "-ax"], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      timeout: 8000,
    });
    return stdout;
  } catch {
    return "";
  }
}

/** Token from a running 妙手 / catpaw-cli process, or "". */
export async function readTokenFromProcesses() {
  const text = await listProcesses();
  if (!text) return "";
  for (const line of text.split("\n")) {
    if (!line.includes(TOKEN_ENV)) continue;
    if (!/catpaw-cli|妙手|catpaw-moon/.test(line)) continue;
    const token = tokenFromProcessEnv(line);
    if (token) return token;
  }
  return "";
}

/** Token from the CLI's on-disk auth.json, or "". */
export async function readTokenFromAuthJson() {
  for (const file of candidateAuthJsonPaths()) {
    if (!existsSync(file)) continue;
    try {
      const parsed = JSON.parse(await readFile(file, "utf8"));
      const token = parsed?.auth?.accessToken;
      if (typeof token === "string" && token.trim()) return token.trim();
    } catch {
      /* try the next candidate */
    }
  }
  return "";
}

/**
 * Probe the token against the model catalog. The CLI's `m-appkey` header is
 * required — without it a VALID session answers an empty list.
 */
export async function probeCatpawToken(token) {
  if (!token) return { ok: false, error: "Missing X-Passport-Token" };
  try {
    const res = await fetch(`${CATPAW_API}/api/agent/models?mode=CATX_APP`, {
      headers: {
        Cookie: `${TOKEN_COOKIE}=${token}`,
        "m-appkey": "com.sankuai.mcopilot.cli",
        "x-agent-version": "1.2.0-beta.45",
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(12000),
    });
    const text = await res.text().catch(() => "");
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: "X-Passport-Token is invalid or expired" };
    }
    if (!res.ok) return { ok: false, error: `妙手 returned HTTP ${res.status}` };
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      return { ok: false, error: "妙手 returned invalid JSON" };
    }
    if (Number(json?.unifyCode) === 1003010001) {
      return { ok: false, error: "X-Passport-Token is invalid or expired" };
    }
    // Count only routable rows: the catalog also lists models with no
    // `modelType` (measured: MiniMax-M3.1-Flash), which this lane cannot call.
    const models = (Array.isArray(json?.data) ? json.data : []).filter(
      (m) => m?.modelType !== undefined && m?.modelType !== null && m?.modelType !== "",
    );
    if (!models.length) return { ok: false, error: "妙手 session is not signed in" };
    return { ok: true, models };
  } catch (error) {
    // A network failure says nothing about the credential: surface it as
    // inconclusive so the caller can decide (the import route still stores it).
    return { ok: false, inconclusive: true, error: error?.message || String(error) };
  }
}

/**
 * Detect + validate in one call.
 * @returns {Promise<{found: boolean, token?: string, source?: string, email?: string, models?: Array, error?: string, inconclusive?: boolean}>}
 */
export async function detectCatpawSession() {
  const sources = [
    { name: "process", read: readTokenFromProcesses },
    { name: "auth.json", read: readTokenFromAuthJson },
  ];
  let firstError = null;
  for (const source of sources) {
    const token = await source.read();
    if (!token) continue;
    const probe = await probeCatpawToken(token);
    if (probe.ok) return { found: true, token, source: source.name, models: probe.models };
    if (probe.inconclusive) return { found: false, inconclusive: true, error: probe.error };
    firstError = probe.error;
  }
  return {
    found: false,
    error:
      firstError ||
      "妙手 is not signed in on this machine (no running 妙手 process and no auth.json). Sign in to 妙手, or paste the X-Passport-Token manually.",
  };
}

export const __internal__ = { candidateAuthJsonPaths, TOKEN_ENV, TOKEN_COOKIE };

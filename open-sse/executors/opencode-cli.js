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
import os from "node:os";
import { DATA_DIR } from "@/lib/dataDir.js";
import { proxyAwareFetch, normalizeProxyUrl } from "../utils/proxyFetch.js";
import { getThinkingLevels } from "../providers/thinkingLevels.js";
import { MEMORY_CONFIG, OPENCODE_CLI_CONFIG } from "../config/runtimeConfig.js";

const WORKSPACE_DIR_NAME = "opencode-cli";
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
        stdio: ["ignore", "ignore", "ignore"],
        shell: needsShell(bin),
      });
    } catch { settle(false); return; }
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
      settle(false);
    }, OPENCODE_CLI_CONFIG.versionProbeMs);
    if (timer.unref) timer.unref();
    child.on("error", () => { clearTimeout(timer); settle(false); });
    child.on("close", (code) => { clearTimeout(timer); settle(code === 0); });
  });
}

let availability = null; // { bin, ok, checkedAt }
let availabilityProbe = null; // in-flight dedupe: a TTL expiry must not fan out one probe per request

/**
 * Cached "is a usable opencode binary installed". Servers/Docker images without
 * the CLI keep the HTTP transport, so this gates the delegation in opencode.js.
 */
export async function isOpenCodeCliAvailable({ force = false } = {}) {
  const forced = envFlag("OPENCODE_TRANSPORT");
  if (forced === "http" || forced === "off") return false;
  if (forced === "cli" || forced === "on") {
    availability = { bin: resolveOpencodeBin(), ok: true, checkedAt: Date.now() };
    return true;
  }
  if (!force && availability && Date.now() - availability.checkedAt < OPENCODE_CLI_CONFIG.availabilityTtlMs) {
    return availability.ok;
  }
  if (!force && availabilityProbe) return availabilityProbe;
  availabilityProbe = (async () => {
    try {
      const bin = resolveOpencodeBin();
      const ok = await spawnVersionProbe(bin);
      availability = { bin, ok, checkedAt: Date.now() };
      return ok;
    } finally {
      availabilityProbe = null;
    }
  })();
  return availabilityProbe;
}

export function getCliInfo() {
  return { bin: availability?.bin || resolveOpencodeBin(), ok: availability?.ok ?? null };
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
      child = spawn(bin, spawnArgs(bin, ["models", "opencode"]), {
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
  if (current !== wanted) fs.writeFileSync(cfgPath, wanted);
  return dir;
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

function recordSession({ key, turns, sid, replyText, systemHash }) {
  if (!sid) return;
  if (!replyText) {
    const existing = sessions.get(key);
    if (existing) existing.lastUsed = Date.now();
    return;
  }
  if (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
  sessions.set(key, {
    sid,
    reflected: turns.length + 1, // delivered turns + the reply we just made
    prefixHash: hashTurns(turns),
    systemHash,
    lastUsed: Date.now(),
  });
}

// opencode sessions assume sequential turns; never overlap them.
function enqueueTurn(key, task) {
  const prev = chains.get(key) || Promise.resolve();
  const run = prev.then(task, task);
  const guarded = run.catch(() => undefined);
  chains.set(key, guarded);
  guarded.then(() => { if (chains.get(key) === guarded) chains.delete(key); });
  return run;
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

export function buildCliArgs({ model, body, sid, prompt, files, title }) {
  const { base, variant } = resolveVariant(model, body);
  const args = ["run", "--format", "json", "-m", `${CLI_PROVIDER_PREFIX}${base}`];
  if (variant) args.push("--variant", variant);
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

// The CLI only accepts variants the model actually offers; forwarding an arbitrary
// reasoning_effort verbatim makes the whole request 400. Clamp to the model's
// declared thinking levels (mirrors the HTTP path's normalizeOpencodeReasoning)
// and drop the flag entirely for unsupported or "none"/"auto" values.
function resolveVariant(model, body) {
  const { base, variant } = splitThinkingSuffix(model);
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

function errorFrame(message, code) {
  const payload = {
    error: {
      message: String(message || "OpenCode CLI error"),
      type: ERROR_TYPE,
      ...(code ? { code: String(code) } : {}),
    },
  };
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function describeErrorEvent(evt) {
  const data = evt?.error?.data || evt?.error || {};
  return {
    message: data.message || evt?.error?.message || data.name || "OpenCode CLI reported an error",
    status: data.statusCode || data.status || null,
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
  const bin = getCliInfo().bin;
  // cmd.exe (the only way to run a bare name or a .cmd/.bat shim on Windows) parses
  // its command line one line at a time, so a multi-line prompt in argv — which every
  // real request is, since the rendered prompt joins labels and turns with newlines —
  // gets truncated/corrupted. opencode reads the message from stdin when it is not a
  // TTY (run.ts: `Bun.stdin.text()` → resolveRunInput), so the shell path pipes the
  // prompt instead. The direct-spawn path (.exe / mac / linux) keeps argv, which is
  // verified working and preserves newlines through CreateProcess/execve untouched.
  const useStdin = needsShell(bin);
  const identity = credentials?.connectionId || credentials?.id || "default";
  const queueKey = `${identity}:${providerSessionId || "anon"}`;
  return enqueueTurn(queueKey, async () => {
    const { system, turns, images } = normalizeConversation(body);
    if (!turns.length) return emptyResult("OpenCode CLI: request contained no text to send");
    const key = sessionKey(credentials, providerSessionId, turns);
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
    });
    log?.info?.("OPENCODE", `CLI ${plan.sid ? "continue" : "new"} session model=${model} key=${key.slice(0, 56)} turns=${plan.replayed} images=${attachments.length} prompt=${Buffer.byteLength(plan.prompt)}B via=${useStdin ? "stdin" : "argv"}`);
    return startTurn({ bin, args, dir, key, plan, turns, model, signal, log, attachments, proxyOptions, stdinPrompt: useStdin ? plan.prompt : null });
  });
}

function emptyResult(message, status = 400) {
  // A JSON body (not an SSE error frame): chatCore routes non-ok responses through
  // parseUpstreamError, which JSON-parses the body — an SSE frame would surface as
  // raw "data: {...}" text to the client.
  const payload = JSON.stringify({
    error: {
      message: String(message || "OpenCode CLI error"),
      type: ERROR_TYPE,
      code: status === 499 ? "aborted" : "empty_prompt",
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

  const stream = buildStream((emit, close) => {
    let stderrTail = "";
    let strayOut = ""; // non-JSON stdout: a broken CLI reports plain text here
    const chunk = (delta, finishReason = null, usage) => {
      const body = {
        id: responseId,
        object: "chat.completion.chunk",
        created,
        model: replyModel,
        choices: [{ index: 0, delta, logprobs: null, finish_reason: finishReason }],
      };
      if (usage) body.usage = usage;
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
      if (signal) signal.removeEventListener("abort", onAbort);
      if (error) {
        emit(errorFrame(error.message, error.status));
      } else if (!state.reply.trim()) {
        // The CLI can exit 0 without any assistant text when upstream drops the
        // request — that is a failure, not an empty-but-successful reply.
        const detail = (stderrTail.trim() || strayOut.trim()).slice(0, 300);
        emit(errorFrame(`OpenCode CLI returned no assistant text${detail ? `: ${detail}` : ""}`, "empty_reply"));
      } else {
        if (!state.roleSent) chunk({ role: "assistant", content: "" });
        chunk({}, finishReason, state.usage || undefined);
        emit("data: [DONE]\n\n");
      }
      recordSession({ key, turns, sid: state.sid, replyText: error ? null : state.reply, systemHash: plan.systemHash });
      removeAttachments(attachments);
      close();
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

    const onAbort = () => { killChild(); finish({ error: { message: "Aborted by client" } }); };
    if (signal) {
      if (signal.aborted) { finish({ error: { message: "Aborted by client" } }); return; }
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
      if (evt.sessionID) state.sid = String(evt.sessionID);
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

    let buf = "";
    child.stdout.on("data", (chunkData) => {
      if (state.done) return; // trailing output after an error/abort: ignore
      clearIdle(); // first byte ends the startup-idle phase; generation is silent by design
      buf += chunkData.toString("utf8");
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) onEvent(line);
        if (state.done) return;
      }
    });
    child.stderr.on("data", (chunkData) => {
      stderrTail = (stderrTail + chunkData.toString("utf8")).slice(-600);
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

  return jsonResponse(stream, 200, {
    transformedBody: {
      transport: "opencode-cli",
      model: replyModel,
      session: plan.sid || "new",
      turns: plan.replayed,
      promptBytes: Buffer.byteLength(plan.prompt),
    },
  });
}

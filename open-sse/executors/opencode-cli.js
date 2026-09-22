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
import { proxyAwareFetch } from "../utils/proxyFetch.js";
import { getThinkingLevels } from "../providers/thinkingLevels.js";
import { MEMORY_CONFIG, OPENCODE_CLI_CONFIG } from "../config/runtimeConfig.js";

const WORKSPACE_DIR_NAME = "opencode-cli";
const CLI_PROVIDER_PREFIX = "opencode/";
// opencode resolves its default model at session start; a user's global config may
// point that default back at 9router, which would loop. Pin one of our own ids.
const WORKSPACE_DEFAULT_MODEL = "opencode/nemotron-3.5-lightning-free";
const CLI_URL = "opencode-cli://run";
const MAX_PROMPT_BYTES = 180 * 1024;
const MAX_SESSIONS = 1000;
const ERROR_TYPE = "opencode_cli_error";
const ATTACHMENTS_DIR_NAME = "attachments";
const MAX_ATTACHMENTS = 8;
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

// ─── Binary discovery / availability ─────────────────────────────────────────

function candidateBins() {
  const override = envFlag("CLI_OPENCODE_BIN");
  if (override) return [override];
  const home = os.homedir();
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    return [
      path.join(localAppData, "opencode", "bin", "opencode.exe"),
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
      child = spawn(bin, ["--version"], {
        stdio: ["ignore", "ignore", "ignore"],
        shell: process.platform === "win32" && !bin.includes(path.sep),
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
  const bin = resolveOpencodeBin();
  const ok = await spawnVersionProbe(bin);
  availability = { bin, ok, checkedAt: Date.now() };
  return ok;
}

export function getCliInfo() {
  return { bin: availability?.bin || resolveOpencodeBin(), ok: availability?.ok ?? null };
}

let freeModelsCache = null; // { ids: Set, at: number }
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
  const ids = await spawnModelsListing(getCliInfo().bin);
  if (!ids) {
    modelsProbeFailedAt = Date.now();
    return null;
  }
  freeModelsCache = { ids, at: Date.now() };
  return ids;
}

function spawnModelsListing(bin) {
  return new Promise((resolve) => {
    let settled = false;
    let child;
    const settle = (value) => { if (!settled) { settled = true; resolve(value); } };
    try {
      child = spawn(bin, ["models", "opencode"], {
        stdio: ["ignore", "pipe", "ignore"],
        shell: process.platform === "win32" && !bin.includes(path.sep),
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
        const clean = line.replace(/\x1b\[[0-9;]*m/g, "").trim();
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

async function materializeAttachments(images, workspaceDir, proxyOptions, log) {
  if (!images?.length) return [];
  const dir = path.join(workspaceDir, ATTACHMENTS_DIR_NAME);
  fs.mkdirSync(dir, { recursive: true });
  const written = new Set();
  for (const image of images) {
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
          continue;
        }
        bytes = Buffer.from(await res.arrayBuffer());
      } else {
        continue;
      }
      if (!bytes?.length) continue;
      if (bytes.length > MAX_IMAGE_BYTES) {
        log?.warn?.("OPENCODE", `image attachment ${bytes.length}B exceeds cap → dropped`);
        continue;
      }
      const ext = IMAGE_EXTS[mime] || "png";
      // Unique per write: the attachments dir is shared across conversations (and
      // across 9router instances on one DATA_DIR), so a content-hash-only name would
      // let one request's cleanup unlink another's in-flight file.
      const hash = crypto.createHash("sha1").update(bytes).digest("hex").slice(0, 16);
      const file = path.join(dir, `${hash}-${crypto.randomUUID().slice(0, 8)}.${ext}`);
      fs.writeFileSync(file, bytes);
      written.add(file);
    } catch (e) {
      log?.warn?.("OPENCODE", `image attachment failed: ${e.message}`);
    }
  }
  return [...written];
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

function blockText(content, images) {
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
        if (image && images.length < MAX_ATTACHMENTS) {
          images.push(image);
          parts.push(`[image #${images.length}]`);
        } else {
          parts.push("[image omitted]");
        }
        break;
      }
      default:
        break; // thinking/redacted_thinking/etc. are not replayed as prompt text
    }
  }
  return parts.filter(Boolean).join("\n");
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
        : [];
  const systemParts = [];
  const turns = [];
  const images = [];
  const add = (role, text) => {
    const trimmed = String(text || "").trim();
    if (trimmed) turns.push({ role, text: trimmed });
  };

  if (b.system != null) systemParts.push(blockText(b.system, images) || String(b.system));
  const toolNames = new Map();
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    if (item.type === "reasoning" || item.type === "item_reference") continue;

    if (item.role === "system") { systemParts.push(blockText(item.content, images)); continue; }
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
    if (item.role === "tool") {
      add("tool", `[tool result ${toolNames.get(item.tool_call_id) || item.name || "?"}: ${blockText(item.content, images) || JSON.stringify(item.content ?? "")}]`);
      continue;
    }
    add(item.role === "assistant" ? "assistant" : "user", blockText(item.content ?? item.text, images));
  }

  return { system: systemParts.filter(Boolean).join("\n\n"), turns, images };
}

function renderTurns(turns) {
  return turns.map((t) => `${t.role}: ${t.text}`).join("\n\n");
}

function renderFirstPrompt(system, turns) {
  const blocks = [];
  if (system) blocks.push(`Instructions for your reply:\n${system}`);
  const history = turns.slice(0, -1);
  if (history.length) blocks.push(`Conversation so far:\n${renderTurns(history)}`);
  const last = turns[turns.length - 1];
  blocks.push(`Reply to this as the assistant, without describing what you would do:\n${last ? last.text : "..."}`);
  return blocks.join("\n\n");
}

function clampBytes(text, limit) {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= limit) return text;
  return buf.subarray(buf.length - limit).toString("utf8");
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

export function planPrompt({ key, system, turns }) {
  const entry = sessions.get(key);
  const systemHash = crypto.createHash("sha256").update(system || "").digest("hex").slice(0, 16);
  if (entry?.sid && turns.length > entry.reflected && systemHash === entry.systemHash) {
    const boundary = entry.reflected - 1; // the reply we issued last turn
    if (turns[boundary]?.role === "assistant" && hashTurns(turns.slice(0, boundary)) === entry.prefixHash) {
      const tail = turns.slice(entry.reflected);
      const prompt = clampBytes(renderTurns(tail), MAX_PROMPT_BYTES);
      if (prompt.trim()) {
        sessions.delete(key);
        sessions.set(key, entry); // LRU touch so the cap evicts cold conversations first
        return { sid: entry.sid, prompt, systemHash, replayed: tail.length };
      }
    }
  }
  return {
    sid: null,
    prompt: clampBytes(renderFirstPrompt(system, turns), MAX_PROMPT_BYTES),
    systemHash,
    replayed: turns.length,
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

function recordSession({ key, plan, turns, sid, replyText, systemHash }) {
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

export function buildCliArgs({ model, body, sid, prompt, files }) {
  const { base, variant } = resolveVariant(model, body);
  const args = ["run", "--format", "json", "-m", `${CLI_PROVIDER_PREFIX}${base}`];
  if (variant) args.push("--variant", variant);
  if (sid) args.push("-s", sid);
  for (const file of files || []) args.push("--file", file);
  // `--file` is an array option: without `--` it swallows the trailing prompt and
  // the CLI then fails with "File not found: <prompt>" (verified against 1.18.31).
  args.push("--", prompt);
  return args;
}

// The CLI only accepts variants the model actually offers; forwarding an arbitrary
// reasoning_effort verbatim makes the whole request 400. Clamp to the model's
// declared thinking levels (mirrors the HTTP path's normalizeOpencodeReasoning)
// and drop the flag entirely for unsupported or "none"/"auto" values.
function resolveVariant(model, body) {
  const { base, variant } = splitThinkingSuffix(model);
  const requested = variant || (typeof body?.reasoning_effort === "string" ? body.reasoning_effort : "");
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
  const identity = credentials?.connectionId || credentials?.id || "default";
  const queueKey = `${identity}:${providerSessionId || "anon"}`;
  return enqueueTurn(queueKey, async () => {
    const { system, turns, images } = normalizeConversation(body);
    if (!turns.length) return emptyResult("OpenCode CLI: request contained no text to send");
    const key = sessionKey(credentials, providerSessionId, turns);
    const plan = planPrompt({ key, system, turns });
    const attachments = await materializeAttachments(images, dir, proxyOptions, log);
    const args = buildCliArgs({ model, body, sid: plan.sid, prompt: plan.prompt, files: attachments });
    log?.info?.("OPENCODE", `CLI ${plan.sid ? "continue" : "new"} session model=${model} key=${key.slice(0, 56)} turns=${plan.replayed} images=${attachments.length} prompt=${Buffer.byteLength(plan.prompt)}B`);
    return startTurn({ bin, args, dir, key, plan, turns, model, signal, log, attachments });
  });
}

function emptyResult(message) {
  return jsonResponse(buildStream((emit, close) => { emit(errorFrame(message, "empty_prompt")); close(); }), 400, {
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

function startTurn({ bin, args, dir, key, plan, turns, model, signal, log, attachments = [] }) {
  const responseId = `chatcmpl-opencode-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  const state = { sid: plan.sid, reply: "", usage: null, roleSent: false, done: false };
  let killChild = () => {};

  const stream = buildStream((emit, close) => {
    let stderrTail = "";
    const chunk = (delta, finishReason = null, usage) => {
      const body = {
        id: responseId,
        object: "chat.completion.chunk",
        created,
        model: String(model || ""),
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
        const detail = stderrTail.trim() ? `: ${stderrTail.trim().slice(0, 300)}` : "";
        emit(errorFrame(`OpenCode CLI returned no assistant text${detail}`, "empty_reply"));
      } else {
        if (!state.roleSent) chunk({ role: "assistant", content: "" });
        chunk({}, finishReason, state.usage || undefined);
        emit("data: [DONE]\n\n");
      }
      recordSession({ key, plan, turns, sid: state.sid, replyText: error ? null : state.reply, systemHash: plan.systemHash });
      removeAttachments(attachments);
      close();
    };

    let idleTimer = null;
    const resetIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        log?.warn?.("OPENCODE", `CLI silent >${OPENCODE_CLI_CONFIG.idleMs}ms`);
        killChild();
        finish({ error: { message: `OpenCode CLI went silent for ${Math.round(OPENCODE_CLI_CONFIG.idleMs / 1000)}s` } });
      }, OPENCODE_CLI_CONFIG.idleMs);
      if (idleTimer.unref) idleTimer.unref();
    };

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
      child = spawn(bin, args, {
        cwd: dir,
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"],
        // A bare command name needs the shell on Windows; an absolute .exe path
        // must NOT go through cmd.exe — the prompt arg contains arbitrary client
        // text that cmd metacharacters would reinterpret.
        shell: process.platform === "win32" && !bin.includes(path.sep),
      });
    } catch (e) {
      finish({ error: { message: `Failed to spawn opencode CLI: ${e.message}` } });
      return;
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
      try { evt = JSON.parse(line); } catch { return; } // banner / non-JSON noise
      if (!evt || typeof evt !== "object") return;
      if (evt.type === "error") {
        const err = describeErrorEvent(evt);
        log?.warn?.("OPENCODE", `CLI error event: ${err.message}`);
        finish({ error: err });
        return;
      }
      if (evt.sessionID && !state.sid) state.sid = String(evt.sessionID);
      if (evt.type === "text") {
        const text = evt.part?.text;
        if (typeof text === "string" && text) {
          state.reply += (state.reply ? "\n\n" : "") + text;
          delta(text);
        }
        return;
      }
      if (evt.type === "step_finish" && evt.part?.tokens) {
        const t = evt.part.tokens;
        const input = t.input || 0;
        const output = (t.output || 0) + (t.reasoning || 0);
        state.usage = state.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
        // Cache reads stay inside prompt_tokens: they are still context the model
        // consumed, and reporting them separately would read as a zero-prompt turn.
        state.usage.prompt_tokens += input;
        state.usage.completion_tokens += output;
        state.usage.total_tokens += input + output;
      }
    };

    let buf = "";
    child.stdout.on("data", (chunkData) => {
      resetIdle();
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
        finish({ error: { message: `opencode CLI exited with code ${code}${stderrTail.trim() ? `: ${stderrTail.trim()}` : ""}` } });
      } else {
        finish();
      }
    });
    resetIdle();
  });

  return jsonResponse(stream, 200, {
    transformedBody: {
      transport: "opencode-cli",
      model: splitThinkingSuffix(model).base,
      session: plan.sid || "new",
      turns: plan.replayed,
      promptBytes: Buffer.byteLength(plan.prompt),
    },
  });
}

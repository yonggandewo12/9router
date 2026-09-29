// DevEcoExecutor — 华为 DevEco Code MaaS inference proxy.
//
// DevEco Code is a fork of opencode. Its gateway speaks plain OpenAI
// /chat/completions SSE, authenticated with a Bearer token from the HUAWEI ID
// OAuth loopback flow (see shared/deveco/auth.js).
//
// Two wire facts the generic path would miss (both live-verified 2026-09-29):
//  1. An invalid/expired token answers HTTP **200** with a JSON error body
//     (`errorCode:4016`), never 401 — chatCore's refresh-on-401 would never
//     fire, so failures get re-classified into real status codes here.
//  2. `Chat-Id` is mandatory and conversation-stable (the CLI reuses one id
//     across a session's turns, background title call included); a fresh id
//     per request reads as a new conversation.
import crypto from "node:crypto";
import { DefaultExecutor } from "./default.js";
import { HTTP_STATUS } from "../config/runtimeConfig.js";
import { withCredentialRefreshLock } from "../services/oauthCredentialManager.js";
import { refreshDevecoFromCredentials } from "../shared/deveco/auth.js";
import { getModelsByProviderId } from "../config/providerModels.js";
import { buildErrorBody } from "../utils/error.js";

const DEFAULT_MAX_TOKENS = 32000;
const MAX_TOKEN_KEYS = ["max_tokens", "max_completion_tokens", "max_output_tokens"];

// The gateway's auth-failure codes (observed: 4016 invalid accessToken) all
// mean "Bearer rejected" → 401 so chatCore refreshes and retries once.
const AUTH_ERROR_CODES = new Set(["4016", "4015", "4011", 4016, 4015, 4011]);

// DevEco's built-in models answer an over-window prompt with the SAME message
// they use for real capacity problems (HTTP 200 + in-band ModelServiceError
// "…currently overloaded"), which clients retry forever instead of compacting.
// Claude Code only triggers auto-compaction when error.message contains the
// literal substring "prompt is too long", so a refusal is relabelled that way —
// but ONLY when the wire body could not possibly fit the declared window, so a
// genuine overload still stays a retryable error. 4.5 bytes/token is above the
// 3.2–4.1 measured for real payloads here, i.e. deliberately conservative.
const OVERFLOW_BYTES_PER_TOKEN = 4.5;
const REFUSAL_SNIFF_MS = 3000; // refusals land in ~2s; real generation takes 28-46s
const OVERLOAD_SIGNATURE = "currently overloaded";

// Carries this turn's conversation id from execute() into buildHeaders, which
// BaseExecutor calls without it (same symbol-key trick codearts uses).
const CHAT_ID_FIELD = Symbol.for("deveco.chatId");

function bareModel(model) {
  const s = String(model || "");
  const i = s.indexOf("/");
  return i >= 0 ? s.slice(i + 1) : s;
}

// DevEco's Chat-Id is a 32-hex id the CLI mints once per session and echoes on
// every turn. Hash the conversation-stable providerSessionId into that shape.
function chatIdFor(providerSessionId) {
  if (!providerSessionId) return crypto.randomUUID().replace(/-/g, "");
  return crypto.createHash("sha256").update(String(providerSessionId)).digest("hex").slice(0, 32);
}

// Rebuild a Response after its body was drained for classification, keeping the
// rest of the executor result (url, headers, transformedBody) for caller logs.
function withBody(result, text, status) {
  const { response } = result;
  return {
    ...result,
    response: new Response(text, {
      status,
      statusText: response.statusText,
      headers: response.headers,
    }),
  };
}

// {"errorCode":4016,"errorMsg":"..."} — a token refusal wearing a 200 status.
function parseAuthRejection(text) {
  if (!text || !text.includes("errorCode")) return null;
  try {
    const json = JSON.parse(text);
    if (json.errorCode === undefined) return null;
    return AUTH_ERROR_CODES.has(json.errorCode) || /token|jwt|auth|login|realname/i.test(String(json.errorMsg || ""))
      ? json
      : null;
  } catch {
    return null;
  }
}

// Registry entry of a bare/devEco-prefixed model id; null when unknown.
function modelEntry(model) {
  const id = bareModel(model);
  return getModelsByProviderId("deveco").find((m) => m.id === id) || null;
}

// Could this body NOT possibly fit the model's declared window? Cheap first,
// exact second: UTF-8 bytes ≥ UTF-16 chars (so chars>threshold ⇒ overflow) and
// bytes ≤ 3×chars (so 3×chars≤threshold ⇒ it fits) — normal traffic is decided
// in O(1) with no full-body scan. Base64 image blobs are stripped before
// measuring: a few hundred KB of base64 is ~1k tokens, so counting them at
// text ratios would sniff (add 3s to) every vision turn and mislabel it.
function couldOverflow(result, args, threshold) {
  const bodyStr = result.bodyStr || JSON.stringify(result.transformedBody || args?.body || {});
  if (!bodyStr.includes(";base64,")) {
    if (bodyStr.length > threshold) return true;
    if (bodyStr.length * 3 <= threshold) return false;
    return Buffer.byteLength(bodyStr, "utf8") > threshold;
  }
  return Buffer.byteLength(bodyStr.replace(/;base64,[A-Za-z0-9+/=]+/g, ""), "utf8") > threshold;
}

/**
 * Read the stream head (≤8KB) until the first frame is complete and carries the
 * refusal signature, bounded by `ms`, and hand back the head text plus a
 * replayable Response so the caller never loses bytes. Refusals arrive in ~2s
 * (possibly split over several frames); a real turn's first frame takes far
 * longer, so the timeout expires and the stream passes through untouched.
 */
async function sniffStreamHead(response, ms) {
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  let timedOut = false;
  let timer = null;
  const deadline = new Promise((resolve) => { timer = setTimeout(() => resolve("timeout"), ms); });
  // The read that lost the timeout race is still pending: the stream will hand
  // the next chunk to IT, so replay must await that promise first — issuing a
  // fresh read here would silently drop one chunk.
  let pending = null;
  try {
    while (size < 8192) {
      pending = reader.read();
      const race = await Promise.race([pending, deadline]);
      if (race === "timeout") { timedOut = true; break; }
      pending = null;
      if (race.done) break;
      chunks.push(race.value);
      size += race.value.byteLength;
      // Stop as soon as a complete frame carries the refusal; a real turn's
      // first frames don't, so this only short-circuits the relabel path.
      if (Buffer.from(concat(chunks)).toString("utf8").includes(OVERLOAD_SIGNATURE)) break;
    }
  } catch { /* rejection lands in `pending` — the replay re-raises it */ }
  clearTimeout(timer);

  const head = chunks.length ? Buffer.from(concat(chunks)).toString("utf8") : "";
  const rest = new ReadableStream({
    async start(controller) {
      try {
        for (const c of chunks) controller.enqueue(c);
        let next = pending;
        for (;;) {
          const { done, value } = await (next || reader.read());
          next = null;
          if (done) break;
          controller.enqueue(value);
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) { reader.cancel(reason).catch(() => {}); },
  });
  const replayed = new Response(rest, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
  return { head, replayed, timedOut };
}

function concat(chunks) {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  return out;
}

export class DevEcoExecutor extends DefaultExecutor {
  constructor(provider = "deveco") {
    super(provider);
  }

  async execute(args) {
    const chatId = chatIdFor(args?.providerSessionId);
    const request = args ? { ...args, credentials: { ...(args.credentials || {}), [CHAT_ID_FIELD]: chatId } } : args;
    const result = await super.execute(request);
    const response = result?.response;
    if (!response || response.status !== 200) return result;

    const contentType = response.headers?.get?.("content-type") || "";

    // Auth rejections arrive as HTTP 200 + JSON error body; turn them into a
    // real 401 so the caller's refresh-and-retry path runs instead of handing
    // the client a "successful" empty stream.
    if (!contentType.includes("event-stream")) {
      const text = await response.clone().text().catch(() => "");
      const rejection = parseAuthRejection(text);
      if (rejection) {
        return withBody(result, JSON.stringify({ error: { type: "authentication_error", message: rejection.errorMsg || "DevEco token rejected — reconnect the account" } }), HTTP_STATUS.UNAUTHORIZED);
      }
      return result;
    }

    // Context-overflow relabelling: only sniff when the wire body could not
    // possibly fit the model's declared window, so normal traffic never pays.
    const entry = modelEntry(args?.model);
    if (!entry?.contextLength) return result;
    if (!couldOverflow(result, args, entry.contextLength * OVERFLOW_BYTES_PER_TOKEN)) return result;

    const { head, replayed, timedOut } = await sniffStreamHead(response, REFUSAL_SNIFF_MS);
    if (timedOut || !head.includes(OVERLOAD_SIGNATURE)) return { ...result, response: replayed };
    return {
      ...result,
      response: new Response(JSON.stringify(buildErrorBody(HTTP_STATUS.BAD_REQUEST,
        // Wording is load-bearing: quoting the upstream refusal ("…currently
        // overloaded") re-matches accountFallback's text rules on the way out,
        // which locks a healthy connection and remaps this 400 to a retryable
        // 503 — the exact behaviour this relabelling exists to prevent.
        `prompt is too long: DevEco built-in models cap the conversation at ${entry.contextLength} tokens and this request exceeds that window. Compact or shrink the context, or route this model to a larger-context provider.`)),
      { status: HTTP_STATUS.BAD_REQUEST, headers: { "Content-Type": "application/json" } }),
    };
  }

  transformRequest(model, body, stream, credentials) {
    const out = super.transformRequest(model, body, stream, credentials);
    if (!out || typeof out !== "object") return out;
    out.model = bareModel(out.model || model);
    // The MaaS endpoint hard-refuses stream:false — it answers HTTP 200 with an
    // in-band error frame ("Request failed…"). Registry forceStream only flips
    // the handler layer; the wire body has to be pinned here as well
    // (same repair opencode.js:412 makes for the Zen gate).
    out.stream = true;
    // Default max_tokens per the model's declared output ceiling (32000 on the
    // GLMs, 8192 on Qwen3_VL) — a flat 32000 overshoots the vision model.
    if (!MAX_TOKEN_KEYS.some((key) => out[key] != null)) out.max_tokens = modelEntry(out.model || model)?.maxOutputTokens || DEFAULT_MAX_TOKENS;
    // The gateway reads tool_choice as "must call a tool" even with no tools
    // declared — a bare tool_choice then comes back as the (misleading)
    // "service overloaded" 403-in-SSE instead of a param error. Drop it.
    if (out.tool_choice !== undefined && (!Array.isArray(out.tools) || out.tools.length === 0)) {
      delete out.tool_choice;
    }
    return out;
  }

  buildHeaders(credentials, stream = true, url, model, body) {
    void url; void model; void body;
    const accessToken = credentials?.accessToken || credentials?.providerSpecificData?.securityToken || "";
    const chatId = credentials?.[CHAT_ID_FIELD] || chatIdFor(null);
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
      "Chat-Id": chatId,
      lang: "en",
      ...(stream ? { Accept: "text/event-stream" } : {}),
    };
  }

  // BaseExecutor.parseError hands back the raw body text, which would nest this
  // executor's own JSON error envelope inside the client-facing message.
  parseError(response, bodyText) {
    if (bodyText) {
      try {
        const json = JSON.parse(bodyText);
        const message = json?.error?.message || json?.message;
        if (typeof message === "string" && message) return { status: response.status, message };
      } catch { /* not JSON — fall through to the generic parser */ }
    }
    return super.parseError(response, bodyText);
  }

  async refreshCredentials(credentials, log, proxyOptions = null) {
    const patch = await withCredentialRefreshLock(this.provider, credentials, () =>
      refreshDevecoFromCredentials(credentials, { log, proxyOptions: proxyOptions || credentials?.proxyOptions || null })
    );
    // chatCore Object.assign()s this over the live credentials; providerSpecificData
    // would be replaced wholesale — keep fields the refresh never returns.
    if (patch?.providerSpecificData) {
      patch.providerSpecificData = {
        ...(credentials?.providerSpecificData || {}),
        ...patch.providerSpecificData,
      };
    }
    return patch;
  }
}

export const __internal__ = { bareModel, chatIdFor, parseAuthRejection, sniffStreamHead, couldOverflow, AUTH_ERROR_CODES, DEFAULT_MAX_TOKENS };

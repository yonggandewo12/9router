// CodeArtsExecutor — 华为云码道 (codearts.huaweicloud.com) inference proxy.
//
// Chat is a plain OpenAI `/chat/completions` body, but the snap-access gateway
// accepts neither a bearer token nor an API key: every request must carry a
// Huawei `SDK-HMAC-SHA256` signature over the temporary AK/SK + security token
// minted by the DPoP login (see shared/codearts/auth.js).
//
// Signing happens in buildHeaders because BaseExecutor calls it with the final
// URL, the final transformed body and the credentials of *this* attempt — so the
// payload hash covers exactly the bytes that go on the wire, and a retry (or the
// post-401 refresh retry) is re-signed with the fresh token automatically.
import crypto from "node:crypto";
import { DefaultExecutor } from "./default.js";
import { HTTP_STATUS } from "../config/runtimeConfig.js";
import { withCredentialRefreshLock } from "../services/oauthCredentialManager.js";
import { signHuaweiRequest } from "../shared/codearts/signer.js";
import { isSessionCapExceeded, capRetryDelayMs, isModelQueued, queueRetryDelayMs, sendUntilAdmitted } from "../shared/codearts/sessionCap.js";
import { CODEARTS_USER_AGENT, refreshCodeartsFromCredentials } from "../shared/codearts/auth.js";

// The gateway treats max_tokens as mandatory-ish; this is what the CLI sends
// when the caller does not care (model ceiling is 131072 for every listed model).
const DEFAULT_MAX_TOKENS = 32000;
const MAX_TOKEN_KEYS = ["max_tokens", "max_completion_tokens", "max_output_tokens"];
// Risk-control hint the CLI attaches: last user prompt, flattened, 500 chars.
const USER_PROMPT_LIMIT = 500;
// The CLI reports these for every signed call; the gateway keys its quota/risk
// telemetry on them, so 9router identifies as the same client type.
const CLIENT_IDENTITY = {
  "x-ot-client-type": "CLI",
  "x-ot-client-version": "26.9.3",
  "x-ot-function": "agent-tui",
  "x-language": "zh-cn",
};

// `provider/model` refs reach executors; CodeArts ids never contain "/".
function bareModel(model) {
  const s = String(model || "");
  const i = s.indexOf("/");
  return i >= 0 ? s.slice(i + 1) : s;
}

function traceId() {
  return crypto.randomUUID().replace(/-/g, "");
}

// Carries this request's conversation id from execute() into buildHeaders, which
// BaseExecutor calls without it. Same symbol-key trick opencode.js uses.
const SESSION_FIELD = Symbol.for("codearts.sessionId");

// The CLI funnels its own background calls (title generation, summaries) into
// one shared session instead of opening a counted one per call. Requests that
// reach this executor outside a conversation (probes, /translator/send) are the
// 9router equivalent.
const SILENT_SESSION = "ses_silent";

/**
 * The gateway counts *concurrent sessions* keyed by `user-session-id` (3 for a
 * personal station), and captured CLI traffic reuses one id across every request
 * of a conversation — 150+ turns on a single `ses_…`. Minting a fresh id per
 * request therefore reads as a fresh session each turn and burns the whole
 * budget, which comes back as HTTP 400 `TM.00001041 并发会话数已达上限(3个)`.
 * 9router's providerSessionId is already conversation-stable (client session
 * header → first-assistant-text hash → connection), so hash it into the
 * `ses_<26hex>` shape the CLI uses.
 */
function sessionSlug(providerSessionId) {
  if (!providerSessionId) return null;
  return `ses_${crypto.createHash("sha256").update(String(providerSessionId)).digest("hex").slice(0, 26)}`;
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => (part?.type === "text" && typeof part.text === "string" ? part.text : "")).join("");
  }
  return "";
}

function lastUserPrompt(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role !== "user") continue;
    const text = textOf(msg.content).replace(/[\r\n\t]/g, " ");
    if (text.trim()) return text.slice(0, USER_PROMPT_LIMIT);
  }
  return "";
}

// Rebuild a Response after its body was drained for inspection, keeping the rest
// of the executor result (url, headers, transformedBody) for the caller's logs.
function withBody(result, text) {
  const { response } = result;
  return {
    ...result,
    response: new Response(text, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    }),
  };
}

// Both gateway refusals report themselves in the response only, and reading that
// body consumes the stream — so every refused 400/429 comes back replayable.
// `round` feeds the session-cap backoff; a queued turn waits out the gateway's own
// Retry-After instead.
async function classifyRejection(result, round) {
  const response = result?.response;
  const status = response?.status;
  if (status !== HTTP_STATUS.BAD_REQUEST && status !== HTTP_STATUS.RATE_LIMITED) {
    return { result };
  }
  const text = await response.text().catch(() => "");
  const replayed = withBody(result, text);
  if (isSessionCapExceeded(text)) return { retryInMs: capRetryDelayMs(round), result: replayed };
  if (status === HTTP_STATUS.RATE_LIMITED && isModelQueued(response)) {
    return { retryInMs: queueRetryDelayMs(response), result: replayed };
  }
  return { result: replayed };
}

export class CodeartsExecutor extends DefaultExecutor {
  constructor(provider = "codearts") {
    super(provider);
  }

  async execute(args) {
    const session = sessionSlug(args?.providerSessionId);
    const request = !session || !args ? args : { ...args, credentials: { ...(args.credentials || {}), [SESSION_FIELD]: session } };
    return sendUntilAdmitted({
      attempt: async (round) => classifyRejection(await super.execute(request), round),
      model: args?.model,
      signal: args?.signal,
      log: args?.log,
    });
  }

  transformRequest(model, body, stream, credentials) {
    const out = super.transformRequest(model, body, stream, credentials);
    if (!out || typeof out !== "object") return out;

    out.model = bareModel(out.model || model);
    // Streamed tool-call deltas are opt-in on this gateway.
    if (out.tool_stream === undefined) out.tool_stream = true;
    if (!MAX_TOKEN_KEYS.some((key) => out[key] != null)) out.max_tokens = DEFAULT_MAX_TOKENS;
    if (out.user_prompt === undefined) {
      const prompt = lastUserPrompt(body);
      if (prompt) out.user_prompt = prompt;
    }
    return out;
  }

  buildHeaders(credentials, stream = true, url, model, body) {
    const psd = credentials?.providerSpecificData || {};
    const securityToken = psd.securityToken || credentials?.accessToken || "";
    // Both session headers carry the conversation id on a primary CLI session;
    // only the trace/span ids are per call.
    const session = credentials?.[SESSION_FIELD] || SILENT_SESSION;
    // Everything here is signed AND sent; transport headers fetch adds later
    // (accept-encoding, content-length) stay unsigned, which the gateway
    // tolerates — it re-computes over the declared SignedHeaders list only.
    const headers = {
      "Content-Type": "application/json",
      ...CLIENT_IDENTITY,
      "x-ot-session-id": session,
      "x-ot-parent-session-id": "",
      "x-ot-trace-id": traceId(),
      "x-ot-span-id": traceId(),
      "x-snap-traceid": traceId(),
      "user-session-id": session,
      "User-Agent": CODEARTS_USER_AGENT,
      ...(stream ? { Accept: "text/event-stream" } : {}),
    };

    return signHuaweiRequest({
      accessKeyId: psd.accessKeyId,
      secretAccessKey: psd.secretAccessKey,
      securityToken,
      method: "POST",
      url,
      body: body == null ? null : JSON.stringify(body),
      headers,
    });
  }

  async refreshCredentials(credentials, log, proxyOptions = null) {
    // STS rotates the refresh token, so concurrent 401s on one connection must
    // not replay the same RT (the loser would come back invalid_grant and mark
    // healthy credentials dead — same lock codex/grok-cli use). chatCore passes
    // the request's proxyOptions; the credentials fallback covers other callers.
    const patch = await withCredentialRefreshLock(this.provider, credentials, () =>
      refreshCodeartsFromCredentials(credentials, { log, proxyOptions: proxyOptions || credentials?.proxyOptions || null })
    );
    // chatCore Object.assign()s this patch over the live credentials object, and
    // its providerSpecificData would wholesale replace the connection's — keep
    // fields the refresh never returns (proxy config, user ids, …).
    if (patch?.providerSpecificData) {
      patch.providerSpecificData = {
        ...(credentials?.providerSpecificData || {}),
        ...patch.providerSpecificData,
      };
    }
    return patch;
  }
}

export const __test__ = { bareModel, lastUserPrompt, DEFAULT_MAX_TOKENS };

export default CodeartsExecutor;

// JoyAgent (京东) executor.
//
// The upstream is a plain OpenAI Chat Completions endpoint, so DefaultExecutor
// keeps doing the request, the streaming and the param handling. Two things are
// ours: the credential is a Cookie header (never a Bearer token), and JD wraps
// its failures in envelopes an OpenAI client does not know.
import { DefaultExecutor } from "./default.js";
import { extractJoyagentCookie } from "../shared/joyagent/credentials.js";

/**
 * Turn a JD error body into a message that names the actual problem.
 *
 * Three shapes are seen (measured 2026-11-06):
 *   401 `{"code":"AUTHENTICATION_REQUIRED","message":"登录已失效，请重新登录"}`
 *   404 `{"code":"MODEL_NOT_FOUND","message":"Model does not exist or is unavailable for code=…"}`
 *   400 `{"error":{"code":400,"message":"模型服务调用失败","cause":"{\"error\":{\"message\":\"Bad Request: …\"}}"}}`
 *       — the real reason only lives in `cause`, which is itself JSON-as-string.
 * An unknown `model` with `stream:true` answers 500 with an EMPTY body, so
 * nothing more can be inferred there than the status.
 */
export function parseJoyagentError(status, bodyText) {
  let json = null;
  try {
    json = JSON.parse(bodyText);
  } catch {
    return { status, message: bodyText || `HTTP ${status}` };
  }
  if (!json || typeof json !== "object") return { status, message: bodyText || `HTTP ${status}` };

  if (status === 401 || status === 403 || json.code === "AUTHENTICATION_REQUIRED") {
    return {
      status,
      message: `JoyAgent session rejected (${json.message || json.code || `HTTP ${status}`}) — re-paste the Cookie header from a logged-in joyagent.jd.com tab`,
    };
  }

  const err = json.error && typeof json.error === "object" ? json.error : null;
  let inner = err?.cause;
  if (typeof inner === "string") {
    try {
      inner = JSON.parse(inner);
    } catch {
      /* keep the raw string */
    }
  }
  const innerMessage = (inner && typeof inner === "object" ? inner.error?.message || inner.message : "") || (typeof inner === "string" ? inner : "");
  if (innerMessage) return { status, message: innerMessage };
  if (json.message) return { status, message: json.message };
  return { status, message: bodyText || `HTTP ${status}` };
}

export class JoyagentExecutor extends DefaultExecutor {
  constructor(provider = "joyagent") {
    super(provider);
  }

  buildHeaders(credentials, stream = true, url, model, body = null) {
    const headers = super.buildHeaders(credentials, stream, url, model, body);
    // DefaultExecutor answers with `Authorization: Bearer <apiKey>`, and JD's
    // gateway reads that slot as a work token — a cookie jar put there 401s with
    // AUTHENTICATION_REQUIRED even while the same jar in Cookie works. Custom
    // per-connection headers cannot put it back: `authorization` and `cookie`
    // are both in BLOCKED_HEADERS (overrides/route.js:14).
    delete headers.Authorization;
    const cookie = extractJoyagentCookie(credentials);
    if (cookie) headers.Cookie = cookie;
    return headers;
  }

  parseError(response, bodyText) {
    return parseJoyagentError(response.status, bodyText);
  }
}

// Credential parsing + liveness probe for the JoyAgent (京东) web lane.
//
// The pasted value is a Cookie header, not a token: the session is carried by
// several JD cookies (`.jd.com` passport jar + `joyagent.jd.com` `ptKey` /
// `jwaAccessToken`). Measured on a live account (2026-11-06) which subsets
// actually authenticate:
//
//   full jar                                  → 200
//   ptKey=<jca_…> alone                       → 200  (7-day lifetime)
//   passport cookies only (no ptKey/jwa*)     → 200  (the gateway mints
//                                                   jwaAccessToken itself)
//   jwaAccessToken alone / thor alone / pin alone / thor+pin(+unick) → 401
//
// So the header is forwarded verbatim whenever it looks like one, and a bare
// value is treated as `ptKey` — the single cookie that is enough on its own.
import { normalizeSessionCookieHeader, extractCookieValue } from "../../utils/webCookieAuth.js";

export const JOYAGENT_BASE = "https://joyagent.jd.com";
export const JOYAGENT_API = `${JOYAGENT_BASE}/work/api/v1`;
export const JOYAGENT_CHAT_URL = `${JOYAGENT_API}/models/openai-u/v1/chat/completions`;
export const JOYAGENT_MODELS_URL = `${JOYAGENT_API}/models`;

// The catalog `code` is what the chat endpoint expects as `model`; the numeric
// `id` in the same row answers 404 MODEL_NOT_FOUND.
export const JOYAGENT_DEFAULT_COOKIE = "ptKey";

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/**
 * Normalize whatever was stored on the connection into a `Cookie` header.
 * Accepts a raw header, `Cookie: …`, a bare ptKey value, or a cookie-editor
 * JSON export — the same contract the other webCookie lanes keep.
 */
export function extractJoyagentCookie(credentials) {
  const raw =
    credentials?.apiKey ||
    credentials?.accessToken ||
    credentials?.providerSpecificData?.cookie ||
    credentials?.cookie ||
    "";
  if (typeof raw !== "string" || !raw.trim()) return "";
  return normalizeSessionCookieHeader(raw, JOYAGENT_DEFAULT_COOKIE);
}

/** The JD login name behind the session (`jd_…`), or "" when it cannot be read. */
export function joyagentAccountLabel(cookie) {
  // extractCookieValue() answers with the whole input when no `name=` pair is
  // found in a single-value string, which would label the account "ptKey=…".
  if (!cookie || !cookie.includes(";")) return "";
  return extractCookieValue(cookie, "pin") || extractCookieValue(cookie, "unick") || "";
}

/**
 * Liveness check: one catalog call answers everything the caller needs.
 * 200 + records ⇒ live session; 401/403 ⇒ dead cookie; anything else is not a
 * verdict about the credential, so it stays `inconclusive` and cannot flip a
 * healthy connection to "error" on a network blip.
 *
 * `signal` bounds the default fetch only — the webIdentity wrapper supplies its
 * own 15s ceiling and ignores this one, which is why the probe stays a single
 * request (a second serial call would double the worst case for no consumer).
 *
 * @returns {Promise<{ok: boolean, inconclusive?: boolean, models?: Array, account?: string, error?: string}>}
 */
export async function probeJoyagentCookie(cookie, { fetchImpl = fetch, signal } = {}) {
  if (!cookie) return { ok: false, error: "Missing JoyAgent cookie" };
  const headers = {
    Cookie: cookie,
    Accept: "application/json",
    "User-Agent": BROWSER_UA,
    Origin: JOYAGENT_BASE,
    Referer: `${JOYAGENT_BASE}/app/`,
  };
  try {
    const res = await fetchImpl(JOYAGENT_MODELS_URL, { headers, signal: signal || AbortSignal.timeout(15000) });
    // A wrapped fetch (the webIdentity probe routes through proxyAwareFetch)
    // reports a failed transport as status 0 plus the message.
    if (!res.status) return { ok: false, inconclusive: true, error: res.error || "JoyAgent request failed" };
    const text = await res.text().catch(() => "");
    if (res.status === 401 || res.status === 403) {
      let msg = "";
      try {
        msg = JSON.parse(text)?.message || "";
      } catch {
        /* non-JSON error page */
      }
      return { ok: false, error: msg || "JoyAgent session is invalid or expired" };
    }
    if (!res.ok) return { ok: false, inconclusive: true, error: `JoyAgent returned HTTP ${res.status}` };

    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      return { ok: false, inconclusive: true, error: "JoyAgent returned invalid JSON" };
    }
    // Business failures also arrive as HTTP 200 on some JD gateways.
    if (json && typeof json.code === "string") {
      return { ok: false, error: json.message || `JoyAgent rejected the session (${json.code})` };
    }
    const records = Array.isArray(json?.data?.records) ? json.data.records : [];
    if (!records.length) return { ok: false, error: "JoyAgent account has no models (not provisioned?)" };

    return {
      ok: true,
      account: joyagentAccountLabel(cookie),
      models: records.map((r) => ({
        id: r.code,
        name: r.displayName || r.name || r.code,
        contextLength: r.contextLength,
        maxOutputTokens: r.responseTokens,
      })),
    };
  } catch (error) {
    return { ok: false, inconclusive: true, error: error?.message || String(error) };
  }
}

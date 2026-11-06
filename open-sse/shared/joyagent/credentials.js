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
import { normalizeSessionCookieHeader } from "../../utils/webCookieAuth.js";

export const JOYAGENT_BASE = "https://joyagent.jd.com";
export const JOYAGENT_API = `${JOYAGENT_BASE}/work/api/v1`;
export const JOYAGENT_CHAT_URL = `${JOYAGENT_API}/models/openai-u/v1/chat/completions`;
// The probe endpoint: answers the account's own pin and mints jwaAccessToken.
// The model catalog at `${JOYAGENT_API}/models` is where the five registry ids
// came from, but nothing reads it at runtime — `model` must be the catalog
// `code` (the numeric `id` 24..28 answers 404 MODEL_NOT_FOUND) and those codes
// are pinned in the registry instead.
export const JOYAGENT_USERINFO_URL = `${JOYAGENT_API}/gateway/auth/userInfo`;

// The single cookie that authenticates on its own, so a bare pasted value is
// read as this rather than dropped.
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

/**
 * Liveness + identity check: one `gateway/auth/userInfo` call answers both.
 *
 * It is the better probe than the model catalog for two reasons measured
 * 2026-11-06: it returns the account's own `pin`, and it is the call that mints
 * `jwaAccessToken` in its Set-Cookie.
 *
 * Take the identity from this response rather than from the `pin` cookie: the
 * cookie carries a percent-encoded nick (`%E5%8B%87%E6%95%A2%E7%9A%84%E6%88%9112`
 * for an account whose name is 勇敢的我12) while userInfo answers the decoded
 * value, and this connection identity is what names the row and dedups a
 * re-login. It is not always an ASCII id — `jd_…` and a plain nick have both
 * been observed for real accounts — so nothing here may assume a shape.
 *
 * 200 + data.pin ⇒ live session; 401/403 ⇒ dead cookie; anything else is not a
 * verdict about the credential, so it stays `inconclusive` and cannot flip a
 * healthy connection to "error" on a network blip.
 *
 * `signal` bounds the default fetch only — the webIdentity wrapper supplies its
 * own 15s ceiling and ignores this one, which is why the probe stays a single
 * request (a second serial call would double the worst case for no consumer).
 *
 * @returns {Promise<{ok: boolean, inconclusive?: boolean, account?: string, displayName?: string, error?: string}>}
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
    const res = await fetchImpl(JOYAGENT_USERINFO_URL, { headers, signal: signal || AbortSignal.timeout(15000) });
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
    const data = json?.data;
    if (!data || typeof data.pin !== "string" || !data.pin) {
      // A live session always answers its pin; an unexpected shape says more
      // about the endpoint than about the credential.
      return { ok: false, inconclusive: true, error: "JoyAgent userInfo returned no account pin" };
    }
    return {
      ok: true,
      account: data.pin,
      displayName: typeof data.displayName === "string" ? data.displayName : "",
    };
  } catch (error) {
    return { ok: false, inconclusive: true, error: error?.message || String(error) };
  }
}

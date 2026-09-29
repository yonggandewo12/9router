// DevEco Code (华为 DevEco Code) authentication:
//   1. Browser → {base}/console/DevEcoIDE/apply?port=<loopback>&appid=1008&code=<state>
//   2. Loopback callback receives tempToken + siteId
//   3. GET {base}/authrouter/auth/api/temptoken/check?tempToken=…&site=CN&version=1.0.0&appid=1008
//      → jwtToken (3-segment JWT format)
//   4. GET {base}/authrouter/auth/api/jwToken/check  headers: {jwtToken}
//      → {status, userInfo: {accessToken, refreshToken, userId, name, nationalCode, realName}}
//   5. Token TTL ≈ 30 min; refresh: same endpoint + headers {refresh:"true", jwtToken}
import crypto from "node:crypto";
import { proxyAwareFetch } from "../../utils/proxyFetch.js";

export const DEVECO_BASE = "https://cn.devecostudio.huawei.com";
export const DEVECO_APP_ID = "1008";
export const DEVECO_VERSION = "1.0.0";
export const DEVECO_SITE = "CN";
export const DEVECO_TOKEN_TTL_MS = 1800000;

const AUTHORIZE_PATH = "console/DevEcoIDE/apply";
const TEMP_TOKEN_CHECK_PATH = "authrouter/auth/api/temptoken/check";
const JWT_TOKEN_CHECK_PATH = "authrouter/auth/api/jwToken/check";
const LOGOUT_PATH = "authrouter/auth/api/logout";

export function createLoginState() {
  return crypto.randomUUID().replace(/-/g, "");
}

export function buildAuthorizeUrl(port, state) {
  const params = new URLSearchParams({ port: String(port), appid: DEVECO_APP_ID, code: state });
  return `${DEVECO_BASE}/${AUTHORIZE_PATH}?${params}`;
}

async function getText(url, { headers = {}, params = {}, proxyOptions = null } = {}) {
  const u = new URL(url);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  // proxyAwareFetch takes proxyOptions as its THIRD argument (dispatcher objects
  // smuggled into the RequestInit are ignored → the connection proxy pool dies).
  const res = await proxyAwareFetch(u.toString(), { method: "GET", headers }, proxyOptions);
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    const err = new Error(`DevEco auth error ${res.status}: ${text.slice(0, 200)}`);
    err.authFailed = res.status >= 400 && res.status < 500;
    throw err;
  }
  return text;
}

async function getJson(url, opts = {}) {
  const text = await getText(url, opts);
  try {
    return JSON.parse(text);
  } catch {
    const err = new Error(`DevEco auth: non-JSON response (${text.slice(0, 80)})`);
    err.authFailed = true;
    throw err;
  }
}

/**
 * Exchange tempToken from the browser callback for a jwtToken.
 * The endpoint answers with the RAW JWT as the response body (CLI:
 * `o.data.trim()`, then requires 3 dot-separated segments) — not JSON.
 */
export async function exchangeTempToken(tempToken, { proxyOptions = null } = {}) {
  const text = (await getText(`${DEVECO_BASE}/${TEMP_TOKEN_CHECK_PATH}`, {
    params: { tempToken: tempToken.split("&")[0], site: DEVECO_SITE, version: DEVECO_VERSION, appid: DEVECO_APP_ID },
    proxyOptions,
  })).trim();
  // Tolerate a JSON envelope too, but the wire contract is the bare JWT.
  let jwt = text;
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(jwt)) {
    try {
      const json = JSON.parse(text);
      jwt = String(json.jwtToken || json.data?.jwtToken || json.token || "").trim();
    } catch { /* fall through to the format check */ }
  }
  if (jwt.split(".").length !== 3) {
    const err = new Error("DevEco: temptoken check returned no jwtToken in JWT form");
    err.authFailed = true;
    throw err;
  }
  return jwt;
}

/** Validate jwtToken and extract accessToken + userInfo. */
export async function checkJwtToken(jwtToken, { refresh = false, proxyOptions = null } = {}) {
  const headers = { jwtToken, refresh: refresh ? "true" : "false" };
  const data = await getJson(`${DEVECO_BASE}/${JWT_TOKEN_CHECK_PATH}`, { headers, proxyOptions });
  if (!data?.status) return null;
  const info = data.userInfo || data.data?.userInfo;
  if (!info?.accessToken) return null;
  return {
    userId: info.userId || "",
    userName: info.name || "",
    accessToken: info.accessToken,
    refreshToken: info.refreshToken || "",
    jwtToken,
    countryCode: (info.nationalCode || DEVECO_SITE).trim().toUpperCase(),
    isRealName: String(info.realName) === "true",
  };
}

/** Full post-callback exchange: tempToken → jwtToken → credentials. */
export async function exchangeCodeForCredentials(tempToken, { proxyOptions = null } = {}) {
  const jwtToken = await exchangeTempToken(tempToken, { proxyOptions });
  const creds = await checkJwtToken(jwtToken, { proxyOptions });
  if (!creds) throw new Error("DevEco: jwtToken check returned no access token");
  creds.expiresAt = Date.now() + DEVECO_TOKEN_TTL_MS;
  return creds;
}

/** Map credentials onto a 9router credential patch. */
export function toDevecoCredentialPatch(creds, extra = {}) {
  const expiresIn = Math.max(60, Math.floor((creds.expiresAt - Date.now()) / 1000));
  return {
    accessToken: creds.accessToken,
    refreshToken: creds.jwtToken || null,
    expiresIn,
    providerSpecificData: {
      authMethod: "oauth",
      jwtToken: creds.jwtToken || "",
      userId: creds.userId || extra.userId || "",
      userName: creds.userName || extra.userName || "",
      countryCode: creds.countryCode || "",
      isRealName: creds.isRealName ?? extra.isRealName ?? false,
      tokenExpiresAt: new Date(creds.expiresAt).toISOString(),
    },
  };
}

/** Refresh a stored DevEco connection. Returns credential patch or error. */
export async function refreshDevecoFromCredentials(credentials, { proxyOptions = null, log = null } = {}) {
  const psd = credentials?.providerSpecificData || {};
  const jwtToken = psd.jwtToken || credentials?.refreshToken || "";
  if (!jwtToken) {
    log?.warn?.("TOKEN_REFRESH", "DevEco: no jwtToken stored — reconnect required");
    return { error: "invalid_grant", message: "DevEco: jwtToken missing, please re-login" };
  }
  try {
    const creds = await checkJwtToken(jwtToken, { refresh: true, proxyOptions });
    if (!creds) {
      log?.warn?.("TOKEN_REFRESH", "DevEco refresh returned no access token");
      return { error: "invalid_grant", message: "DevEco: token revoked, please re-login" };
    }
    creds.expiresAt = Date.now() + DEVECO_TOKEN_TTL_MS;
    log?.info?.("TOKEN_REFRESH", `DevEco token renewed until ${new Date(creds.expiresAt).toISOString()}`);
    return toDevecoCredentialPatch(creds);
  } catch (error) {
    log?.error?.("TOKEN_REFRESH", `DevEco refresh failed: ${error.message}`);
    if (error.authFailed) return { error: "invalid_grant", message: error.message };
    return null;
  }
}

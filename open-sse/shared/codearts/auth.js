// CodeArts (华为云码道) login: browser OAuth + PKCE, a DPoP-bound token
// exchange, and the temporary Huawei AK/SK the snap-access gateway signs with.
//
// The chain, reconstructed from the official `codearts` CLI (v26.9.3) and
// verified against live traffic on 2026-09-20:
//   1. mint code_verifier(128 base64url chars) + ticket_id(64 hex) + an EC P-256
//      keypair
//   2. open {portal}/authorize?...&code_challenge=base64url(sha256(verifier))
//   3. loopback callback /oauth/callback?code=<32>
//   4. POST {sts}/v1/oauth2/tokens with a DPoP proof → temporary AK/SK +
//      security_token (~1h) + a long-lived refresh JWT
//   5. every later API call is signed with SDK-HMAC-SHA256 (see signer.js);
//      refresh needs the SAME DPoP private key, so it is persisted with the
//      credentials (the CLI stores it inside its own access blob for the
//      same reason).
import crypto from "node:crypto";
import { proxyAwareFetch } from "../../utils/proxyFetch.js";

export const CODEARTS_PORTAL_BASE = "https://codearts.huaweicloud.com/portal";
export const CODEARTS_STS_BASE = "https://sts.cn-north-4.myhuaweicloud.com";
export const CODEARTS_API_BASE = "https://snap-access.cn-north-4.myhuaweicloud.com";
export const CODEARTS_CLIENT_ID = "CodeArts_Tui";
export const CODEARTS_CALLBACK_PATH = "/oauth/callback";
export const CODEARTS_USER_AGENT = "codearts/26.9.3";
// STS endpoint is region-scoped; cn-north-4 is what the CLI hardcodes.
const TOKEN_PATH = "/v1/oauth2/tokens";
const FALLBACK_TTL_MS = 60 * 60 * 1000;

function b64urlJson(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

/** Anti-CSRF / pending-login id carried in the authorize URL. */
export function createTicketId() {
  return crypto.randomBytes(32).toString("hex");
}

/** EC P-256 keypair in JWK form (JWK is what gets persisted with the credentials). */
export function createDpopKeyPair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  return {
    privateKeyJwk: privateKey.export({ format: "jwk" }),
    publicKeyJwk: publicKey.export({ format: "jwk" }),
  };
}

/** RFC 9449 DPoP proof. `htu` must be the exact URL being called. */
export function buildDpopProof(keyPair, htm, htu, nowSec = Math.floor(Date.now() / 1000)) {
  if (!keyPair?.privateKeyJwk || !keyPair?.publicKeyJwk) {
    throw new Error("CodeArts DPoP key pair is missing; restart the login flow");
  }
  const header = {
    alg: "ES256",
    typ: "dpop+jwt",
    // Field order/whitelist matches the CLI's proof (WebCrypto jwk export).
    jwk: {
      crv: "P-256",
      ext: true,
      key_ops: ["verify"],
      kty: "EC",
      x: keyPair.publicKeyJwk.x,
      y: keyPair.publicKeyJwk.y,
    },
  };
  const payload = {
    htm: String(htm).toUpperCase(),
    htu,
    iat: nowSec,
    jti: crypto.randomBytes(16).toString("hex"),
  };
  const signingInput = `${b64urlJson(header)}.${b64urlJson(payload)}`;
  const key = crypto.createPrivateKey({ key: keyPair.privateKeyJwk, format: "jwk" });
  // WebCrypto's ECDSA-P256-SHA256 signature is raw r||s, i.e. ieee-p1363.
  const signature = crypto.sign("sha256", Buffer.from(signingInput), {
    key,
    dsaEncoding: "ieee-p1363",
  });
  return `${signingInput}.${signature.toString("base64url")}`;
}

export function buildAuthorizeUrl({ redirectUri, codeChallenge, ticketId, locale = "zh-cn", portalBase = CODEARTS_PORTAL_BASE }) {
  // The portal takes the loopback `port`, not a redirect_uri; the callback path
  // is fixed at /oauth/callback on its side.
  const { port } = new URL(redirectUri);
  const params = new URLSearchParams({
    locale,
    client_id: CODEARTS_CLIENT_ID,
    port,
    code_challenge: codeChallenge,
    // Literal spelling the portal expects — "S256" is rejected.
    code_challenge_method: "SHA-256",
    ticket_id: ticketId,
  });
  return `${portalBase.replace(/\/+$/, "")}/authorize?${params.toString()}`;
}

export function codeartsCallbackUrl(port, host = "127.0.0.1") {
  return `http://${host}:${port}${CODEARTS_CALLBACK_PATH}`;
}

/** STS answers 4xx for a consumed/revoked grant — never worth retrying. */
function tokenError(status, payload, text) {
  const err = new Error(
    payload?.error_description || payload?.error?.message || payload?.error
    || `CodeArts token request failed: HTTP ${status} ${(text || "").slice(0, 200)}`
  );
  err.status = status;
  if (status === 400 || status === 401 || status === 403) err.authFailed = true;
  return err;
}

async function postTokens(params, keyPair, { extraHeaders = null, proxyOptions = null, stsBase = CODEARTS_STS_BASE } = {}) {
  const url = `${stsBase.replace(/\/+$/, "")}${TOKEN_PATH}`;
  const res = await proxyAwareFetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      "User-Agent": CODEARTS_USER_AGENT,
      DPoP: buildDpopProof(keyPair, "POST", url),
      ...(extraHeaders || {}),
    },
    body: new URLSearchParams(params).toString(),
  }, proxyOptions);
  const text = await res.text().catch(() => "");
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = null; }
  if (!res.ok) throw tokenError(res.status, payload, text);
  return payload;
}

/** Flatten a credential payload into the fields 9router needs (null when incomplete). */
function toCredentials({ accessKeyId, secretAccessKey, securityToken, expiration, refreshToken, keyPair }) {
  if (!accessKeyId || !secretAccessKey) return null;
  const parsed = Date.parse(expiration || "");
  return {
    accessKeyId,
    secretAccessKey,
    securityToken: securityToken || "",
    expiresAt: Number.isFinite(parsed) ? parsed : Date.now() + FALLBACK_TTL_MS,
    refreshToken: refreshToken || null,
    dpopKeyPair: keyPair,
  };
}

/** Flatten the STS response into the fields 9router needs. */
export function normalizeTokenResponse(payload, keyPair) {
  const c = payload?.credentials || payload?.Credential || {};
  return toCredentials({
    accessKeyId: c.access_key_id || c.accessKeyId,
    secretAccessKey: c.secret_access_key || c.secretAccessKey,
    securityToken: c.security_token || c.securityToken,
    expiration: c.expiration,
    refreshToken: payload?.refresh_token || payload?.refreshToken,
    keyPair,
  });
}

export async function exchangeCodeForCredentials({ code, codeVerifier, redirectUri, keyPair, proxyOptions = null, stsBase = CODEARTS_STS_BASE }) {
  const payload = await postTokens({
    client_id: CODEARTS_CLIENT_ID,
    code,
    code_verifier: codeVerifier,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
  }, keyPair, { proxyOptions, stsBase });
  const creds = normalizeTokenResponse(payload, keyPair);
  if (!creds) {
    throw new Error("CodeArts token exchange returned no credentials " + JSON.stringify(payload?.error || payload?.error_description || Object.keys(payload || {})));
  }
  return creds;
}

// A portal that is already signed in answers the loopback callback with
// `secret` + `redirect` instead of a `code`: the ticket endpoint then hands over
// the same temporary AK/SK, unsigned, because the secret is the proof.
const TICKET_PATH = "/snap-manager/v1/login/ticket";
const TICKET_MAX_ATTEMPTS = 10;
const TICKET_POLL_INTERVAL_MS = 1000;

/** Flatten the ticket response (`{credential:{access,secret,securitytoken,expires_at}}`). */
export function normalizeTicketResponse(payload, keyPair) {
  const c = payload?.credential || payload?.credentials || {};
  return toCredentials({
    accessKeyId: c.access || c.access_key_id,
    secretAccessKey: c.secret || c.secret_access_key,
    securityToken: c.securitytoken || c.security_token,
    expiration: c.expires_at || c.expiration,
    // The ticket answer carries no refresh token — the CLI stores "" too, so
    // this login expires with the AK/SK and has to be redone.
    refreshToken: payload?.refresh_token,
    keyPair,
  });
}

/**
 * Poll the login ticket until the portal publishes the credentials.
 * @param {(ms: number) => Promise<void>} [sleep] injectable delay (tests)
 */
export async function exchangeSecretForCredentials({ ticketId, secret, keyPair = null, attempts = TICKET_MAX_ATTEMPTS, intervalMs = TICKET_POLL_INTERVAL_MS, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), proxyOptions = null, apiBase = CODEARTS_API_BASE } = {}) {
  if (!ticketId || !secret) throw new Error("CodeArts login secret needs its ticket_id");
  const url = `${apiBase.replace(/\/+$/, "")}${TICKET_PATH}?${new URLSearchParams({ ticket_id: ticketId, secret })}`;
  let lastStatus = 0;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    await sleep(intervalMs);
    const res = await proxyAwareFetch(url, {
      method: "GET",
      headers: { Accept: "application/json", "User-Agent": CODEARTS_USER_AGENT },
    }, proxyOptions).catch((error) => { lastStatus = 0; console.log(`[CodeArts] ticket poll ${attempt}/${attempts} failed: ${error?.message || error}`); return null; });
    if (!res) continue;
    lastStatus = res.status;
    if (!res.ok) {
      console.log(`[CodeArts] ticket poll ${attempt}/${attempts}: HTTP ${res.status}`);
      continue;
    }
    const text = await res.text().catch(() => "");
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch { payload = null; }
    const creds = normalizeTicketResponse(payload, keyPair);
    if (creds) return creds;
    console.log(`[CodeArts] ticket poll ${attempt}/${attempts}: no credentials in payload`);
  }
  throw new Error(`CodeArts login ticket never returned credentials (last HTTP ${lastStatus || "network error"})`);
}

/**
 * Refresh the temporary AK/SK.
 * @param {string} [accountId] the `current/user` JSON string captured at login;
 *   the CLI always sends it as `x-agent-user-account` (empty value tolerated).
 */
export async function refreshCodeartsCredentials({ refreshToken, accountId = "", keyPair, proxyOptions = null, stsBase = CODEARTS_STS_BASE }) {
  const payload = await postTokens({
    client_id: CODEARTS_CLIENT_ID,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  }, keyPair, {
    extraHeaders: { "x-agent-user-account": String(accountId || "") },
    proxyOptions,
    stsBase,
  });
  const creds = normalizeTokenResponse(payload, keyPair);
  if (!creds) throw new Error("CodeArts refresh returned no credentials");
  // STS omits the RT on rotation; keep the one we presented.
  if (!creds.refreshToken) creds.refreshToken = refreshToken;
  return creds;
}

/**
 * Map CodeArts credentials onto a 9router credential patch.
 * `accessToken` carries the security token so generic logging/refresh paths see
 * a token; the AK/SK the gateway actually needs live in providerSpecificData.
 */
export function toCodeartsCredentialPatch(creds, extra = {}) {
  const expiresIn = Math.max(60, Math.floor((creds.expiresAt - Date.now()) / 1000));
  return {
    accessToken: creds.securityToken,
    refreshToken: creds.refreshToken || null,
    expiresIn,
    providerSpecificData: {
      authMethod: "oauth",
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      securityToken: creds.securityToken,
      accountId: creds.accountId ?? extra.accountId ?? "",
      dpopKeyPair: creds.dpopKeyPair || extra.dpopKeyPair || null,
      tokenExpiresAt: new Date(creds.expiresAt).toISOString(),
      ...(extra.userId ? { userId: extra.userId } : {}),
      ...(extra.domainId ? { domainId: extra.domainId } : {}),
      ...(extra.userName ? { userName: extra.userName } : {}),
    },
  };
}

/** Read the persisted credential shape back into what refresh needs. */
export function credentialsFromStore(credentials) {
  const psd = credentials?.providerSpecificData || {};
  return {
    accessKeyId: psd.accessKeyId || "",
    secretAccessKey: psd.secretAccessKey || "",
    securityToken: psd.securityToken || credentials?.accessToken || "",
    refreshToken: credentials?.refreshToken || psd.refreshToken || "",
    accountId: psd.accountId || "",
    dpopKeyPair: psd.dpopKeyPair || null,
  };
}

/**
 * Refresh a stored CodeArts connection into a 9router credential patch.
 * Shared by the executor's 401 path and services/tokenRefresh.js REFRESH_HANDLERS.
 *
 * A 4xx means the refresh JWT itself was revoked (the CLI clears its auth store
 * on 401) — reported as `invalid_grant` so callers stop retrying. Network/5xx
 * returns null so the retry loop gets another shot.
 */
export async function refreshCodeartsFromCredentials(credentials, { proxyOptions = null, log = null } = {}) {
  const stored = credentialsFromStore(credentials);
  if (!stored.refreshToken) {
    log?.warn?.("TOKEN_REFRESH", "CodeArts: connection has no refresh token");
    return { error: "invalid_grant", message: "CodeArts refresh token missing — reconnect the account" };
  }
  if (!stored.dpopKeyPair?.privateKeyJwk) {
    log?.warn?.("TOKEN_REFRESH", "CodeArts: DPoP key pair was not persisted with the connection");
    return { error: "invalid_grant", message: "CodeArts DPoP key pair missing — reconnect the account" };
  }
  try {
    const creds = await refreshCodeartsCredentials({
      refreshToken: stored.refreshToken,
      accountId: stored.accountId,
      keyPair: stored.dpopKeyPair,
      proxyOptions,
    });
    // The account identity is stable across refreshes; STS never returns it.
    creds.accountId = stored.accountId;
    // The gateway only accepts calls signed with the temp AK/SK *and* its
    // security token — a credential set without one can never sign a request
    // that passes, so do not report success (an empty `accessToken` patch is
    // also falsy, which would make chatCore skip the post-refresh retry).
    if (!creds.securityToken) {
      log?.warn?.("TOKEN_REFRESH", "CodeArts refresh returned credentials without a security token");
      return null;
    }
    log?.info?.("TOKEN_REFRESH", `CodeArts AK/SK renewed until ${new Date(creds.expiresAt).toISOString()}`);
    return toCodeartsCredentialPatch(creds);
  } catch (error) {
    log?.error?.("TOKEN_REFRESH", `CodeArts refresh failed: ${error.message}`);
    if (error.authFailed) return { error: "invalid_grant", message: error.message };
    return null;
  }
}

export const __internal__ = {
  TOKEN_PATH, TICKET_PATH, TICKET_MAX_ATTEMPTS, TICKET_POLL_INTERVAL_MS,
  FALLBACK_TTL_MS, b64urlJson, tokenError, toCredentials,
};

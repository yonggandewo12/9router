// CodeArts control-plane calls (user identity, model catalog).
//
// Same signing as inference (see signer.js) — only the endpoints differ. These
// are the calls the dashboard needs before any chat happens, so they live apart
// from the executor and are reusable from Next.js API routes.
import { signHuaweiRequest } from "./signer.js";
import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { CODEARTS_API_BASE, CODEARTS_USER_AGENT, refreshCodeartsFromCredentials } from "./auth.js";
import { shouldRefreshCredentials, withCredentialRefreshLock } from "../../services/oauthCredentialManager.js";

// The published "CodeArts Agent" app whose model list the CLI reads.
export const CODEARTS_AGENT_ID = "a8bcb36232554267a5142361cc25a393";

const CATALOG_CACHE_TTL_MS = 10 * 60 * 1000;
// Keyed by the temporary access key id, which rotates hourly, so a stale entry
// can never outlive its own credentials — but the keys do pile up across logins.
const catalogCache = new Map();

function cacheCatalog(cacheKey, result) {
  const now = Date.now();
  for (const [key, entry] of catalogCache) {
    if (entry.expiresAt <= now) catalogCache.delete(key);
  }
  catalogCache.set(cacheKey, { expiresAt: now + CATALOG_CACHE_TTL_MS, result });
}

/** Pull the signing fields out of a 9router credential record. */
export function codeartsKeys(credentials) {
  const psd = credentials?.providerSpecificData || {};
  const accessKeyId = psd.accessKeyId || "";
  const secretAccessKey = psd.secretAccessKey || "";
  if (!accessKeyId || !secretAccessKey) {
    throw new Error("CodeArts connection is missing its temporary AK/SK — reconnect the account.");
  }
  return {
    accessKeyId,
    secretAccessKey,
    securityToken: psd.securityToken || credentials?.accessToken || "",
  };
}

/**
 * Sign and send one CodeArts request. `body` must be the exact string written
 * to the wire — the payload hash covers it.
 */
export async function codeartsSignedFetch({ credentials, method, url, body = null, headers = {}, proxyOptions = null }) {
  const keys = codeartsKeys(credentials);
  const signed = signHuaweiRequest({ ...keys, method, url, body, headers: { ...headers } });
  const options = { method, headers: signed };
  if (body != null) options.body = body;
  return proxyAwareFetch(url, options, proxyOptions);
}

async function signedJson({ credentials, method, url, body = null, headers = {}, proxyOptions = null }) {
  const res = await codeartsSignedFetch({ credentials, method, url, body, headers, proxyOptions });
  const text = await res.text().catch(() => "");
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) {
    const err = new Error(`CodeArts ${url} failed: HTTP ${res.status} ${(data?.error_msg || data?.message || text || "").slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

/**
 * GET /snap-manager/v1/current/user → `{user_id, domain_id, user_name, …}`.
 * The whole object is what refresh sends back as `x-agent-user-account`, so
 * callers store the JSON string, not just the ids.
 */
export async function fetchCodeartsCurrentUser(credentials, { proxyOptions = null, baseUrl = CODEARTS_API_BASE } = {}) {
  const url = `${baseUrl.replace(/\/+$/, "")}/snap-manager/v1/current/user`;
  return signedJson({
    credentials,
    method: "GET",
    url,
    headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": CODEARTS_USER_AGENT },
    proxyOptions,
  });
}

/** Map the agent-center catalog entry into a 9router model record. */
export function mapCodeartsModel(raw) {
  const params = raw?.model_parameters || {};
  // The gateway routes on `model_id` (case-sensitive); `model_name` is only the
  // display label and answers 404 "model is not registered" on chat calls.
  const id = params.model_id || raw?.model_name;
  if (!id) return null;
  const model = { id, name: raw.model_alias || raw.model_name || id };
  if (params.context_window > 0) model.contextLength = params.context_window;
  if (params.max_tokens > 0) model.maxOutputTokens = params.max_tokens;
  // supports_images is the only capability the catalog carries; thinking is
  // always on for every model there, so it is declared in the static table.
  if (params.supports_images === true) model.capabilities = { vision: true };
  return model;
}

/**
 * A CodeArts AK/SK is a temporary STS credential that rotates hourly, and the
 * dashboard reads this catalog long before any chat happens — so the stored
 * pair is routinely dead by the time we sign with it. Signing anyway costs an
 * HTTPS round trip that MUST be rejected, on every single /v1/models call, and
 * logs the failure each time: a connection that is only ever listed (never
 * chatted through) has no other path that would renew it. So renew here, and
 * back off when renewal itself cannot succeed (no refresh token, no DPoP pair,
 * revoked grant) instead of hammering the same dead grant.
 */
const REFRESH_BACKOFF_MS = 10 * 60 * 1000;
const refreshBackoff = new Map();

function mergeCodeartsCredentials(credentials, patch) {
  return {
    ...credentials,
    ...patch,
    providerSpecificData: {
      ...(credentials?.providerSpecificData || {}),
      ...(patch.providerSpecificData || {}),
    },
  };
}

/** @returns {Promise<{credentials: object, patch: object} | null>} null = do not retry now. */
async function refreshCodeartsForCatalog(credentials, { proxyOptions, log, reason }) {
  const ak = credentials?.providerSpecificData?.accessKeyId || "";
  const backoffUntil = refreshBackoff.get(ak);
  if (backoffUntil && backoffUntil > Date.now()) return null;

  let patch = null;
  try {
    patch = await withCredentialRefreshLock("codearts", credentials, () =>
      refreshCodeartsFromCredentials(credentials, { log, proxyOptions })
    );
  } catch (error) {
    log?.warn?.("CODEARTS_MODELS", `credential refresh threw (${reason}): ${error?.message || error}`);
    patch = null;
  }

  if (!patch || patch.error || !patch.providerSpecificData?.accessKeyId) {
    refreshBackoff.set(ak, Date.now() + REFRESH_BACKOFF_MS);
    log?.warn?.(
      "CODEARTS_MODELS",
      `cannot renew the temporary AK/SK (${reason}): ${patch?.message || patch?.error || "no credentials returned"} — reconnect the account`
    );
    return null;
  }
  refreshBackoff.delete(ak);
  return { credentials: mergeCodeartsCredentials(credentials, patch), patch };
}

/**
 * GET /v1/agent-center/agents/detail → the account's live model list.
 * @param {object} [options.onCredentialsRefreshed] persist a renewed AK/SK back
 *   to the connection store (same contract as resolveCopilotModels).
 * @returns {Promise<{models: Array<object>} | null>} null when the account has
 *   no catalog (never throws on an empty list — callers fall back to static).
 */
export async function resolveCodeartsModels(
  credentials,
  { proxyOptions = null, baseUrl = CODEARTS_API_BASE, forceRefresh = false, onCredentialsRefreshed = null, log = null } = {}
) {
  let creds = credentials;

  // Expired on arrival: renewing first is what keeps the listing off the 401
  // path entirely. Nothing to renew with → report "no live catalog" quietly and
  // let the caller serve the static list.
  if (shouldRefreshCredentials("codearts", credentials)) {
    const renewed = await refreshCodeartsForCatalog(credentials, { proxyOptions, log, reason: "expired" });
    if (!renewed) return null;
    creds = renewed.credentials;
    await persistRefreshedCredentials(renewed.patch, credentials, onCredentialsRefreshed, log);
  }

  const keys = codeartsKeys(creds);
  const cacheKey = `${baseUrl}|${keys.accessKeyId}`;
  const cached = catalogCache.get(cacheKey);
  if (!forceRefresh && cached && cached.expiresAt > Date.now()) return cached.result;

  const url = `${baseUrl.replace(/\/+$/, "")}/v1/agent-center/agents/detail?agent_id=${CODEARTS_AGENT_ID}`;
  const request = (credentialSet) => signedJson({
    credentials: credentialSet,
    method: "GET",
    url,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "Agent-Type": "AgentCenter",
      // The gateway 400s the whole control plane without it:
      // "Request-header: X-Language is validate failed".
      "x-language": "zh-cn",
      "User-Agent": CODEARTS_USER_AGENT,
    },
    proxyOptions,
  });

  let data;
  try {
    data = await request(creds);
  } catch (error) {
    // The credential can be stale without carrying a future expiry (rotated by
    // another process, revoked server-side): one renew + one replay, no more.
    const authRejected = error?.status === 401 || error?.status === 403;
    const renewed = authRejected
      ? await refreshCodeartsForCatalog(credentials, { proxyOptions, log, reason: `HTTP ${error.status}` })
      : null;
    if (!renewed) throw error;
    creds = renewed.credentials;
    await persistRefreshedCredentials(renewed.patch, credentials, onCredentialsRefreshed, log);
    data = await request(creds);
  }

  const rawModels = Array.isArray(data?.gpts?.models) ? data.gpts.models : [];
  const models = rawModels.map(mapCodeartsModel).filter(Boolean);
  const result = models.length ? { models, raw: rawModels } : null;
  cacheCatalog(cacheKey, result);
  return result;
}

async function persistRefreshedCredentials(patch, original, onCredentialsRefreshed, log) {
  if (typeof onCredentialsRefreshed !== "function") return;
  try {
    // `existingProviderSpecificData` is the store's own baseline — the fields a
    // refresh never returns (proxy config, user ids, …) ride along on it.
    await onCredentialsRefreshed({ ...patch, existingProviderSpecificData: original?.providerSpecificData || {} });
  } catch (error) {
    // The catalog is already served from the renewed credential; a store write
    // failure must not turn a good listing into an error.
    log?.warn?.("CODEARTS_MODELS", `could not persist the renewed AK/SK: ${error?.message || error}`);
  }
}

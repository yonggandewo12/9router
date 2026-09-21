// Trae Enterprise (TRAE 企业版) catalog helper.
//
// The enterprise model list is per-tenant (admin-added custom models included),
// so it is fetched live with the connection's Cloud-IDE-JWT instead of relying
// on the static registry fallback.
//
// Note on the console's "CLI 登录令牌" (trae-lt-...): it exchanges fine at
// ExchangeToken and can READ /api/remote/v1/*, but the remote-agent API refuses
// sessions minted from it (`995000 internal server error` on POST
// /chat_sessions, while a browser-OAuth token for the same user succeeds), and
// the console documents the token as CLI-login-only. Trae Enterprise therefore
// connects through the same browser OAuth device flow as consumer Trae.

import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { PROVIDERS, PROVIDER_OAUTH } from "../../config/providers.js";

const FETCH_TIMEOUT_MS = 20_000;
const CATALOG_TTL_MS = 60 * 60 * 1000;

// /v1/models is polled by the dashboard and by CLI agents on every session start,
// so the tenant catalog is cached (like zed/qoder) instead of refetched per call.
const catalogCache = new Map();
const catalogInflight = new Map();

export function traeEnterpriseConfig(providerId = "trae-enterprise") {
  const conf = PROVIDERS[providerId] || {};
  const oauth = PROVIDER_OAUTH[providerId] || {};
  const base = String(conf.baseUrl || "").replace(/\/$/, "");
  return {
    baseUrl: base,
    modelsUrl: oauth.modelsUrl || `${base}/models`,
    headers: conf.headers || {},
  };
}

/**
 * Live per-tenant model catalog: GET {base}/models →
 * { code:0, data:{ list:[{ function, models:[{ name, display_name, multimodal, features }] }] } }
 * Model `name` is what the chat API expects as model_name, so ids pass through verbatim.
 */
export async function resolveTraeEnterpriseModels(credentials, options = {}) {
  const accessToken = credentials?.accessToken;
  if (!accessToken) return null;

  const key = String(accessToken).slice(-16);
  if (!options.forceRefresh) {
    const cached = catalogCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.result;
    const pending = catalogInflight.get(key);
    if (pending) return pending;
  }

  const promise = fetchCatalog(accessToken)
    .then((result) => {
      if (result) {
        // Keys are the last chars of a rotating 14-day token, so every re-login
        // adds an entry — prune the expired ones on each write.
        const now = Date.now();
        for (const [stale, entry] of catalogCache) {
          if (entry.expiresAt <= now) catalogCache.delete(stale);
        }
        catalogCache.set(key, { result, expiresAt: now + CATALOG_TTL_MS });
      }
      return result;
    })
    .finally(() => catalogInflight.delete(key));
  catalogInflight.set(key, promise);
  return promise;
}

async function fetchCatalog(accessToken) {
  const cfg = traeEnterpriseConfig();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await proxyAwareFetch(cfg.modelsUrl, {
      method: "GET",
      headers: {
        Authorization: `Cloud-IDE-JWT ${accessToken}`,
        Accept: "application/json",
        ...cfg.headers,
      },
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    const groups = data?.data?.list;
    if (!Array.isArray(groups)) return null;
    const models = [];
    for (const group of groups) {
      for (const m of group?.models || []) {
        if (!m?.name) continue;
        let features = {};
        try { features = JSON.parse(m.features || "{}"); } catch { /* optional metadata */ }
        models.push({
          id: m.name,
          name: m.display_name || m.name,
          contextLength: Number(m.max_input_tokens) || undefined,
          isVL: !!m.multimodal || !!features?.multimodal?.enable,
          isReasoning: !!features?.reasoning?.enable,
        });
      }
    }
    if (!models.length) return null;
    // "auto" is a client-side lane (model_selection_strategy=auto with an empty
    // model_name), so upstream never lists it.
    if (!models.some((m) => m.id === "auto")) models.unshift({ id: "auto", name: "Auto (Server Picks)" });
    return { models };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Live model catalog for the CodeBuddy gateways (codebuddy-cn / codebuddy-intl).
//
// The gateway publishes an account-scoped product config at GET {origin}/v3/config. It
// needs the Bearer token — without one the route answers 200 with `data.models` null
// (live-verified 2026-11-06) — which is why this cannot ride the credential-free
// `transport.modelsFetcher` path and lives here instead, next to kiro/qoder/cursor.
//
// What the table gives us per model: id, name, credits ("x0.51 credits"),
// maxInputTokens/maxOutputTokens, supportsToolCall/supportsImages/supportsReasoning,
// reasoning.canDisableThinking, tags (media models say "text-to-image"…), vendor.
//
// Three rules the merge below has to honour, each learned the hard way:
//
//  1. Published ≠ usable. Probing the whole 37-row CN table 2026-11-06, seven published
//     rows 400 on /v2/chat/completions: glm-4.6 / glm-4.6v / glm-4.7 / kimi-k2-thinking /
//     minimax-m2.5 / hy4-preview-x with code 11102 ("model service info not found", i.e.
//     retired server-side but still listed) and glm-5.0-turbo with 11150 (it rejects a
//     request that carries no reasoning_effort, which a plain OpenAI client never sends).
//     So the table alone cannot answer the one question that matters — is this model
//     callable — and a probe pass is mandatory.
//
//  2. Usable ≠ published. The five gateway routers are absent from `models[]` and from
//     `agents[].models`, yet all four we carry answer (auto→glm-5.3-flash,
//     fast-model→deepseek-v4.1-flash, balanced-model→glm-5.3, deep-model→kimi-k3). They
//     come in through ROUTER_IDS, so a refresh cannot hide them.
//
//  3. A failed probe is only evidence when the gateway says so in so many words. 401 /
//     403 / 429 / a timeout say nothing about the model — during development one un-paced
//     sweep returned 401 for sixteen ids that answered 200 minutes apart. Those keep the
//     model (fail-open); only 11102 / 11103 / 11150 drop it.
import { PROVIDERS } from "../providers/index.js";
import { getModelsByProviderId } from "../config/providerModels.js";

// Gateway-side router aliases: never published in the table, verified answering.
const ROUTER_IDS = ["auto", "fast-model", "balanced-model", "deep-model"];

// Non-chat backends announce themselves through tags; 11103 is what they return on chat.
const MEDIA_TAG_RE = /^(text-to-image|image-to-image|text-to-video|image-to-video|text-to-speech|speech-to-text|embedding)$/i;

// Upstream codes that are a verdict about the model itself, not about this call.
const DEAD_CODES = {
  "11102": "retired upstream",
  "11103": "backend not served on the chat endpoint",
  "11150": "rejects a request without reasoning_effort",
};

// Probe verdicts outlive a session: availability changes on the server's schedule, and a
// full pass costs ~37 requests, so re-running it on every dashboard mount is waste.
const VERDICT_TTL_MS = 24 * 60 * 60 * 1000;
const CONFIG_TTL_MS = 6 * 60 * 60 * 1000;
const verdicts = new Map(); // providerId → { id: { usable, reason, at } }
const catalogs = new Map(); // providerId → { models, at }

export function clearCodeBuddyCatalogCache() {
  verdicts.clear();
  catalogs.clear();
}

function configUrl(baseUrl) {
  return `${new URL(baseUrl).origin}/v3/config`;
}

// "x0.51 credits" → 0.51; anything unparsable stays out so we never invent a rate.
function parseRate(credits) {
  const m = /x\s*([0-9]+(?:\.[0-9]+)?)/i.exec(String(credits || ""));
  return m ? Number(m[1]) : null;
}

function isMediaModel(model) {
  if (model?.videoGeneration) return true;
  const tags = Array.isArray(model?.tags) ? model.tags : [];
  return tags.some((tag) => MEDIA_TAG_RE.test(String(tag)));
}

// contextWindow prefers the server's own default length: maxInputTokens is the opt-in
// ceiling (kimi-k2.8-preview publishes [300000, 1000000] and the gateway grants 1M only
// when the request asks), so budgeting history against it would over-promise a window
// this lane never gets.
function contextLength(model) {
  const def = Number(model?.contextWindow?.defaultLength);
  if (Number.isFinite(def) && def > 0) return def;
  const max = Number(model?.maxInputTokens);
  return Number.isFinite(max) && max > 0 ? max : undefined;
}

export function normalizeCodeBuddyModels(data, providerId) {
  const rows = Array.isArray(data?.data?.models)
    ? data.data.models
    : Array.isArray(data?.models)
      ? data.models
      : [];
  const out = [];
  const seen = new Set();

  for (const model of rows) {
    const id = typeof model?.id === "string" ? model.id.trim() : "";
    if (!id || seen.has(id) || isMediaModel(model)) continue;
    seen.add(id);
    const row = { id, name: model.name || id };
    if (model.upstreamModelId && model.upstreamModelId !== id) row.upstreamModelId = model.upstreamModelId;
    const context = contextLength(model);
    if (context) row.contextLength = context;
    const maxOutput = Number(model.maxOutputTokens);
    if (Number.isFinite(maxOutput) && maxOutput > 0) row.maxOutputTokens = maxOutput;
    const rate = parseRate(model.credits);
    if (rate !== null) row.rateMultiplier = rate;
    row.capabilities = {
      vision: model.supportsImages === true,
      tools: model.supportsToolCall === true,
      reasoning: model.supportsReasoning === true,
    };
    const description = model.descriptionZh || model.descriptionEn || model.summary;
    if (description) row.description = String(description).slice(0, 200);
    out.push(row);
  }

  // Routers join only as an amendment to a real table: with no chat rows at all (an
  // unauthenticated call answers 200 with `models: null`) returning just the routers
  // would look like a live catalog and suppress the static fallback callers rely on.
  if (out.length) {
    for (const id of ROUTER_IDS) {
      if (seen.has(id)) continue;
      const seed = getModelsByProviderId(providerId).find((model) => model.id === id);
      if (!seed) continue;
      seen.add(id);
      out.push({ id, name: seed.name || id, upstreamModelId: seed.upstreamModelId || id, router: true });
    }
  }

  return out;
}

// One chat request, one model, no thinking fields: exactly what a plain OpenAI client
// sends, which is the contract we are testing. `effort` is the retry shape for the ids that
// reject a request carrying no reasoning_effort (code 11150).
async function probeModel(baseUrl, headers, token, id, fetchFn, timeoutMs, effort = null) {
  const body = { model: id, stream: true, messages: [{ role: "user", content: "ok" }] };
  if (effort) body.reasoning_effort = effort;
  try {
    const res = await fetchFn(`${new URL(baseUrl).origin}/v2/chat/completions`, {
      method: "POST",
      headers: { ...headers, Authorization: `Bearer ${token}`, Accept: "text/event-stream" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let code = "";
    let answered = false;
    for (const line of text.split("\n")) {
      const payload = line.startsWith("data:") ? line.slice(5).trim() : line.startsWith("{") ? line : "";
      if (!payload) continue;
      let json;
      try { json = JSON.parse(payload); } catch { continue; }
      if (json?.choices?.[0]?.delta?.content) answered = true;
      const raw = json?.code ?? json?.error?.code;
      if (raw != null) code = String(raw);
    }
    return { answered, code, status: res.status };
  } catch {
    return { answered: false, code: "", status: 0 };
  }
}

/**
 * Keep only the models the gateway will actually answer. Cached verdicts make a refresh
 * cheap; `forceRefresh` re-probes everything.
 */
async function applyProbePass(providerId, models, { token, baseUrl, headers, fetchFn, forceRefresh, log, probeTimeoutMs, probeConcurrency }) {
  const store = verdicts.get(providerId) || new Map();
  const now = Date.now();

  // Verdicts are per id, not per pass: a model the server published since the last
  // refresh has no verdict at all and must be probed even when everything around it is
  // still cached.
  const pending = models.filter((model) => {
    const known = store.get(model.id);
    return forceRefresh || !known || now - known.at >= VERDICT_TTL_MS;
  });

  const probeOne = async (model) => {
    const probe = await probeModel(baseUrl, headers, token, model.id, fetchFn, probeTimeoutMs);
    if (probe.answered) {
      store.set(model.id, { usable: true, reason: "", at: Date.now() });
    } else if (probe.code === "11150") {
      // 11150 is not a retirement: the id rejects a request that carries no
      // reasoning_effort. Retry once with "low" — the level probed safe on glm-5.1 and
      // glm-5.0-turbo — and keep the model, remembering that the executor has to inject.
      const retry = await probeModel(baseUrl, headers, token, model.id, fetchFn, probeTimeoutMs, "low");
      if (retry.answered) {
        store.set(model.id, { usable: true, reason: "", thinkingRequired: true, at: Date.now() });
        log?.warn?.("CODEBUDDY-MODELS", `keep ${model.id}: needs reasoning_effort, injected on the way out`);
      } else {
        store.set(model.id, { usable: false, reason: DEAD_CODES["11150"], code: "11150", at: Date.now() });
        log?.warn?.("CODEBUDDY-MODELS", `drop ${model.id}: still 11150 with an effort`);
      }
    } else if (DEAD_CODES[probe.code]) {
      store.set(model.id, { usable: false, reason: DEAD_CODES[probe.code], code: probe.code, at: Date.now() });
      log?.warn?.("CODEBUDDY-MODELS", `drop ${model.id}: ${probe.code} ${DEAD_CODES[probe.code]}`);
    } else {
      // Inconclusive: keep the model for this pass but do NOT cache the guess, so the
      // next refresh re-tries an id we only failed to reach.
      log?.warn?.("CODEBUDDY-MODELS", `probe inconclusive for ${model.id} (HTTP ${probe.status}) — kept, not cached`);
    }
  };

  // Bounded parallelism, not a serial loop: the gateway handles 6-way concurrency in
  // ~8s wall (measured 2026-11-06), while a serial pass over ~37 ids took 137s and stalls
  // the dashboard request that triggered it.
  let cursor = 0;
  const worker = async () => {
    while (cursor < pending.length) await probeOne(pending[cursor++]);
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(probeConcurrency, pending.length)) }, worker));
  verdicts.set(providerId, store);

  const kept = [];
  const dropped = [];
  for (const model of models) {
    const verdict = store.get(model.id);
    if (verdict && verdict.usable === false) dropped.push({ id: model.id, reason: verdict.reason });
    else kept.push(model);
  }
  return { kept, dropped };
}

/**
 * Record a retirement seen in real traffic, so the next refresh drops the id
 * immediately instead of waiting out the 24h verdict TTL. The gateway names the model in
 * its own error text ("model [x] service info not found"), which is what lets a plain
 * failed request become catalog knowledge.
 */
export function markModelUnusable(providerId, modelId, reason = "retired upstream") {
  if (!providerId || !modelId) return;
  const store = verdicts.get(providerId) || new Map();
  store.set(modelId, { usable: false, reason, at: Date.now() });
  verdicts.set(providerId, store);
}

/**
 * True when the last known verdict says this id needs an explicit reasoning_effort —
 * either the probe had to inject one, or real traffic hit 11150.
 */
export function requiresReasoningEffort(providerId, modelId) {
  return verdicts.get(providerId)?.get(modelId)?.thinkingRequired === true;
}

/**
 * Fetch, merge and verify the account's live catalog.
 * Returns `{ models, dropped, warning }`; an empty `models` means "use the static list".
 */
export async function resolveCodeBuddyModels({
  providerId,
  accessToken,
  forceRefresh = false,
  log = null,
  fetchFn = globalThis.fetch,
  probe = true,
  probeTimeoutMs = 20000,
  probeConcurrency = 4,
} = {}) {
  const transport = PROVIDERS[providerId];
  if (!transport?.baseUrl) return { models: [], warning: `${providerId} has no transport baseUrl` };
  if (!accessToken) return { models: [], warning: `${providerId}: no token` };

  const headers = { ...(transport.headers || {}) };
  const cached = catalogs.get(providerId);
  let models = null;

  if (!forceRefresh && cached && Date.now() - cached.at < CONFIG_TTL_MS) {
    models = cached.models;
  } else {
    let res;
    try {
      res = await fetchFn(configUrl(transport.baseUrl), {
        method: "GET",
        headers: { ...headers, Authorization: `Bearer ${accessToken}`, Accept: "application/json", "X-Request-ID": crypto.randomUUID() },
        signal: AbortSignal.timeout(20000),
      });
    } catch (error) {
      return { models: [], warning: `${providerId} catalog fetch failed: ${error?.message || error}` };
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return { models: [], warning: `${providerId} catalog HTTP ${res.status}: ${detail.slice(0, 120)}` };
    }
    let data = null;
    try {
      data = await res.json();
    } catch {
      return { models: [], warning: `${providerId} catalog returned invalid JSON` };
    }
    models = normalizeCodeBuddyModels(data, providerId);
    if (!models.length) return { models: [], warning: `${providerId} catalog empty` };
    catalogs.set(providerId, { models, at: Date.now() });
  }

  if (!probe) return { models, dropped: [] };

  const { kept, dropped } = await applyProbePass(providerId, models, {
    token: accessToken,
    baseUrl: transport.baseUrl,
    headers,
    fetchFn,
    forceRefresh,
    log,
    probeTimeoutMs,
    probeConcurrency,
  });
  return { models: kept, dropped };
}

export default resolveCodeBuddyModels;

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
import { createHash, randomUUID } from "node:crypto";
import { PROVIDERS } from "../providers/index.js";
import { setLiveCapabilities } from "../providers/liveCapabilities.js";
import { getModelsByProviderId } from "../config/providerModels.js";
import { getCapabilitiesForModel } from "../providers/capabilities.js";
import { stripThinkingSuffix } from "../translator/concerns/thinkingUnified.js";

// Gateway-side router aliases: never published in the table, verified answering.
const ROUTER_IDS = ["auto", "default", "fast-model", "balanced-model", "deep-model"];

// Non-chat backends announce themselves through tags; 11103 is what they return on chat.
const MEDIA_TAG_RE = /^(text-to-image|image-to-image|text-to-video|image-to-video|text-to-speech|speech-to-text|embedding)$/i;

// Codes that say the id is gone from this channel (11150 is not one of them: it means
// "send me an effort", which applyReasoningFloor fixes rather than dropping the model).
const RETIRED_CODES = {
  "11102": "retired upstream",
  "11103": "backend not served on the chat endpoint",
};

// Upstream codes that are a verdict about the model itself, not about this call.
const DEAD_CODES = {
  "11102": "retired upstream",
  "11103": "backend not served on the chat endpoint",
  "11150": "rejects a request without reasoning_effort",
};

// Probe verdicts outlive a session: availability changes on the server's schedule, and a
// cold pass costs 18 real completions (~37 without the agent-listed trust), so re-running
// it on every dashboard mount is waste.
const VERDICT_TTL_MS = 24 * 60 * 60 * 1000;
const CONFIG_TTL_MS = 6 * 60 * 60 * 1000;
// A failed catalog fetch is cached for this long so client /v1/models polls do
// not each pay the 20s fetch timeout while a credential or the gateway is down.
const CONFIG_NEGATIVE_TTL_MS = 60 * 1000;
// 4-way measured 2026-11-06: the gateway answers 6 concurrent requests in ~8s wall with no
// throttling errors, while a serial pass over the whole table took 137s. A larger fan-out
// is what produced the transient-401 sweep, so the concurrency stays modest.
const PROBE_TIMEOUT_MS = 20000;
const PROBE_CONCURRENCY = 4;
// An id we could not reach gets tried again on the next refresh, not on every request: a
// client polls /v1/models, and re-probing an unreachable id each time puts a real round
// trip (up to the probe timeout) inside the listing path.
const PROBE_RETRY_MS = 10 * 60 * 1000;
// Keyed by account, not just provider: /v3/config is an account-scoped table (a plan
// account sees ids a personal one does not), so two connections of the same provider must
// not serve each other's catalog or verdicts.
const accountKey = (providerId, accessToken) => `${providerId}|${createHash("sha256").update(String(accessToken)).digest("hex").slice(0, 16)}`;
const verdicts = new Map(); // accountKey → Map(modelId → verdict)
const catalogs = new Map(); // accountKey → { models, at }
// Two provider-scoped facts the executors report without holding a token: a retirement
// seen in real traffic, and an id that refuses a request carrying no reasoning_effort.
// Both are statements about the model on this gateway rather than about one account's
// plan, so sharing them across connections is the point, not a leak.
const reportedDead = new Map(); // providerId → Map(modelId → { reason, at })
const reasoningRequired = new Map(); // providerId → Set(modelId)
const verifying = new Map(); // accountKey → in-flight verification promise
// Two tabs opening the same provider page must not each run a probe pass: the second
// caller joins the first one's promise instead of spending another 18 completions. Keyed
// by provider + token + mode, so a waiter never joins a poller's half-answer.
const inFlight = new Map(); // providerId|token|mode → Promise<result>

export function clearCodeBuddyCatalogCache() {
  verdicts.clear();
  catalogs.clear();
  reportedDead.clear();
  reasoningRequired.clear();
  verifying.clear();
  inFlight.clear();
}

// A token rotation mints a brand-new account key, so without a sweep the caches grow for
// the life of the daemon. Deleting only what the read path already treats as expired keeps
// this behaviour-preserving: an entry past CONFIG_TTL_MS is re-fetched anyway, and a
// verdict store whose newest verdict is past VERDICT_TTL_MS re-probes every id anyway.
// Runs when a new account shows up rather than on a timer.
function pruneStaleCaches(now) {
  for (const [key, entry] of catalogs) {
    if (now - entry.at > CONFIG_TTL_MS) catalogs.delete(key);
  }
  for (const [key, store] of verdicts) {
    // Never drop the store a running pass is still writing into: it holds the reference, so
    // its verdicts would land in a map nobody reads any more.
    if (verifying.has(key)) continue;
    let newest = 0;
    for (const verdict of store.values()) if (verdict.at > newest) newest = verdict.at;
    if (!store.size || now - newest > VERDICT_TTL_MS) verdicts.delete(key);
  }
  for (const [key, table] of reportedDead) {
    for (const [id, hit] of table) if (now - hit.at > VERDICT_TTL_MS) table.delete(id);
    if (!table.size) reportedDead.delete(key);
  }
}

function reportedUnusable(providerId, modelId) {
  const hit = reportedDead.get(providerId)?.get(modelId);
  return hit && Date.now() - hit.at < VERDICT_TTL_MS ? hit : null;
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

// Take the LONGEST window the gateway offers, not its default.
//
// The old code preferred the client-side `contextWindow.defaultLength` (300000 for
// kimi-k2.8-preview) on the theory that the gateway grants 1M only to requests that opt
// in. That is false: `supportedLengths` is a local history budget in the desktop app
// (`modelContextSizeBySession`, placeholder sizing) and no such wire field exists in the
// bundle. Measured 2026-11-06 on the free hy4free row: a 493,746-token prompt answered
// 200, so nothing had to be asked for.
//
// The real ceiling is the model's own, and it is below the published number — hy4free
// says maxInputTokens 960000 yet rejects ~720,000 tokens with code 11115. The gateway
// reports that as "prompt is too long: 100001 tokens > 100000 maximum", whose numbers are
// wrong (we had already passed 493K), so 11115 is surfaced as 413 without parsing it.
// Budgeting the published maximum is still the right default: it lets long contexts
// through and the gateway's own refusal is the accurate boundary.
function contextLength(model) {
  const candidates = [
    Number(model?.maxInputTokens),
    Number(model?.maxAllowedSize),
    Number(model?.contextWindow?.defaultLength),
    ...(Array.isArray(model?.contextWindow?.supportedLengths) ? model.contextWindow.supportedLengths.map(Number) : []),
  ].filter((n) => Number.isFinite(n) && n > 0);
  return candidates.length ? Math.max(...candidates) : undefined;
}

export function normalizeCodeBuddyModels(data, providerId) {
  const root = data?.data ?? data;
  const rows = Array.isArray(root?.models) ? root.models : [];
  // Every id any agent surface references. Membership is a one-way guarantee: probed
  // 2026-11-06, all 20 agent-listed ids answer, and none of the six retired ids appears
  // here — but 7 usable ids are also absent, so the set proves usability and never
  // disproves it. That is what lets the verification pass skip 20 real chat calls.
  const agentListed = new Set();
  for (const agent of Array.isArray(root?.agents) ? root.agents : []) {
    for (const id of Array.isArray(agent?.models) ? agent.models : []) agentListed.add(id);
  }

  const out = [];
  const seen = new Set();

  for (const model of rows) {
    const id = typeof model?.id === "string" ? model.id.trim() : "";
    if (!id || seen.has(id) || isMediaModel(model)) continue;
    seen.add(id);
    const row = { id, name: model.name || id };
    if (agentListed.has(id)) row.agentListed = true;
    if (model.upstreamModelId && model.upstreamModelId !== id) row.upstreamModelId = model.upstreamModelId;
    const context = contextLength(model);
    if (context) row.contextLength = context;
    const maxOutput = Number(model.maxOutputTokens);
    if (Number.isFinite(maxOutput) && maxOutput > 0) row.maxOutputTokens = maxOutput;
    const rate = parseRate(model.credits);
    if (rate !== null) row.rateMultiplier = rate;
    // Canonical capability keys, because this object is what the router reads (via the
    // live overlay) — not just what the dashboard prints. Measured against the account
    // table, the pattern heuristics disagree on 31 of 33 chat ids, mostly by over-promising
    // maxOutput (262144 where the model gives 32000) and by guessing reasoning/vision on
    // ids the table says cannot do either.
    row.capabilities = {
      vision: model.supportsImages === true,
      tools: model.supportsToolCall === true,
      reasoning: model.supportsReasoning === true,
      ...(context ? { contextWindow: context } : {}),
      ...(Number.isFinite(maxOutput) && maxOutput > 0 ? { maxOutput } : {}),
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
//
// The output is capped, and that matters more than it looks: an uncapped "ok" is not a
// small request. Measured 2026-11-06, `default` streamed 127 KB in 10.2s at the x2 rate and
// a reasoning row filled a whole chain of thought before stopping. At 8 tokens every id
// answers in ~1.8s with `finish_reason: "length"`, so the 18-id pass costs a fraction of a
// credit instead of several.
const PROBE_MAX_TOKENS = 8;

async function probeModel(baseUrl, headers, token, id, fetchFn, timeoutMs, effort = null) {
  const body = { model: id, stream: true, max_tokens: PROBE_MAX_TOKENS, messages: [{ role: "user", content: "ok" }] };
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
      const choice = json?.choices?.[0];
      // Any accepted completion counts. With the output cap the gateway normally stops at
      // finish_reason "length" before printing anything, and a reasoning-only reply is
      // still a reply — either treated as "no answer" would leave the id permanently
      // inconclusive and re-probe it on every single call.
      if (choice && (choice.delta?.content || choice.delta?.reasoning_content || choice.finish_reason || choice.message)) answered = true;
      const raw = json?.code ?? json?.error?.code;
      // `code: 0` is this gateway's word for success, not a refusal.
      if (raw != null && String(raw) !== "0") code = String(raw);
    }
    // An error code in the stream outranks a chunk: some paths emit the role frame before
    // the refusal.
    if (code) answered = false;
    return { answered, code, status: res.status };
  } catch (error) {
    // Keep the reason: HTTP 0 covered a timeout, a reset and a refused socket identically,
    // which is how one slow id looked like a network fluke for a whole session.
    const message = error?.name === "TimeoutError" ? "timeout" : (error?.message || String(error));
    return { answered: false, code: "", status: 0, error: message };
  }
}

/**
 * Split the table by what is already known about each id. This is the cheap half of a
 * refresh — it never touches the chat endpoint — so it can run inline on a request path.
 *
 * Three tiers, and the ordering between them is the point:
 *   - `forceRefresh` (an explicit "refresh" click) re-verifies everything, including ids
 *     another connection reported retired — a model that comes back has to be able to
 *     come back.
 *   - otherwise a retirement seen in live traffic outranks every other signal, including
 *     the agent-listed trust below — that is the whole point of recording it.
 *   - otherwise a cached verdict answers outright; ids with none do NOT: they stay in
 *     `kept` (fail-open) and land in `pending` for the probe half.
 *
 * `pending` is also where an inconclusive id lands once its retry window passes: the
 * attempt is remembered so the listing path cannot hammer it, never trusted as a verdict.
 * Verdicts are per id, not per pass: a model the server published since the last refresh
 * has none at all and must be probed even when everything around it is still cached.
 */
function splitByVerdicts(providerId, store, models, { forceRefresh = false, now = Date.now() } = {}) {
  const kept = [];
  const dropped = [];
  const pending = [];

  for (const model of models) {
    if (forceRefresh) {
      pending.push(model);
      kept.push(model);
      continue;
    }
    const reported = reportedUnusable(providerId, model.id);
    if (reported) {
      store.set(model.id, { usable: false, reason: reported.reason, at: reported.at });
      dropped.push({ id: model.id, reason: reported.reason });
      continue;
    }
    const known = store.get(model.id);
    // A verdict we never actually got from the gateway (an id we could not reach) expires
    // on the retry clock, not the 24h one — but it still holds the id in, so the failure is
    // fail-open and not a silent prune.
    const verdictTtl = known?.inconclusive ? PROBE_RETRY_MS : VERDICT_TTL_MS;
    if (known && now - known.at < verdictTtl) {
      if (known.usable === false) dropped.push({ id: model.id, reason: known.reason });
      else kept.push(model);
      continue;
    }
    // The agent set is a one-way guarantee: probed 2026-11-06, all 20 listed ids answer
    // and none of the six retired ids appears in it — so membership is trusted without a
    // call. But 7 usable ids are absent from it too, so non-membership proves nothing.
    // That asymmetry is what saves ~20 real chat calls per pass.
    if (model.agentListed) {
      store.set(model.id, { usable: true, reason: "", agentListed: true, at: now });
      kept.push(model);
      continue;
    }
    pending.push(model);
    kept.push(model);
  }
  return { kept, dropped, pending };
}

/**
 * Verify the ids splitByVerdicts could not decide, with bounded parallelism and no
 * caching of anything the gateway did not state. `store` is mutated in place so a caller
 * watching the verdicts sees each id land as it is answered.
 */
async function probePending(providerId, store, pending, { token, baseUrl, headers, fetchFn, log }) {
  const probeOne = async (model) => {
    const probe = await probeModel(baseUrl, headers, token, model.id, fetchFn, PROBE_TIMEOUT_MS);
    if (probe.answered) {
      store.set(model.id, { usable: true, reason: "", at: Date.now() });
      reportedDead.get(providerId)?.delete(model.id);
    } else if (probe.code === "11150") {
      // 11150 is not a retirement: the id rejects a request that carries no
      // reasoning_effort. Retry once with "low" — the level probed safe on glm-5.1 and
      // glm-5.0-turbo — and keep the model, remembering that the executor has to inject.
      const retry = await probeModel(baseUrl, headers, token, model.id, fetchFn, PROBE_TIMEOUT_MS, "low");
      if (retry.answered) {
        store.set(model.id, { usable: true, reason: "", thinkingRequired: true, at: Date.now() });
        markReasoningRequired(providerId, model.id);
        log?.warn?.("CODEBUDDY-MODELS", `keep ${model.id}: needs reasoning_effort, injected on the way out`);
      } else {
        store.set(model.id, { usable: false, reason: DEAD_CODES["11150"], code: "11150", at: Date.now() });
        log?.warn?.("CODEBUDDY-MODELS", `drop ${model.id}: still 11150 with an effort`);
      }
    } else if (DEAD_CODES[probe.code]) {
      store.set(model.id, { usable: false, reason: DEAD_CODES[probe.code], code: probe.code, at: Date.now() });
      log?.warn?.("CODEBUDDY-MODELS", `drop ${model.id}: ${probe.code} ${DEAD_CODES[probe.code]}`);
    } else {
      // Inconclusive: keep the model, and remember the attempt on the short retry clock so
      // a client poll cannot turn one unreachable id into a stalled request every time.
      store.set(model.id, { usable: true, reason: "", inconclusive: true, at: Date.now() });
      log?.warn?.("CODEBUDDY-MODELS", `probe inconclusive for ${model.id} (HTTP ${probe.status}${probe.error ? ` ${probe.error}` : ""}) — kept, retried in ${PROBE_RETRY_MS / 60000}m`);
    }
  };

  // Bounded parallelism, not a serial loop: a serial pass over the table took 137s and
  // stalls whatever waited on it.
  let cursor = 0;
  const worker = async () => {
    while (cursor < pending.length) await probeOne(pending[cursor++]);
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(PROBE_CONCURRENCY, pending.length)) }, worker));
}

/**
 * Record a retirement seen in real traffic, so the next refresh drops the id
 * immediately instead of waiting out the 24h verdict TTL. The gateway names the model in
 * its own error text ("model [x] service info not found"), which is what lets a plain
 * failed request become catalog knowledge.
 */
export function markModelUnusable(providerId, modelId, reason = "retired upstream") {
  if (!providerId || !modelId) return;
  const store = reportedDead.get(providerId) || new Map();
  store.set(modelId, { reason, at: Date.now() });
  reportedDead.set(providerId, store);
}

/**
 * True when the last known verdict says this id needs an explicit reasoning_effort —
 * either the probe had to inject one, or real traffic hit 11150.
 */
export function requiresReasoningEffort(providerId, modelId) {
  return reasoningRequired.get(providerId)?.has(modelId) === true;
}

function markReasoningRequired(providerId, modelId) {
  const set = reasoningRequired.get(providerId) || new Set();
  set.add(modelId);
  reasoningRequired.set(providerId, set);
}

/**
 * The floor both CodeBuddy executors apply on the way out: some ids 400 with code 11150
 * unless the request carries a reasoning_effort, so a client that asked for nothing would
 * get a hard failure. "low" is the level probed safe (glm-5.1: 200 + 461 chars of
 * reasoning; glm-5.0-turbo: 200 + 489). `reasoning_summary` is deliberately NOT set —
 * that pairing is what #2071's content filter trips.
 *
 * Lives here rather than in one executor because codebuddy-cn and codebuddy-intl are two
 * classes over the same gateway family; a rule learned about the gateway belongs to the
 * gateway, not to the class that happened to notice it.
 */
export function applyReasoningFloor(providerId, model, body) {
  if (!body || body.reasoning_effort) return body;
  const clean = stripThinkingSuffix(typeof model === "string" ? model : body.model);
  if (getCapabilitiesForModel(providerId, clean).thinkingRequired === true || requiresReasoningEffort(providerId, clean)) {
    body.reasoning_effort = "low";
  }
  return body;
}

/**
 * Feed a parsed gateway error back into the catalog. The retired codes name the model in
 * their own message ("model [x] service info not found"), so one user's failed request
 * becomes a verdict the next refresh honours instead of a 24h stale entry. Takes the
 * object the caller already parsed — this runs on the error path, not a second JSON.parse.
 */
export function recordRetirement(providerId, data) {
  if (!data || typeof data !== "object") return;
  const code = String(data.code ?? "");
  const reason = RETIRED_CODES[code];
  if (!reason) return;
  const named = /model\s*\[([^\]]+)\]/i.exec(String(data?.msg || data?.message || ""));
  if (named) markModelUnusable(providerId, named[1].trim(), reason);
}

/**
 * Fetch, merge and verify the account's live catalog.
 * Returns `{ models, dropped, warning }`; an empty `models` means "use the static list".
 * Concurrent callers for the same provider share one pass — a probe costs real
 * completions, so two tabs must not each pay for it.
 *
 * Verification never blocks a caller that did not ask for it: ids with a known verdict
 * are pruned inline (no model call), ids without one are returned optimistically while a
 * background pass probes them. `wait: true` joins that pass and returns the settled list;
 * `forceRefresh` re-probes everything and waits, because the user clicked refresh to get
 * the verified answer.
 */
export async function resolveCodeBuddyModels(options = {}) {
  const providerId = options.providerId;
  if (!providerId) return { models: [], dropped: [], warning: "no providerId" };
  // Three modes, because three callers want three different answers and only one of them
  // may block. `poll` (a client hitting /v1/models) takes the optimistic list, `wait` (the
  // dashboard page a human is watching) joins the pass and gets the verified one, `force`
  // (the refresh button) re-probes from scratch. Sharing one promise per mode is what
  // stops two tabs each paying for a pass; the probe itself is shared across modes through
  // `verifying`, so a poll that started it does not make the waiter pay twice.
  const mode = options.forceRefresh ? "force" : options.wait ? "wait" : "poll";
  const key = `${providerId}|${options.accessToken || ""}|${mode}`;
  const running = inFlight.get(key);
  if (running) return running;
  const task = resolveCatalog(options).finally(() => inFlight.delete(key));
  inFlight.set(key, task);
  return task;
}

async function resolveCatalog({
  providerId,
  accessToken,
  forceRefresh = false,
  wait = false,
  log = null,
  fetchFn = globalThis.fetch,
} = {}) {
  const transport = PROVIDERS[providerId];
  if (!transport?.baseUrl) return { models: [], dropped: [], warning: `${providerId} has no transport baseUrl` };
  if (!accessToken) return { models: [], dropped: [], warning: `${providerId}: no token` };

  const headers = { ...(transport.headers || {}) };
  const account = accountKey(providerId, accessToken);
  if (!catalogs.has(account)) pruneStaleCaches(Date.now());
  const cached = catalogs.get(account);
  // Hold a failure briefly so a dead credential or a down gateway does not make
  // every /v1/models poll pay a fresh 20s round-trip. forceRefresh (the dashboard
  // button) bypasses this below; a success overwrites the negative entry.
  const fail = (warning) => {
    catalogs.set(account, { models: [], at: Date.now(), warning });
    return { models: [], dropped: [], warning };
  };
  let models = null;

  if (!forceRefresh && cached) {
    const age = Date.now() - cached.at;
    if (cached.models.length && age < CONFIG_TTL_MS) {
      models = cached.models;
    } else if (!cached.models.length && cached.warning && age < CONFIG_NEGATIVE_TTL_MS) {
      return { models: [], dropped: [], warning: cached.warning };
    }
  }
  if (!models) {
    let res;
    try {
      res = await fetchFn(configUrl(transport.baseUrl), {
        method: "GET",
        headers: { ...headers, Authorization: `Bearer ${accessToken}`, Accept: "application/json", "X-Request-ID": randomUUID() },
        signal: AbortSignal.timeout(20000),
      });
    } catch (error) {
      return fail(`${providerId} catalog fetch failed: ${error?.message || error}`);
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return fail(`${providerId} catalog HTTP ${res.status}: ${detail.slice(0, 120)}`);
    }
    let data = null;
    try {
      data = await res.json();
    } catch {
      return fail(`${providerId} catalog returned invalid JSON`);
    }
    models = normalizeCodeBuddyModels(data, providerId);
    if (!models.length) return fail(`${providerId} catalog empty`);
    catalogs.set(account, { models, at: Date.now() });
  }

  const publish = (rows) => {
    setLiveCapabilities(providerId, rows.map((row) => ({
      id: row.id,
      capabilities: {
        ...(row.capabilities || {}),
        // Discovered by the probe, not in the table: the id refuses a request with no
        // reasoning_effort, and capabilities.thinkingRequired is what makes the executor
        // inject one. Without this the routing layer would keep sending a rejected shape.
        ...(requiresReasoningEffort(providerId, row.id) ? { thinkingRequired: true } : {}),
      },
    })));
  };

  let store = verdicts.get(account);
  if (!store) {
    store = new Map();
    verdicts.set(account, store);
  }

  // Capabilities are the table's own words — publish them before verifying anything, so
  // the router stops guessing (31 of 33 ids wrong) without waiting on a single completion.
  const now = Date.now();
  const split = splitByVerdicts(providerId, store, models, { forceRefresh, now });
  publish(split.kept);

  const settled = () => {
    // Re-split rather than reuse `split`: the ids just probed now have verdicts, so this
    // is what turns "the gateway refuses it" into a pruned list.
    const done = splitByVerdicts(providerId, store, models, { now: Date.now() });
    publish(done.kept);
    return { models: done.kept, dropped: done.dropped };
  };

  const verify = async () => {
    await probePending(providerId, store, split.pending, {
      token: accessToken,
      baseUrl: transport.baseUrl,
      headers,
      fetchFn,
      log,
    });
  };

  // Nothing to prove: the cached verdicts are the answer, and this caller gets them
  // inline instead of on the next request.
  if (!split.pending.length) return { models: split.kept, dropped: split.dropped };

  // An explicit refresh re-verifies everything and waits: the user clicked "refresh" to
  // get the verified list, including the ids a cached verdict already says are dead.
  if (forceRefresh) {
    await verify();
    return settled();
  }

  // Start the pass for the ids nobody has a verdict for — once per account, however many
  // callers arrive while it runs.
  let task = verifying.get(account);
  if (!task) {
    task = verify().catch(() => {}).finally(() => verifying.delete(account));
    verifying.set(account, task);
  }

  // A client-facing poll must not block: /v1/models is what an SDK hits on startup, and a
  // cold pass costs ~10s of real completions. Serve the optimistically-pruned table (ids
  // already known dead are out, unknown ids stay in) and let the pass settle behind it, so
  // the next caller gets the verified list.
  if (!wait) return { models: split.kept, dropped: split.dropped };

  // A request the user is watching waits instead — joining the pass that is already
  // running, so waiting never costs a second set of calls. Decide from this call's own
  // table afterwards: the pass may have been started by someone else, and an id the pass
  // could not reach stays in.
  await task;
  return settled();
}

export default resolveCodeBuddyModels;

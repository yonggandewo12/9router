// Live model catalog for Command Code (commandcode / cmc).
//
// The CLI picker is driven by GET https://api.commandcode.ai/provider/v1/models?view=client
// (live-verified 2026-11-10): a PUBLIC, account-independent JSON document. The CLI refreshes
// it with no Authorization header — only `accept` and `if-none-match` — so one shared cache
// serves every connection rather than a per-account table. The plain (view-less) endpoint
// returns a stripped OpenAI-style list with no badge/pricing/modalities/hidden flag, so the
// client view is the authoritative source for both what the picker shows and what each model
// can do.
//
// Two rules mirror the CLI exactly:
//  1. hidden:true rows never reach the picker (15 of 112 on 2026-11-10, among them the free
//     twins of paid models). The view-less endpoint filters these server-side; the client
//     view does not, so the filter lives here.
//  2. display.badge === "free" marks a free model (zero pricing). Only two are visible:
//     stealth/glyph-cluster:free and stealth/crouton-alpha — the ids the static registry was
//     missing, which is why this lane's list had drifted from the CLI.
//
// No probing pass: unlike CodeBuddy, this catalog is the CLI's own source of truth for what
// is listable, and plan gating (minimumPlan) happens upstream at call time, not here.
import { setLiveCapabilities } from "../providers/liveCapabilities.js";

const CATALOG_URL = "https://api.commandcode.ai/provider/v1/models?view=client";
// The document advertises refreshAfterSeconds (900 on 2026-11-10); match it so a model the
// upstream publishes shows up within one CLI refresh interval without a 9router release.
const CATALOG_TTL_MS = 15 * 60 * 1000;
// Hold a failure briefly so a down endpoint does not make every /v1/models poll pay a fresh
// round-trip. A success overwrites the negative entry; forceRefresh bypasses it.
const NEGATIVE_TTL_MS = 60 * 1000;
const FETCH_TIMEOUT_MS = 15000;

let cache = null; // { models, at, warning? }
let inFlight = null;

export function clearCommandCodeCatalogCache() {
  cache = null;
  inFlight = null;
}

// getCapabilitiesForModel queries the live overlay by the vendor-stripped base id
// ("stealth/glyph-cluster:free" → "glyph-cluster:free"), so the overlay is keyed by that.
const baseModelId = (id) => (id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id);

export function normalizeCommandCodeModels(data) {
  const rows = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    const id = typeof row?.id === "string" ? row.id.trim() : "";
    if (!id || seen.has(id) || row.hidden === true) continue;
    seen.add(id);
    const modalities = Array.isArray(row.inputModalities) ? row.inputModalities : [];
    const efforts = Array.isArray(row.reasoningEfforts) ? row.reasoningEfforts : null;
    // A model that only offers "off" (or nothing) takes no thinking level; anything else does.
    const reasoning = !!efforts && efforts.some((level) => level !== "off");
    const context = Number(row.context_length);
    const maxOutput = Number(row.maxOutputTokens);
    const model = {
      id,
      name: row.display?.label || row.name || id,
      capabilities: {
        vision: modalities.includes("image"),
        reasoning,
        thinkingFormat: "commandcode",
        thinkingEffortSupported: reasoning,
        ...(Number.isFinite(context) && context > 0 ? { contextWindow: context } : {}),
        ...(Number.isFinite(maxOutput) && maxOutput > 0 ? { maxOutput } : {}),
      },
    };
    if (row.display?.badge === "free") model.isFree = true;
    if (Number.isFinite(context) && context > 0) model.contextLength = context;
    out.push(model);
  }
  return out;
}

function publishCapabilities(models) {
  // The visible catalog has no base-id collisions (verified 2026-11-10), so keying the
  // overlay by the stripped id is unambiguous and lines up with the chat path's lookup.
  setLiveCapabilities(
    "commandcode",
    models.map((model) => ({ id: baseModelId(model.id), capabilities: model.capabilities })),
  );
}

/**
 * Fetch and normalize the public Command Code catalog.
 * Returns `{ models, warning? }`; an empty `models` means "use the static list".
 * Concurrent callers share one fetch — the document is public, so two tabs must not each
 * pay for it. `forceRefresh` (the dashboard refresh button) bypasses both caches.
 */
export async function resolveCommandCodeModels({ forceRefresh = false, fetchFn = globalThis.fetch, now = Date.now() } = {}) {
  if (!forceRefresh && cache) {
    const age = now - cache.at;
    if (cache.models.length && age < CATALOG_TTL_MS) {
      publishCapabilities(cache.models);
      return { models: cache.models };
    }
    if (!cache.models.length && cache.warning && age < NEGATIVE_TTL_MS) {
      return { models: [], warning: cache.warning };
    }
  }
  if (inFlight) return inFlight;

  const task = (async () => {
    const fail = (warning) => {
      cache = { models: [], at: Date.now(), warning };
      return { models: [], warning };
    };
    let res;
    try {
      res = await fetchFn(CATALOG_URL, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (error) {
      return fail(`Command Code catalog fetch failed: ${error?.message || error}`);
    }
    if (!res.ok) return fail(`Command Code catalog HTTP ${res.status}`);
    let data;
    try {
      data = await res.json();
    } catch {
      return fail("Command Code catalog returned invalid JSON");
    }
    const models = normalizeCommandCodeModels(data);
    if (!models.length) return fail("Command Code catalog empty");
    cache = { models, at: Date.now() };
    publishCapabilities(models);
    return { models };
  })().finally(() => {
    inFlight = null;
  });
  inFlight = task;
  return task;
}

export default resolveCommandCodeModels;
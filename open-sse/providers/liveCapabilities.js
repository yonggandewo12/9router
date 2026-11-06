// Runtime capability overlay for providers whose model list is resolved live.
//
// Why this exists: the chat path reads model metadata through
// getCapabilitiesForModel(provider, model), which only knows the static tables. A model
// that appears in a live catalog (and is therefore callable by name — the upstream id is
// forwarded untouched) would otherwise get DEFAULT_CAPABILITIES: reasoning:false strips a
// client's thinking parameters, and contextWindow 200000 budgets history for a fraction of
// a window the model really has. Display and routing were disagreeing about the same model.
//
// The overlay is keyed by provider so two accounts of different gateways cannot step on
// each other's rows, and merging is additive-only on defined values: a partial live row
// (most resolvers return { id, name }) must not erase static knowledge.
//
// Deliberately tiny and dependency-free: capabilities.js imports it, and capabilities.js
// is imported nearly everywhere, so anything imported here would risk a cycle.
const overlay = new Map(); // providerId → Map(modelId → partial capabilities)

function definedOnly(source) {
  const out = {};
  for (const [key, value] of Object.entries(source || {})) {
    if (value === undefined || value === null) continue;
    if (typeof value === "number" && !Number.isFinite(value)) continue;
    out[key] = value;
  }
  return out;
}

/**
 * Publish live capabilities for a provider's models. Replaces the provider's previous
 * overlay wholesale, so a model that has left the live catalog stops being advertised
 * from it (the static tables still answer for ids the provider curated by hand).
 */
export function setLiveCapabilities(providerId, entries) {
  if (!providerId || !Array.isArray(entries)) return;
  const table = new Map();
  for (const entry of entries) {
    const id = typeof entry?.id === "string" ? entry.id.trim() : "";
    if (!id) continue;
    const caps = definedOnly(entry.capabilities ?? entry);
    if (Object.keys(caps).length) table.set(id, caps);
  }
  overlay.set(providerId, table);
}

export function getLiveCapabilities(providerId, modelId) {
  return overlay.get(providerId)?.get(modelId) || null;
}

export function clearLiveCapabilities(providerId) {
  if (providerId) overlay.delete(providerId);
  else overlay.clear();
}

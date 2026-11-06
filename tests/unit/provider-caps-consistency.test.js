// Provider caps tables vs registry model lists — the drift guard.
//
// Why this exists: PROVIDER_CAPABILITIES is step 1 of capability resolution and
// it SHORT-CIRCUITS, so a row naming a model the gateway no longer publishes is
// a stale contract nobody reads. That was live: codebuddy-cn carried six rows
// for ids its own drop log says were retired (glm-5.0, glm-4.7, kimi-k2.5,
// hy3-preview, deepseek-v4-flash, deepseek-v3-2-volc).
//
// Note what is deliberately NOT asserted here: a table need not cover every
// published model. Most providers describe only the rows where the generic
// pattern/catalog answer is wrong, and that is the design. codebuddy-intl is
// the case where the generic answer IS the problem (see the debt register
// below), so it is pinned instead of quietly re-deriving numbers nobody measured.
import { describe, expect, it } from "vitest";

import REGISTRY from "../../open-sse/providers/registry/index.js";
import { PROVIDER_CAPABILITIES } from "../../open-sse/providers/capabilities.js";

const BY_ID = new Map(REGISTRY.map((e) => [e.id, e]));
// Tables may be keyed by id or by any alias (cx, devin, devin-cli); resolve so
// one provider is never counted twice under two keys.
const ID_BY_KEY = new Map(
  REGISTRY.flatMap((e) => [[e.id, e.id], [e.alias || e.id, e.id], ...(e.aliases || []).map((a) => [a, e.id])])
);

// Caps tables whose provider is no longer in the registry. Left in place on
// purpose: deleting them changes how existing connection rows for a retired
// provider resolve capabilities, which is a call for whoever owns that lane —
// registered here so no further orphan table can appear unnoticed.
const KNOWN_ORPHAN_TABLES = ["devin", "devin-cli"];

// Providers whose model ids are dynamic — the registry list is not the universe,
// so a caps row can legitimately name an id it does not carry.
const PASSTHROUGH_OK = new Set(["opencode"]);

// Pre-existing rows that name ids outside their provider's published list.
// Not re-verified here; registered so the guard is green today and any NEW
// dead row anywhere fails.
const KNOWN_DEAD_ROWS = {
  commandcode: ["claude-haiku-5-5"],
  "qoder-cn": ["smodel", "cmodel"],
};

// codebuddy-intl has no per-model table: its limits, vision flags and
// thinkingCanDisable come from the vendor-name patterns, which describe the
// model rather than this gateway. Measured against the CN gateway's own
// product-config rows, that answer is wrong in both directions (glm-5.2 and
// hy3-preview come back vision:false though CN publishes supportsImages:true;
// kimi-k2.5 comes back maxOutput 262144 where CN publishes 32000). The honest
// source is the intl product-config endpoint — same shape as CN's
// /console/enterprises/{enterpriseId}/config/models, whose enterpriseId is the
// `enterprise_id` claim of the stored access token. Until that is fetched for a
// real intl account, this list is frozen: adding an intl model without a
// measured row fails here rather than silently inheriting a guess.
const INTL_UNMEASURED_MODELS = [
  "glm-5.2",
  "glm-5.1",
  "glm-5.0",
  "glm-5.0-turbo",
  "glm-5v-turbo",
  "glm-4.7",
  "minimax-m3",
  "minimax-m2.7",
  "kimi-k2.7",
  "kimi-k2.6",
  "kimi-k2.5",
  "hy3-preview",
  "deepseek-v4-pro",
  "deepseek-v4.1-flash",
  "deepseek-v3-2-volc",
];

describe("provider caps tables", () => {
  const tables = new Map();
  for (const [key, rows] of Object.entries(PROVIDER_CAPABILITIES)) {
    const providerId = ID_BY_KEY.get(key) || key;
    if (!tables.has(providerId)) tables.set(providerId, Object.keys(rows));
  }

  it("every table belongs to a registered provider", () => {
    const orphans = [...tables.keys()].filter((id) => !BY_ID.has(id));
    expect(orphans.sort()).toEqual([...KNOWN_ORPHAN_TABLES].sort());
  });

  it("no table names a model its provider does not publish", () => {
    const offenders = [];
    for (const [providerId, rows] of tables) {
      const entry = BY_ID.get(providerId);
      if (!entry || entry.passthroughModels || PASSTHROUGH_OK.has(providerId)) continue;
      const ids = new Set((entry.models || []).map((m) => m.id));
      const allowed = new Set(KNOWN_DEAD_ROWS[providerId] || []);
      const dead = rows.filter((r) => !ids.has(r) && !allowed.has(r));
      if (dead.length) offenders.push(`${providerId}: ${dead.join(", ")}`);
    }
    expect(offenders).toEqual([]);
  });

  it("codebuddy-cn's table is exactly its published list", () => {
    // 16 models, 16 rows, nothing stale — the state this guard was written to
    // restore and keep.
    const ids = BY_ID.get("codebuddy-cn").models.map((m) => m.id);
    expect(Object.keys(PROVIDER_CAPABILITIES["codebuddy-cn"]).sort()).toEqual([...ids].sort());
  });

  it("keeps the codebuddy-intl measurement debt frozen", () => {
    expect(PROVIDER_CAPABILITIES["codebuddy-intl"]).toBeUndefined();
    const published = BY_ID.get("codebuddy-intl").models.map((m) => m.id);
    expect(published).toEqual(expect.arrayContaining(INTL_UNMEASURED_MODELS));
    // New intl ids must be added here (or given a measured caps row), so the
    // gap can only shrink.
    expect(published.filter((id) => !INTL_UNMEASURED_MODELS.includes(id))).toEqual([]);
  });
});

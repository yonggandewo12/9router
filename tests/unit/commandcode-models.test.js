// Command Code's picker drifted from the official CLI because this lane had a hand-maintained
// static registry and NO live-catalog wiring. The CLI reads a PUBLIC, account-independent
// document (GET /provider/v1/models?view=client, live-verified 2026-11-10) that had grown to 97
// visible models — among them two free ids (stealth/glyph-cluster:free, stealth/crouton-alpha)
// the registry lacked, while two registry ids (xiaomi/mimo-v2.5*) had become hidden upstream.
//
// These tests pin the three contracts that keep the lane honest:
//   1. normalization mirrors the CLI (hidden excluded, badge "free" → isFree, real caps);
//   2. the resolver fetches the public client view once, caches it, and publishes an overlay
//      keyed by the vendor-stripped base id the chat path actually looks up;
//   3. the static fallback + the pickers carry the free ids so an offline caller still sees them.
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import {
  normalizeCommandCodeModels,
  resolveCommandCodeModels,
  clearCommandCodeCatalogCache,
} from "open-sse/services/commandcodeModels.js";
import registry from "open-sse/providers/registry/index.js";
import { getCapabilitiesForModel } from "open-sse/providers/capabilities.js";
import { clearLiveCapabilities } from "open-sse/providers/liveCapabilities.js";

// A row shaped like the live client-view document, defaulting to the free Glyph Cluster so
// each test overrides only the field it is about.
const ccRow = (over = {}) => ({
  id: "stealth/glyph-cluster:free",
  name: "Glyph Cluster",
  hidden: false,
  display: { label: "Glyph Cluster", badge: "free", order: 67 },
  inputModalities: ["text"],
  reasoningEfforts: ["low", "medium", "high", "xhigh"],
  context_length: 256000,
  maxOutputTokens: 256000,
  ...over,
});

const payload = (rows) => ({ object: "list", catalogVersion: "test", data: rows });

const jsonResponse = (body, { ok = true, status = 200 } = {}) => ({
  ok,
  status,
  json: async () => body,
});

describe("commandcode catalog normalization", () => {
  it("keeps a visible free row with the catalog's own numbers and badge", () => {
    const models = normalizeCommandCodeModels(payload([ccRow()]));
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({
      id: "stealth/glyph-cluster:free",
      name: "Glyph Cluster",
      isFree: true,
      contextLength: 256000,
      capabilities: {
        vision: false,
        reasoning: true,
        thinkingFormat: "commandcode",
        thinkingEffortSupported: true,
        contextWindow: 256000,
        maxOutput: 256000,
      },
    });
  });

  it("reads vision and the 1M window from Crouton Alpha", () => {
    const models = normalizeCommandCodeModels(payload([
      ccRow({
        id: "stealth/crouton-alpha",
        name: "Crouton Alpha",
        display: { label: "Crouton Alpha", badge: "free", order: 68 },
        inputModalities: ["text", "image"],
        reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
        context_length: 1048576,
        maxOutputTokens: 943718,
      }),
    ]));
    expect(models[0]).toMatchObject({
      id: "stealth/crouton-alpha",
      isFree: true,
      capabilities: { vision: true, reasoning: true, contextWindow: 1048576, maxOutput: 943718 },
    });
  });

  it("never lets a hidden row reach the picker", () => {
    // 15 of the 112 client-view rows are hidden (the free twins of paid models among them).
    // The view-less endpoint filters these server-side; the client view does not, so the
    // filter has to live here or the picker would offer ids the CLI itself never shows.
    const ids = normalizeCommandCodeModels(payload([
      ccRow({ id: "stealth/glyph-cluster:free" }),
      ccRow({ id: "xiaomi/mimo-v2.5", hidden: true, display: { label: "MiMo V2.5", badge: "free" } }),
      ccRow({ id: "deepseek/deepseek-v4-pro", display: { label: "DeepSeek V4 Pro", badge: null } }),
    ])).map((m) => m.id);
    expect(ids).toEqual(["stealth/glyph-cluster:free", "deepseek/deepseek-v4-pro"]);
    expect(ids).not.toContain("xiaomi/mimo-v2.5");
  });

  it("marks free only on badge 'free', not on a null or missing badge", () => {
    const models = normalizeCommandCodeModels(payload([
      ccRow({ id: "paid-null", display: { label: "Paid", badge: null } }),
      ccRow({ id: "paid-missing", display: { label: "Paid" } }),
      ccRow({ id: "free", display: { label: "Free", badge: "free" } }),
    ]));
    expect(models.find((m) => m.id === "paid-null")).not.toHaveProperty("isFree");
    expect(models.find((m) => m.id === "paid-missing")).not.toHaveProperty("isFree");
    expect(models.find((m) => m.id === "free").isFree).toBe(true);
  });

  it("treats reasoning as supported only when an effort other than 'off' exists", () => {
    const models = normalizeCommandCodeModels(payload([
      ccRow({ id: "off-only", reasoningEfforts: ["off"] }),
      ccRow({ id: "no-efforts", reasoningEfforts: null }),
      ccRow({ id: "mixed", reasoningEfforts: ["off", "low", "high", "max"] }),
    ]));
    expect(models.find((m) => m.id === "off-only").capabilities.reasoning).toBe(false);
    expect(models.find((m) => m.id === "off-only").capabilities.thinkingEffortSupported).toBe(false);
    expect(models.find((m) => m.id === "no-efforts").capabilities.reasoning).toBe(false);
    expect(models.find((m) => m.id === "mixed").capabilities.reasoning).toBe(true);
  });

  it("omits limits the catalog leaves null rather than inventing a number", () => {
    // deepseek-v4.1-flash ships maxOutputTokens:null but a real context_length.
    const models = normalizeCommandCodeModels(payload([
      ccRow({ id: "deepseek/deepseek-v4.1-flash", context_length: 1000000, maxOutputTokens: null, display: { label: "DS", badge: null } }),
    ]));
    expect(models[0].capabilities.contextWindow).toBe(1000000);
    expect(models[0].capabilities).not.toHaveProperty("maxOutput");
    expect(models[0].contextLength).toBe(1000000);
  });

  it("falls back through name → id when display.label is absent", () => {
    const models = normalizeCommandCodeModels(payload([
      ccRow({ id: "vendor/has-name", name: "Has Name", display: { badge: null } }),
      ccRow({ id: "vendor/id-only", name: undefined, display: undefined }),
    ]));
    expect(models.find((m) => m.id === "vendor/has-name").name).toBe("Has Name");
    expect(models.find((m) => m.id === "vendor/id-only").name).toBe("vendor/id-only");
  });

  it("de-duplicates repeated ids and skips rows without one", () => {
    const models = normalizeCommandCodeModels(payload([
      ccRow(),
      ccRow({ name: "dup" }),
      ccRow({ id: "   " }),
      ccRow({ id: undefined }),
      { name: "no id at all" },
    ]));
    expect(models.map((m) => m.id)).toEqual(["stealth/glyph-cluster:free"]);
  });

  it("tolerates an empty, null, or bare-array payload", () => {
    expect(normalizeCommandCodeModels(payload([]))).toEqual([]);
    expect(normalizeCommandCodeModels({ data: null })).toEqual([]);
    expect(normalizeCommandCodeModels({})).toEqual([]);
    expect(normalizeCommandCodeModels(null)).toEqual([]);
    // The normalizer also accepts a bare array (the view-less endpoint's shape).
    expect(normalizeCommandCodeModels([ccRow()]).map((m) => m.id)).toEqual(["stealth/glyph-cluster:free"]);
  });
});

describe("commandcode public catalog resolver", () => {
  beforeEach(() => { clearCommandCodeCatalogCache(); clearLiveCapabilities("commandcode"); });
  afterEach(() => { clearCommandCodeCatalogCache(); clearLiveCapabilities("commandcode"); });

  it("fetches the client view with no Authorization header", async () => {
    const calls = [];
    const fetchFn = async (url, opts = {}) => { calls.push({ url, opts }); return jsonResponse(payload([ccRow()])); };
    const result = await resolveCommandCodeModels({ fetchFn });
    expect(result.models.map((m) => m.id)).toEqual(["stealth/glyph-cluster:free"]);
    expect(calls).toHaveLength(1);
    // The document is public: the CLI sends only accept (+ if-none-match). An Authorization
    // header here would wrongly make the cache account-specific and leak a key to a public GET.
    expect(calls[0].url).toBe("https://api.commandcode.ai/provider/v1/models?view=client");
    expect(calls[0].opts.headers.accept).toBe("application/json");
    expect(calls[0].opts.headers).not.toHaveProperty("authorization");
    expect(calls[0].opts.headers).not.toHaveProperty("Authorization");
  });

  it("serves a second caller from cache without re-fetching", async () => {
    let fetches = 0;
    const fetchFn = async () => { fetches++; return jsonResponse(payload([ccRow()])); };
    await resolveCommandCodeModels({ fetchFn });
    const again = await resolveCommandCodeModels({ fetchFn });
    expect(fetches).toBe(1);
    expect(again.models.map((m) => m.id)).toEqual(["stealth/glyph-cluster:free"]);
  });

  it("forceRefresh re-fetches and can surface a newly published id", async () => {
    const first = async () => jsonResponse(payload([ccRow()]));
    await resolveCommandCodeModels({ fetchFn: first });
    let secondFetches = 0;
    const second = async () => {
      secondFetches++;
      return jsonResponse(payload([ccRow(), ccRow({ id: "stealth/brand-new", display: { label: "Brand New", badge: "free" } })]));
    };
    const refreshed = await resolveCommandCodeModels({ fetchFn: second, forceRefresh: true });
    expect(secondFetches).toBe(1);
    expect(refreshed.models.map((m) => m.id)).toContain("stealth/brand-new");
  });

  it("shares one fetch between concurrent callers", async () => {
    let fetches = 0;
    const slow = async () => {
      fetches++;
      await new Promise((r) => setTimeout(r, 20));
      return jsonResponse(payload([ccRow()]));
    };
    const [a, b] = await Promise.all([
      resolveCommandCodeModels({ fetchFn: slow }),
      resolveCommandCodeModels({ fetchFn: slow }),
    ]);
    expect(fetches).toBe(1);
    expect(a.models.map((m) => m.id)).toEqual(b.models.map((m) => m.id));
  });

  it("negative-caches an HTTP failure so repeated polls do not each pay the fetch", async () => {
    let fetches = 0;
    const fetchFn = async () => { fetches++; return jsonResponse({}, { ok: false, status: 503 }); };
    const a = await resolveCommandCodeModels({ fetchFn });
    const b = await resolveCommandCodeModels({ fetchFn });
    expect(fetches).toBe(1);
    expect(a.models).toEqual([]);
    expect(a.warning).toContain("503");
    expect(b.warning).toContain("503");
  });

  it("negative-caches a thrown fetch and recovers on forceRefresh", async () => {
    let fetches = 0;
    const down = async () => { fetches++; throw new Error("network down"); };
    const failed = await resolveCommandCodeModels({ fetchFn: down });
    expect(failed.models).toEqual([]);
    expect(failed.warning).toContain("network down");
    await resolveCommandCodeModels({ fetchFn: down });
    expect(fetches).toBe(1); // still negative-cached

    const up = async () => { fetches++; return jsonResponse(payload([ccRow()])); };
    const back = await resolveCommandCodeModels({ fetchFn: up, forceRefresh: true });
    expect(fetches).toBe(2);
    expect(back.models.map((m) => m.id)).toEqual(["stealth/glyph-cluster:free"]);
    expect(back.warning).toBeUndefined();
  });

  it("reports an empty or invalid catalog as a warning, not a crash", async () => {
    const empty = await resolveCommandCodeModels({ fetchFn: async () => jsonResponse(payload([])) });
    expect(empty.models).toEqual([]);
    expect(empty.warning).toContain("empty");

    clearCommandCodeCatalogCache();
    const badJson = await resolveCommandCodeModels({
      fetchFn: async () => ({ ok: true, status: 200, json: async () => { throw new Error("bad json"); } }),
    });
    expect(badJson.models).toEqual([]);
    expect(badJson.warning).toContain("invalid JSON");
  });

  it("ages the cache out past the refresh interval", async () => {
    let fetches = 0;
    const fetchFn = async () => { fetches++; return jsonResponse(payload([ccRow()])); };
    const t0 = Date.now();
    await resolveCommandCodeModels({ fetchFn, now: t0 });
    // Within the 15-minute interval: cached.
    await resolveCommandCodeModels({ fetchFn, now: t0 + 60 * 1000 });
    expect(fetches).toBe(1);
    // Past it: the daemon must re-read rather than trust a stale picker forever.
    await resolveCommandCodeModels({ fetchFn, now: t0 + 16 * 60 * 1000 });
    expect(fetches).toBe(2);
  });

  it("publishes the overlay keyed by the base id the chat path looks up", async () => {
    const fetchFn = async () => jsonResponse(payload([
      ccRow(),
      ccRow({
        id: "stealth/crouton-alpha",
        display: { label: "Crouton Alpha", badge: "free" },
        inputModalities: ["text", "image"],
        context_length: 1048576,
        maxOutputTokens: 943718,
      }),
    ]));
    await resolveCommandCodeModels({ fetchFn });

    // The wire id is vendor-prefixed; getCapabilitiesForModel strips to the base id, so the
    // overlay must be keyed by that or the router would fall back to the generic 1M/384k guess.
    const glyph = getCapabilitiesForModel("commandcode", "stealth/glyph-cluster:free");
    expect(glyph.contextWindow).toBe(256000);
    expect(glyph.maxOutput).toBe(256000);
    expect(glyph.vision).toBe(false);
    const crouton = getCapabilitiesForModel("commandcode", "stealth/crouton-alpha");
    expect(crouton.contextWindow).toBe(1048576);
    expect(crouton.maxOutput).toBe(943718);
    expect(crouton.vision).toBe(true);
    // The wire alias and the bare base id resolve the same way.
    expect(getCapabilitiesForModel("cmc", "stealth/crouton-alpha").maxOutput).toBe(943718);
    expect(getCapabilitiesForModel("commandcode", "crouton-alpha").maxOutput).toBe(943718);
  });

  it("does not leak the overlay onto another provider", async () => {
    const fetchFn = async () => jsonResponse(payload([ccRow({ context_length: 256000, maxOutputTokens: 256000 })]));
    await resolveCommandCodeModels({ fetchFn });
    expect(getCapabilitiesForModel("commandcode", "stealth/glyph-cluster:free").maxOutput).toBe(256000);
    expect(getCapabilitiesForModel("some-other-provider", "stealth/glyph-cluster:free").maxOutput).not.toBe(256000);
  });
});

describe("commandcode registry hygiene (offline fallback)", () => {
  const cc = registry.find((p) => p.id === "commandcode");

  it("carries both visible free ids with isFree so an offline picker still shows them", () => {
    const glyph = cc.models.find((m) => m.id === "stealth/glyph-cluster:free");
    const crouton = cc.models.find((m) => m.id === "stealth/crouton-alpha");
    expect(glyph).toMatchObject({ name: "Glyph Cluster", isFree: true });
    expect(crouton).toMatchObject({ name: "Crouton Alpha", isFree: true });
    // Only two of the catalog's 15 free rows are visible; the rest are hidden twins.
    expect(cc.models.filter((m) => m.isFree)).toHaveLength(2);
  });

  it("drops the ids that became hidden upstream and keeps a working sibling", () => {
    const ids = cc.models.map((m) => m.id);
    expect(ids).not.toContain("xiaomi/mimo-v2.5");
    expect(ids).not.toContain("xiaomi/mimo-v2.5-pro");
    expect(ids).toContain("moonshotai/Kimi-K3.1-Pro");
  });

  it("is a deduplicated snapshot of the 97 visible client-view rows", () => {
    // Snapshot pin (catalogVersion c6350c34…, 2026-11-10): catches accidental truncation or a
    // hidden row leaking back in. Refresh this count together with the registry when upstream moves.
    expect(cc.models).toHaveLength(97);
    expect(new Set(cc.models.map((m) => m.id)).size).toBe(97);
    expect(cc.passthroughModels).toBe(true);
  });
});

describe("commandcode offline capability pins", () => {
  beforeEach(() => clearLiveCapabilities("commandcode"));
  afterEach(() => clearLiveCapabilities("commandcode"));

  it("pins the free ids to the catalog values without any live overlay", () => {
    const glyph = getCapabilitiesForModel("commandcode", "stealth/glyph-cluster:free");
    expect(glyph).toMatchObject({ vision: false, reasoning: true, thinkingFormat: "commandcode", contextWindow: 256000, maxOutput: 256000 });
    expect(getCapabilitiesForModel("commandcode", "glyph-cluster:free").maxOutput).toBe(256000);

    const crouton = getCapabilitiesForModel("commandcode", "stealth/crouton-alpha");
    expect(crouton).toMatchObject({ vision: true, reasoning: true, contextWindow: 1048576, maxOutput: 943718 });
    expect(getCapabilitiesForModel("cmc", "crouton-alpha").vision).toBe(true);
  });

  it("leaves the curated haiku-5-5 numbers untouched", () => {
    expect(getCapabilitiesForModel("commandcode", "claude-haiku-5-5")).toMatchObject({ contextWindow: 1000000, maxOutput: 128000, vision: true });
  });
});

// The pickers' passthrough branch used to read the static registry and ignore liveModels, so
// adding commandcode to the live Sets would have been a dead fetch. These pin that the live
// catalog actually wins when present and the static list answers when it is not.
import { buildModelGroups, collectModelValues } from "@/shared/utils/selectableModels.js";

describe("commandcode picker prefers the live catalog", () => {
  const conn = [{ id: "c1", provider: "commandcode", isActive: true }];

  it("uses live ids (including one absent from the static registry) instead of merging", () => {
    const groups = buildModelGroups({
      connections: conn,
      allConnections: conn,
      liveModels: {
        commandcode: [
          { id: "stealth/glyph-cluster:free", name: "Glyph Cluster" },
          { id: "test/live-only", name: "Live Only" },
        ],
      },
    });
    const ids = groups.commandcode.models.map((m) => m.id);
    expect(ids).toEqual(["stealth/glyph-cluster:free", "test/live-only"]);
    expect(collectModelValues(groups).some((v) => v.endsWith("/test/live-only"))).toBe(true);
  });

  it("falls back to the static registry when no live catalog is present", () => {
    const groups = buildModelGroups({ connections: conn, allConnections: conn, liveModels: {} });
    const ids = groups.commandcode.models.map((m) => m.id);
    expect(ids).toContain("stealth/glyph-cluster:free");
    expect(ids).toContain("stealth/crouton-alpha");
    expect(ids).not.toContain("test/live-only");
    expect(ids).toHaveLength(97);
  });
});
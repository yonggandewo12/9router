import { describe, expect, it } from "vitest";

import { aggregateComboCapabilities, getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";

// A combo's limits are the conservative aggregate of its members: ctx = min,
// maxOutput = max. Resolving those members needs the synced model catalog, which
// is server-only (it reads a file), so the browser bundle falls back to the
// generic patterns. The dashboard computed its badges there and under-reported:
// /v1/models and pi-settings (both server-side) said 1M while the badge said 200k.
//
// resolveCaps lets a caller hand in the server's answer. It must only override
// what it carries — the local tables still own tools/pdf/audio/video/thinking*.
// The fed context window is deliberately NOT the pattern default (1M, see
// capabilities.js `*glm-5.3*`): a fed value the local tables already produce
// cannot tell "resolver used" from "resolver ignored".
const GLM53_FED = { vision: true, search: false, reasoning: true, contextWindow: 500_000, maxOutput: 131_072 };

describe("aggregateComboCapabilities: resolveCaps override", () => {
  const models = ["glm-cn/glm-5.3", "deepseek-v4.1-flash"];

  it("falls back to the pattern default without a resolver", () => {
    const caps = aggregateComboCapabilities(models);
    // glm-5.3 has no exact entry, so the *glm-5.3* pattern carries it: 1M since
    // upstream raised the 5.2/5.3 patterns to match the server (#4544).
    expect(caps.contextWindow).toBe(1_000_000);
  });

  it("uses the fed limits when a resolver supplies them", () => {
    const resolver = (fullId) => (fullId === "glm-cn/glm-5.3" ? GLM53_FED : null);
    const caps = aggregateComboCapabilities(models, null, resolver);
    // 500k is below both members' local 1M, so only the resolver can produce it.
    expect(caps.contextWindow).toBe(500_000);
  });

  it("keeps the fields the override does not carry", () => {
    const plain = aggregateComboCapabilities(models);
    const fed = aggregateComboCapabilities(models, null, (id) => (id === "glm-cn/glm-5.3" ? GLM53_FED : null));
    // The override does move the number it carries...
    expect(plain.contextWindow).toBe(1_000_000);
    expect(fed.contextWindow).toBe(500_000);
    // ...while tools/pdf/thinking fields stay owned by the local tables.
    for (const field of ["tools", "pdf", "audioInput", "videoInput", "imageOutput", "audioOutput", "thinkingFormat"]) {
      expect(fed[field]).toEqual(plain[field]);
    }
  });

  it("still applies the conservative rule across members", () => {
    const resolver = (fullId) => (fullId === "glm-cn/glm-5.3" ? GLM53_FED : null);
    const caps = aggregateComboCapabilities(models, null, resolver);
    // Only glm-5.3 was fed 500k; deepseek-v4.1-flash resolves locally to 1M, so the
    // min is the fed value. Feeding an even *smaller* one must pull the aggregate down.
    expect(caps.contextWindow).toBe(500_000);
    const smaller = aggregateComboCapabilities(models, null, (id) => (id === "glm-cn/glm-5.3" ? { ...GLM53_FED, contextWindow: 64_000 } : null));
    expect(smaller.contextWindow).toBe(64_000);
    expect(caps.maxOutput).toBe(384_000); // max across members, from deepseek
  });

  it("passes the resolver into nested combos", () => {
    const lookup = {
      zap: ["deepseek-v4.1-flash", "glm-cn/glm-5.3-flash"],
      "deepseek-v4.1-flash": ["cmc/deepseek/deepseek-v4.1-flash", "ocg/deepseek-v4.1-flash"],
    };
    const seen = [];
    const resolver = (fullId) => { seen.push(fullId); return fullId === "glm-cn/glm-5.3-flash" ? { contextWindow: 1_000_000 } : null; };
    aggregateComboCapabilities(lookup.zap, lookup, resolver);
    // The nested combo's own members were resolved with the same resolver.
    expect(seen).toContain("cmc/deepseek/deepseek-v4.1-flash");
    expect(seen).toContain("ocg/deepseek-v4.1-flash");
  });

  it("leaves the plain two-argument call unchanged", () => {
    const caps = aggregateComboCapabilities(["kimi/kimi-k3"], null);
    expect(caps).toEqual(aggregateComboCapabilities(["kimi/kimi-k3"]));
    expect(caps.contextWindow).toBe(getCapabilitiesForModel("kimi", "kimi-k3").contextWindow);
  });
});

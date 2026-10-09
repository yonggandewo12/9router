// Fal's queue endpoint is `https://queue.fal.run/<fal model id>` and fal's own ids
// carry a `fal-ai/` vendor prefix. /v1/models strips a leading `${providerId}/`
// from registry ids and the image path forwards the resolved id verbatim, so the
// prefix has to live in baseUrl — otherwise the advertised `fal/flux/schnell`
// builds `queue.fal.run/flux/schnell` and every request 404s.
import { describe, it, expect } from "vitest";
import adapter from "../../open-sse/handlers/imageProviders/falAi.js";
import registry from "../../open-sse/providers/registry/fal-ai.js";

describe("fal-ai image routing", () => {
  it("builds fal's documented queue URL for every registry model", () => {
    expect(registry.models.length).toBeGreaterThan(0);
    for (const m of registry.models) {
      expect(adapter.buildUrl(m.id)).toBe(`https://queue.fal.run/fal-ai/${m.id}`);
    }
  });

  it("keeps registry ids free of the prefix /v1/models would strip", () => {
    for (const m of registry.models) {
      expect(m.id.startsWith(`${registry.id}/`), m.id).toBe(false);
    }
  });
});

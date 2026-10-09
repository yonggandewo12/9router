// Poolside's gateway ids are vendor-prefixed ("poolside/laguna-xs-2.1") while the
// registry id is bare, and /v1/models strips a leading `${providerId}/` from what
// it advertises. Without upstreamModelId the stripped id reaches the gateway and
// every request 404s with "please check the model you provided".
import { describe, it, expect } from "vitest";
import { PROVIDER_MODELS, getModelUpstreamId } from "../../open-sse/config/providerModels.js";
import registry from "../../open-sse/providers/registry/poolside.js";

describe("poolside upstream model ids", () => {
  it("declares a vendor-prefixed upstream id for every model", () => {
    const models = PROVIDER_MODELS[registry.alias] || PROVIDER_MODELS[registry.id];
    expect(models.length).toBeGreaterThan(0);
    for (const m of models) {
      expect(m.upstreamModelId, `${m.id} needs an upstreamModelId`).toBe(`poolside/${m.id}`);
    }
  });

  it("resolves the advertised id to the prefixed one routing forwards", () => {
    for (const m of registry.models) {
      expect(getModelUpstreamId(registry.alias, m.id)).toBe(`poolside/${m.id}`);
    }
  });
});

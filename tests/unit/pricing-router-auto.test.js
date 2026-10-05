// `auto` is a gateway-side router pseudo-model, not a billable model, and five
// providers expose one under that bare id (codebuddy-cn, qoder, qoder-cn, trae,
// trae-enterprise). It used to live in MODEL_PRICING, whose step-3 lookup is
// unscoped, so all of them were costed at OpenRouter's router average.
import { describe, it, expect } from "vitest";
import { MODEL_PRICING, PROVIDER_PRICING, getPricingForModel } from "../../open-sse/providers/pricing.js";

describe("router pseudo-model pricing is provider-scoped", () => {
  it("no longer carries a global auto rate", () => {
    expect(MODEL_PRICING.auto).toBeUndefined();
  });

  it("keeps OpenRouter's auto estimate where it belongs", () => {
    expect(getPricingForModel("openrouter", "auto")).toMatchObject({ input: 2, output: 8 });
  });

  it("costs credit-billed routers as unknown, like their sibling pseudo-models", () => {
    for (const provider of ["codebuddy-cn", "qoder", "qoder-cn", "trae", "trae-enterprise"]) {
      expect(getPricingForModel(provider, "auto"), provider).toBeNull();
    }
    expect(getPricingForModel("codebuddy-cn", "default")).toBeNull();
    expect(getPricingForModel("codebuddy-cn", "balanced-model")).toBeNull();
  });

  it("does not glob a tier router into some other model's rate", () => {
    expect(PROVIDER_PRICING["codebuddy-cn"]).toBeUndefined();
    expect(getPricingForModel("codebuddy-cn", "fast-model")).toBeNull();
    expect(getPricingForModel("codebuddy-cn", "deep-model")).toBeNull();
  });
});

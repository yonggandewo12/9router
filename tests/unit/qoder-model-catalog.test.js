import { afterEach, describe, expect, it, vi } from "vitest";
import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { clearQoderCatalog, resolveQoderModels } from "../../open-sse/services/qoderModels.js";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(),
}));

afterEach(() => {
  clearQoderCatalog();
  vi.resetAllMocks();
});

describe("Qoder model catalog", () => {
  it("hides disabled models from the picker but keeps their config and upstream names", async () => {
    const latest = {
      key: "qmodel_latest",
      display_name: "Qwen4-Max-Preview",
      enable: false,
      max_input_tokens: 200000,
    };
    proxyAwareFetch.mockResolvedValue(new Response(JSON.stringify({
      chat: [latest, { key: "qfmodel", display_name: "Qwen3.8-Flash", enable: true }],
    }), { status: 200 }));

    const catalog = await resolveQoderModels({
      provider: "qoder",
      accessToken: "test-token",
      providerSpecificData: { userId: "test-user" },
    }, { forceRefresh: true });

    // Fork rule: enable:false entries stay out of the picker (the vendor marks them
    // unusable) but their config must still be cached so an explicit chat still works.
    expect(catalog.models.map(({ id, name }) => ({ id, name }))).toEqual([
      { id: "qfmodel", name: "Qwen3.8-Flash" },
    ]);
    expect(catalog.rawConfigs.get("qmodel_latest")).toEqual(latest);
  });
});

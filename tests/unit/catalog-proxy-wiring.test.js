import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connections: [],
  connection: null,
  proxy: {
    connectionProxyEnabled: true,
    connectionProxyUrl: "socks5://127.0.0.1:9050",
    connectionNoProxy: "",
    strictProxy: true,
  },
  codebuddy: vi.fn(),
  qoder: vi.fn(),
  commandcode: vi.fn(),
  proxyFetch: vi.fn(),
  refreshCn: vi.fn(),
  refreshIntl: vi.fn(),
  updateCredentials: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: async () => mocks.connections,
  getCombos: async () => [],
  getCustomModels: async () => [],
  getModelAliases: async () => ({}),
}));
vi.mock("@/lib/disabledModelsDb", () => ({ getDisabledModels: async () => ({}) }));
vi.mock("@/models", () => ({ getProviderConnectionById: async () => mocks.connection }));
vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: async () => mocks.proxy,
}));
vi.mock("@/sse/services/tokenRefresh", () => ({
  updateProviderCredentials: mocks.updateCredentials,
}));
vi.mock("open-sse/services/tokenRefresh/providers.js", () => ({
  refreshCodebuddyToken: mocks.refreshCn,
  refreshCodebuddyIntlToken: mocks.refreshIntl,
}));
vi.mock("open-sse/services/codebuddyModels.js", () => ({
  resolveCodeBuddyModels: mocks.codebuddy,
}));
vi.mock("open-sse/services/qoderModels.js", () => ({
  resolveQoderModels: mocks.qoder,
  routableQoderModels: (catalog) => catalog?.models || [],
}));
vi.mock("open-sse/services/commandcodeModels.js", () => ({
  resolveCommandCodeModels: mocks.commandcode,
}));
vi.mock("open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: mocks.proxyFetch,
}));

import { buildModelsList } from "@/app/api/v1/models/route.js";
import { GET } from "@/app/api/providers/[id]/models/route.js";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.connections = [];
  mocks.connection = null;
  mocks.proxyFetch.mockResolvedValue(Response.json({ ok: true }));
  mocks.commandcode.mockResolvedValue({ models: [] });
});

describe("live catalog connection-proxy wiring", () => {
  it("threads the Qoder proxy through /v1/models", async () => {
    mocks.connections = [{
      id: "qoder-proxy-v1",
      provider: "qoder",
      isActive: true,
      accessToken: "jt-test",
      providerSpecificData: { userId: "u" },
    }];
    mocks.qoder.mockResolvedValue({ models: [{ id: "qmodel_latest", name: "Latest" }] });

    await buildModelsList(["llm"]);

    expect(mocks.qoder).toHaveBeenCalledTimes(1);
    expect(mocks.qoder.mock.calls[0][0].proxyOptions).toEqual(mocks.proxy);
  });

  it("threads the CodeBuddy proxy through catalog fetch and probes in /v1/models", async () => {
    mocks.connections = [{
      id: "codebuddy-proxy-v1",
      provider: "codebuddy-cn",
      isActive: true,
      accessToken: "cb-test",
    }];
    mocks.codebuddy.mockResolvedValue({ models: [{ id: "glm-5.3", name: "GLM 5.3" }] });

    await buildModelsList(["llm"]);

    const options = mocks.codebuddy.mock.calls[0][0];
    expect(typeof options.fetchFn).toBe("function");
    await options.fetchFn("https://copilot.tencent.com/v3/config", { method: "GET" });
    expect(mocks.proxyFetch).toHaveBeenCalledWith(
      "https://copilot.tencent.com/v3/config",
      { method: "GET" },
      mocks.proxy,
    );
  });

  it("refreshes an expired CodeBuddy token once in /v1/models", async () => {
    mocks.connections = [{
      id: "codebuddy-refresh-v1",
      provider: "codebuddy-intl",
      isActive: true,
      accessToken: "expired",
      refreshToken: "refresh",
    }];
    mocks.codebuddy
      .mockResolvedValueOnce({ models: [], warning: "codebuddy-intl catalog HTTP 401" })
      .mockResolvedValueOnce({ models: [{ id: "gpt-6-sol", name: "GPT-6 Sol" }] });
    mocks.refreshIntl.mockResolvedValue({ accessToken: "fresh", refreshToken: "rotated", expiresIn: 3600 });

    await buildModelsList(["llm"]);

    expect(mocks.refreshIntl).toHaveBeenCalledTimes(1);
    expect(mocks.updateCredentials).toHaveBeenCalledWith("codebuddy-refresh-v1", {
      accessToken: "fresh",
      refreshToken: "rotated",
      expiresIn: 3600,
    });
    expect(mocks.codebuddy.mock.calls[1][0].accessToken).toBe("fresh");
  });
});

describe("dashboard catalog refresh and proxy wiring", () => {
  it("uses Qoder's cache on page open and bypasses it only for an explicit refresh", async () => {
    mocks.connection = {
      id: "qoder-dashboard",
      provider: "qoder",
      accessToken: "jt-test",
      providerSpecificData: { userId: "u" },
    };
    mocks.qoder.mockResolvedValue({ models: [{ id: "qmodel_latest", name: "Latest" }] });

    const open = await GET(new Request("http://localhost/api/providers/qoder-dashboard/models"), {
      params: Promise.resolve({ id: "qoder-dashboard" }),
    });
    expect(open.status).toBe(200);
    expect(mocks.qoder.mock.calls[0][1]).toMatchObject({ forceRefresh: false, proxyOptions: mocks.proxy });

    const refresh = await GET(new Request("http://localhost/api/providers/qoder-dashboard/models?forceRefresh=1"), {
      params: Promise.resolve({ id: "qoder-dashboard" }),
    });
    expect(refresh.status).toBe(200);
    expect(mocks.qoder.mock.calls[1][1]).toMatchObject({ forceRefresh: true, proxyOptions: mocks.proxy });
  });
});

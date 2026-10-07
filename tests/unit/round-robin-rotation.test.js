import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  getSettings: vi.fn(),
  updateProviderConnection: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: mocks.getProviderConnections,
  getSettings: mocks.getSettings,
  getProxyPools: vi.fn(),
  validateApiKey: vi.fn(),
  updateProviderConnection: mocks.updateProviderConnection,
}));
vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: vi.fn(async () => ({})),
  pickProxyPoolId: vi.fn(),
}));
vi.mock("@/shared/constants/providers.js", () => ({
  FREE_PROVIDERS: {},
  resolveProviderId: (provider) => provider,
}));
vi.mock("@/sse/utils/logger.js", () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }));

const POOL = [
  { id: "r-1", priority: 1, isActive: true },
  { id: "r-2", priority: 2, isActive: true },
  { id: "r-3", priority: 3, isActive: true },
];

// connectionRotation keeps module state, so every case needs a fresh graph.
async function loadServices() {
  const auth = await import("@/sse/services/auth.js");
  const rotation = await import("@/sse/services/connectionRotation.js");
  return { getProviderCredentials: auth.getProviderCredentials, flushRotationState: rotation.flushRotationState };
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.useRealTimers();
  mocks.getProviderConnections.mockResolvedValue(POOL.map((c) => ({ ...c })));
  mocks.updateProviderConnection.mockResolvedValue({});
});

describe("round-robin account rotation", () => {
  it("spreads concurrent selections across accounts using pending state", async () => {
    mocks.getSettings.mockResolvedValue({ fallbackStrategy: "round-robin", stickyRoundRobinLimit: 1 });
    const { getProviderCredentials } = await loadServices();

    const picked = await Promise.all([1, 2, 3].map(() => getProviderCredentials("router")));

    expect(picked.map((c) => c.connectionId).sort()).toEqual(["r-1", "r-2", "r-3"]);
  });

  it("keeps an account for stickyRoundRobinLimit uses before rotating", async () => {
    // Distinct clock ticks per call: same-millisecond marks tie in the recency
    // sort, which would make the expected rotation order nondeterministic.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-07T00:00:00.000Z"));
    mocks.getSettings.mockResolvedValue({ fallbackStrategy: "round-robin", stickyRoundRobinLimit: 2 });
    const { getProviderCredentials } = await loadServices();

    const picks = [];
    for (let i = 0; i < 4; i++) {
      picks.push((await getProviderCredentials("router")).connectionId);
      await vi.advanceTimersByTimeAsync(1000);
    }
    vi.useRealTimers();

    expect(picks).toEqual(["r-1", "r-1", "r-2", "r-2"]);
  });

  it("defers rotation to SQLite and coalesces repeated uses into one write", async () => {
    mocks.getSettings.mockResolvedValue({ fallbackStrategy: "round-robin", stickyRoundRobinLimit: 3 });
    const { getProviderCredentials, flushRotationState } = await loadServices();

    await getProviderCredentials("router");
    await getProviderCredentials("router");

    expect(mocks.updateProviderConnection).not.toHaveBeenCalled();

    await flushRotationState();

    expect(mocks.updateProviderConnection).toHaveBeenCalledTimes(1);
    expect(mocks.updateProviderConnection).toHaveBeenCalledWith("r-1", {
      lastUsedAt: expect.any(String),
      consecutiveUseCount: 2,
    });
  });

  it("persists rotation on its own once the debounce elapses", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-07T00:00:00.000Z"));
    mocks.getSettings.mockResolvedValue({ fallbackStrategy: "round-robin", stickyRoundRobinLimit: 3 });
    const { getProviderCredentials } = await loadServices();

    await getProviderCredentials("router");
    await vi.advanceTimersByTimeAsync(250);

    expect(mocks.updateProviderConnection).toHaveBeenCalledWith("r-1", {
      lastUsedAt: "2026-10-07T00:00:00.000Z",
      consecutiveUseCount: 1,
    });
    vi.useRealTimers();
  });

  it("leaves fill-first selection untouched by rotation state", async () => {
    mocks.getSettings.mockResolvedValue({ fallbackStrategy: "fill-first" });
    const { getProviderCredentials, flushRotationState } = await loadServices();

    const first = await getProviderCredentials("router");
    const second = await getProviderCredentials("router");

    expect(first.connectionId).toBe("r-1");
    expect(second.connectionId).toBe("r-1");
    await expect(flushRotationState()).resolves.toBeUndefined();
    expect(mocks.updateProviderConnection).not.toHaveBeenCalled();
  });
});

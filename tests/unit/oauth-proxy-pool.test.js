/**
 * Locks the proxy-pool threading for Google-backed OAuth providers:
 * settings.providerStrategies → route builds proxyOptions → exchangeTokens meta →
 * proxyAwareFetch during exchange/postExchange, and executor refreshCredentials.
 * If any hop drops the options, the connect/refresh goes direct and the pool
 * binding silently stops working — these tests make that loud.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

const proxyAwareFetch = vi.fn(async () => ({
  ok: true,
  status: 200,
  json: async () => ({}),
  text: async () => "{}",
}));

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch,
}));

const PROXY_OPTIONS = {
  connectionProxyEnabled: true,
  connectionProxyUrl: "http://127.0.0.1:7890",
  connectionNoProxy: "",
  vercelRelayUrl: "",
  strictProxy: true,
};

function allCallsCarryOptions() {
  expect(proxyAwareFetch.mock.calls.length).toBeGreaterThan(0);
  for (const call of proxyAwareFetch.mock.calls) {
    expect(call[2]).toBe(PROXY_OPTIONS);
  }
}

beforeEach(() => proxyAwareFetch.mockClear());

describe("gemini-cli OAuth proxy threading", () => {
  it("exchangeToken forwards meta.proxyOptions to proxyAwareFetch", async () => {
    const { default: geminiCli } = await import("../../src/lib/oauth/providers/gemini-cli.js");
    await geminiCli.exchangeToken(geminiCli.config, "code", "http://redirect", "verifier", "state", { proxyOptions: PROXY_OPTIONS });
    allCallsCarryOptions();
  });

  it("postExchange forwards proxyOptions to every Google call", async () => {
    const { default: geminiCli } = await import("../../src/lib/oauth/providers/gemini-cli.js");
    await geminiCli.postExchange({ access_token: "tok" }, { proxyOptions: PROXY_OPTIONS });
    expect(proxyAwareFetch.mock.calls.length).toBeGreaterThanOrEqual(2);
    allCallsCarryOptions();
  });
});

describe("antigravity OAuth proxy threading", () => {
  it("exchangeToken forwards meta.proxyOptions to proxyAwareFetch", async () => {
    const { default: antigravity } = await import("../../src/lib/oauth/providers/antigravity.js");
    await antigravity.exchangeToken(antigravity.config, "code", "http://redirect", "verifier", "state", { proxyOptions: PROXY_OPTIONS });
    allCallsCarryOptions();
  });

  it("postExchange forwards proxyOptions to userInfo and loadCodeAssist", async () => {
    const { default: antigravity } = await import("../../src/lib/oauth/providers/antigravity.js");
    // json: {} → cloudaicompanionProject empty → onboarding loop skipped (fast test)
    await antigravity.postExchange({ access_token: "tok" }, { proxyOptions: PROXY_OPTIONS });
    expect(proxyAwareFetch.mock.calls.length).toBeGreaterThanOrEqual(2);
    allCallsCarryOptions();
  });
});

describe("exchangeTokens meta threading (provider index)", () => {
  it("threads meta into exchangeToken and postExchange", async () => {
    const { exchangeTokens } = await import("../../src/lib/oauth/providers/index.js");
    await exchangeTokens("gemini-cli", "code", "http://redirect", "verifier", "state", { proxyOptions: PROXY_OPTIONS });
    // exchange + userInfo + loadCodeAssist
    expect(proxyAwareFetch.mock.calls.length).toBeGreaterThanOrEqual(3);
    allCallsCarryOptions();
  });
});

describe("executor refreshCredentials proxy forwarding", () => {
  it("GeminiCLIExecutor passes proxyOptions through to the token refresh", async () => {
    const { GeminiCLIExecutor } = await import("../../open-sse/executors/gemini-cli.js");
    // mock response has no access_token → undefined fields, but the call must be proxied
    const out = await new GeminiCLIExecutor().refreshCredentials({ refreshToken: "r", projectId: "p" }, null, PROXY_OPTIONS);
    expect(out?.projectId).toBe("p");
    allCallsCarryOptions();
  });

  it("AntigravityExecutor passes proxyOptions through to the token refresh", async () => {
    const { AntigravityExecutor } = await import("../../open-sse/executors/antigravity.js");
    const out = await new AntigravityExecutor().refreshCredentials({ refreshToken: "r", projectId: "p" }, null, PROXY_OPTIONS);
    expect(out?.projectId).toBe("p");
    allCallsCarryOptions();
  });
});

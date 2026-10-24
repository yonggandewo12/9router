/**
 * The smart-router's 8s ceiling must cancel the in-flight System One call, not
 * merely stop waiting for it. fetch has no total timeout of its own, so a router
 * that accepts the connection and then goes silent would otherwise leave the
 * socket and the account's concurrency slot held long after the combo already
 * failed open to its normal order.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  handleSystemoneCore: vi.fn(),
  getModelInfo: vi.fn(),
  getProviderCredentials: vi.fn(),
  checkAndRefreshToken: vi.fn(),
}));

vi.mock("../../src/sse/services/model.js", () => ({
  getModelInfo: mocks.getModelInfo,
}));
vi.mock("../../src/sse/services/auth.js", () => ({
  getProviderCredentials: mocks.getProviderCredentials,
}));
vi.mock("../../src/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: mocks.checkAndRefreshToken,
}));
vi.mock("../../open-sse/handlers/systemoneCore.js", () => ({
  handleSystemoneCore: mocks.handleSystemoneCore,
}));

const { resolveSmartChoice } = await import("../../src/sse/services/systemoneRouter.js");

const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
const BODY = { messages: [{ role: "user", content: "Write a Rust binary search" }] };
const MODELS = ["cx/gpt-5-mini", "ds/deepseek-v4"];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getModelInfo.mockResolvedValue({ provider: "oc", model: "jev-1.13-free" });
  mocks.getProviderCredentials.mockResolvedValue({ accessToken: "at", connectionId: "conn" });
  mocks.checkAndRefreshToken.mockImplementation(async (_provider, credentials) => credentials);
});

describe("resolveSmartChoice timeout", () => {
  it("aborts the in-flight System One request when the ceiling expires", async () => {
    let seenSignal = null;
    mocks.handleSystemoneCore.mockImplementation(({ signal }) => {
      seenSignal = signal;
      // Never settles on its own — only the abort tears it down, like a silent upstream.
      return new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason));
      });
    });

    const result = await resolveSmartChoice({ body: BODY, models: MODELS, log, timeoutMs: 20 });

    expect(result).toBeNull();
    expect(seenSignal).toBeInstanceOf(AbortSignal);
    expect(seenSignal.aborted).toBe(true);
    expect(log.warn).toHaveBeenCalledWith("COMBO", expect.stringContaining("timed out after 20ms"));
  });

  it("leaves the signal untouched when the decision arrives in time", async () => {
    let seenSignal = null;
    mocks.handleSystemoneCore.mockImplementation(async ({ signal }) => {
      seenSignal = signal;
      return {
        success: true,
        response: Response.json({
          answers: { route: { choice: "ds/deepseek-v4", probabilities: { "ds/deepseek-v4": 0.9 } } },
        }),
      };
    });

    const result = await resolveSmartChoice({ body: BODY, models: MODELS, log, timeoutMs: 5000 });

    expect(result).toMatchObject({ choice: "ds/deepseek-v4" });
    expect(seenSignal.aborted).toBe(false);
  });
});

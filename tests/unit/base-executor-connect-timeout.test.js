/**
 * A connect timeout has to reach chatCore as a provider failure, not as a client
 * cancellation. Undici rejects an aborted fetch with an AbortError, and chatCore maps
 * AbortError → 499 "Request aborted": the caller gets blamed for a dead upstream, the
 * request log says FAILED 499, and the account loop skips the cooldown, so the next
 * request is routed straight back into the same silent gateway.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => {
      const err = new Error("This operation was aborted");
      err.name = "AbortError";
      reject(err);
    }, { once: true });
  }),
}));

const { BaseExecutor } = await import("../../open-sse/executors/base.js");

function makeExecutor(timeoutMs) {
  return new BaseExecutor("test-upstream", {
    baseUrl: "https://upstream.test/v1",
    timeoutMs,
    retry: { 502: { attempts: 0, delayMs: 0 } },
  });
}

const args = (extra = {}) => ({
  model: "test-model",
  body: { messages: [{ role: "user", content: "hi" }] },
  stream: true,
  credentials: { apiKey: "k" },
  log: { debug: vi.fn() },
  ...extra,
});

describe("BaseExecutor connect timeout", () => {
  it("surfaces a silent upstream as a provider error, not an AbortError", async () => {
    const error = await makeExecutor(5).execute(args()).then(
      () => null,
      (e) => e
    );

    expect(error).toBeTruthy();
    expect(error.name).not.toBe("AbortError");
    expect(error.message).toMatch(/connect timeout/);
  }, 5000);

  it("still reports a real client cancellation as an AbortError", async () => {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(new Error("client gone")), 5);

    const error = await makeExecutor(60_000).execute(args({ signal: ctrl.signal })).then(
      () => null,
      (e) => e
    );

    expect(error).toBeTruthy();
    expect(error.name).toBe("AbortError");
  }, 5000);
});

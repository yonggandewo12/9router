/**
 * fetchWithConnectTimeout is the shared bound for lanes that call fetch directly
 * (image, embeddings, image-provider polling). Two properties matter and both are
 * easy to get wrong:
 *   - an upstream that accepts the connection and never answers must not hold the
 *     client request open forever;
 *   - the bound must NOT survive the response headers. embeddingsCore used
 *     AbortSignal.timeout(), which stays armed through the body read, so a slow
 *     upstream aborted inside parseUpstreamError/response.json() and the error
 *     escaped the handler as an unhandled 500.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { connectTimeoutGuard, fetchWithConnectTimeout } from "../../open-sse/utils/fetchTimeout.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function stubFetch(impl) {
  vi.stubGlobal("fetch", vi.fn(impl));
  return vi.mocked(fetch);
}

describe("fetchWithConnectTimeout", () => {
  it("passes the response through and arms a signal", async () => {
    const fetchMock = stubFetch((_url, init) => {
      expect(init.signal).toBeInstanceOf(AbortSignal);
      return Promise.resolve(new Response("ok"));
    });

    const res = await fetchWithConnectTimeout("https://x/y", { method: "POST", body: "{}" });
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("aborts when response headers never arrive", async () => {
    stubFetch((_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    }));

    await expect(fetchWithConnectTimeout("https://x/silent", {}, 10)).rejects.toThrow(/connect timeout/i);
  });

  it("leaves the body readable after the connect window passes", async () => {
    // The whole point of clearing the timer at headers: a slow-but-alive upstream
    // must not be cut off mid-body.
    stubFetch(() => Promise.resolve(new Response(
      new ReadableStream({
        async start(controller) {
          await new Promise((r) => setTimeout(r, 30));
          controller.enqueue(new TextEncoder().encode("late payload"));
          controller.close();
        },
      })
    )));

    const res = await fetchWithConnectTimeout("https://x/slow-body", {}, 5);
    expect(await res.text()).toBe("late payload");
  });

  it("keeps a caller-supplied signal instead of replacing it", async () => {
    const caller = new AbortController();
    const fetchMock = stubFetch((_url, init) => {
      expect(init.signal).not.toBe(caller.signal);
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("aborted by caller")), { once: true });
      });
    });

    const pending = fetchWithConnectTimeout("https://x/y", { signal: caller.signal }, 5000);
    caller.abort();
    await expect(pending).rejects.toThrow(/aborted by caller/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("clears its timer once headers arrive", async () => {
    stubFetch(() => Promise.resolve(new Response("ok")));
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");

    await fetchWithConnectTimeout("https://x/y", {}, 60_000);
    expect(clearSpy).toHaveBeenCalled();
  });
});

describe("connectTimeoutGuard", () => {
  it("reports its own ceiling as a timeout, not as a client cancellation", async () => {
    // chatCore maps AbortError → 499 "client went away" and skips the provider-error
    // path, so a dead upstream must not surface as an abort.
    const guard = connectTimeoutGuard(null, 5);
    const abortError = Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
    await new Promise((resolve) => guard.signal.addEventListener("abort", resolve, { once: true }));

    expect(guard.timedOut).toBe(true);
    const settled = guard.settleError(abortError);
    expect(settled.name).not.toBe("AbortError");
    expect(settled.message).toMatch(/connect timeout/);
    guard.clear();
  });

  it("passes a caller cancellation through untouched", () => {
    const caller = new AbortController();
    const guard = connectTimeoutGuard(caller.signal, 60_000);
    const abortError = Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
    caller.abort();

    expect(guard.timedOut).toBe(false);
    expect(guard.settleError(abortError)).toBe(abortError);
    guard.clear();
  });

  it("does not fire once cleared", async () => {
    const guard = connectTimeoutGuard(null, 5);
    guard.clear();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(guard.timedOut).toBe(false);
    expect(guard.signal.aborted).toBe(false);
  });
});

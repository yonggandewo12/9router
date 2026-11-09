import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("undici keep-alive dead-socket protection & fresh-socket retry", () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...savedEnv };
    delete process.env.FETCH_KEEPALIVE_TIMEOUT_MS;
    delete process.env.UPSTREAM_KEEPALIVE_TIMEOUT_MS;
    delete process.env.UPSTREAM_KEEPALIVE_MAX_MS;
    delete process.env.FETCH_FRESH_RETRY;
    delete process.env.HTTPS_PROXY;
    delete process.env.https_proxy;
    delete process.env.HTTP_PROXY;
    delete process.env.http_proxy;
    delete process.env.ALL_PROXY;
    delete process.env.all_proxy;
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    vi.doUnmock("undici");
  });

  // Upstream 963787f7 caps both values at 4s because some edges (NVIDIA NIM,
  // Cloudflare, AWS Global Accelerator) drop idle sockets WITHOUT a TCP RST, which
  // undici cannot reap. This fork keeps its measured 60s/600s pair — the reuse win
  // is 50-400ms per turn on its gateways, pinned by upstream-keepalive.test.js — and
  // takes upstream's recovery net instead of its cap: the fresh-socket replay below
  // plus BaseExecutor's forceFreshSocket retry after a connect timeout or 502.
  it("keeps the fork's measured idle-socket policy for direct and proxy dispatchers", async () => {
    const { resolveKeepAliveTimeouts } = await import("../../open-sse/config/runtimeConfig.js");

    expect(resolveKeepAliveTimeouts()).toEqual({
      keepAliveTimeout: 60_000,
      keepAliveMaxTimeout: 600_000,
    });
  });

  it("lets an operator restore upstream's 4s cap on a silent-drop edge", async () => {
    process.env.UPSTREAM_KEEPALIVE_TIMEOUT_MS = "4000";
    process.env.UPSTREAM_KEEPALIVE_MAX_MS = "4000";
    const { resolveKeepAliveTimeouts } = await import("../../open-sse/config/runtimeConfig.js");

    expect(resolveKeepAliveTimeouts()).toEqual({
      keepAliveTimeout: 4_000,
      keepAliveMaxTimeout: 4_000,
    });
  });

  it("creates distinct shared direct and fresh-retry dispatchers", async () => {
    const {
      getDirectDispatcher,
      getFreshRetryDispatcher,
      resetDirectDispatchersForTests,
    } = await import("../../open-sse/utils/proxyFetch.js");
    resetDirectDispatchersForTests();

    const direct1 = await getDirectDispatcher(false);
    const direct2 = await getDirectDispatcher(false);
    const fresh1 = await getFreshRetryDispatcher(false);
    const fresh2 = await getFreshRetryDispatcher(false);

    expect(direct1).not.toBeNull();
    expect(direct1).toBe(direct2);
    expect(fresh1).not.toBeNull();
    expect(fresh1).toBe(fresh2);
    expect(fresh1).not.toBe(direct1);
  });

  it("classifies only provable dead-socket errors and excludes aborts/DNS/TLS/bare fetch failed", async () => {
    const { isStaleSocketError } = await import("../../open-sse/utils/proxyFetch.js");

    expect(isStaleSocketError(Object.assign(new Error("fetch failed"), { cause: { code: "UND_ERR_SOCKET" } }))).toBe(true);
    expect(isStaleSocketError(Object.assign(new Error("fetch failed"), { cause: { code: "ECONNRESET" } }))).toBe(true);
    expect(isStaleSocketError(Object.assign(new Error("fetch failed"), { cause: { code: "EPIPE" } }))).toBe(true);
    expect(isStaleSocketError(Object.assign(new Error("fetch failed"), { cause: { code: "UND_ERR_HEADERS_TIMEOUT" } }))).toBe(true);
    expect(isStaleSocketError(Object.assign(new Error("fetch failed"), { cause: new Error("other side closed") }))).toBe(true);
    expect(isStaleSocketError(new Error("socket hang up"))).toBe(true);

    // A bare "fetch failed" with no code is ambiguous: the upstream may already have the
    // request, so replaying it could double-charge. Never treat it as a stale socket.
    expect(isStaleSocketError(new TypeError("fetch failed"))).toBe(false);
    expect(isStaleSocketError(Object.assign(new Error("fetch failed"), { cause: { code: "UND_ERR_INVALID_ARG" } }))).toBe(false);
    expect(isStaleSocketError(Object.assign(new Error("aborted"), { name: "AbortError", cause: { code: "UND_ERR_SOCKET" } }))).toBe(false);
    expect(isStaleSocketError(Object.assign(new Error("fetch failed"), { cause: { code: "ENOTFOUND" } }))).toBe(false);
    expect(isStaleSocketError(Object.assign(new Error("fetch failed"), { cause: { code: "SELF_SIGNED_CERT_IN_CHAIN" } }))).toBe(false);
    expect(isStaleSocketError(null)).toBe(false);
  });

  it("replays once on the fresh-socket dispatcher when a pooled socket dies", async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("fetch failed"), { cause: { code: "UND_ERR_SOCKET" } }))
      .mockResolvedValueOnce({ status: 200, ok: true });
    vi.doMock("undici", async () => {
      const actual = await vi.importActual("undici");
      return { ...actual, fetch: fetchMock };
    });

    const {
      proxyAwareFetch,
      getDirectDispatcher,
      getFreshRetryDispatcher,
      resetDirectDispatchersForTests,
    } = await import("../../open-sse/utils/proxyFetch.js");
    resetDirectDispatchersForTests();

    const res = await proxyAwareFetch("https://integrate.api.nvidia.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer nvapi-test" },
      body: "{}",
    });

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const directDispatcher = await getDirectDispatcher(false);
    const freshDispatcher = await getFreshRetryDispatcher(false);

    expect(fetchMock.mock.calls[0][1].dispatcher).toBe(directDispatcher);
    expect(fetchMock.mock.calls[1][1].dispatcher).toBe(freshDispatcher);
    expect(fetchMock.mock.calls[1][1].headers).toEqual({ Authorization: "Bearer nvapi-test" });
  });

  it("does not replay on the fresh socket when the caller aborted or the body is a locked stream", async () => {
    const fetchMock = vi.fn()
      .mockRejectedValue(Object.assign(new Error("fetch failed"), { cause: { code: "UND_ERR_SOCKET" } }));
    vi.doMock("undici", async () => {
      const actual = await vi.importActual("undici");
      return { ...actual, fetch: fetchMock };
    });

    const { proxyAwareFetch, resetDirectDispatchersForTests } = await import("../../open-sse/utils/proxyFetch.js");
    resetDirectDispatchersForTests();

    const controller = new AbortController();
    controller.abort();
    await expect(
      proxyAwareFetch("https://integrate.api.nvidia.com/v1/chat/completions", {
        method: "POST",
        body: "{}",
        signal: controller.signal,
      })
    ).rejects.toThrow(/fetch failed/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not replay on an ambiguous bare fetch failed (request may have been served)", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    vi.doMock("undici", async () => {
      const actual = await vi.importActual("undici");
      return { ...actual, fetch: fetchMock };
    });

    const { proxyAwareFetch, resetDirectDispatchersForTests } = await import("../../open-sse/utils/proxyFetch.js");
    resetDirectDispatchersForTests();

    await expect(
      proxyAwareFetch("https://integrate.api.nvidia.com/v1/chat/completions", {
        method: "POST",
        body: "{}",
      })
    ).rejects.toThrow(/fetch failed/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not replay when FETCH_FRESH_RETRY=off", async () => {
    process.env.FETCH_FRESH_RETRY = "off";
    const fetchMock = vi.fn()
      .mockRejectedValue(Object.assign(new Error("fetch failed"), { cause: { code: "UND_ERR_SOCKET" } }));
    vi.doMock("undici", async () => {
      const actual = await vi.importActual("undici");
      return { ...actual, fetch: fetchMock };
    });

    const { proxyAwareFetch, resetDirectDispatchersForTests } = await import("../../open-sse/utils/proxyFetch.js");
    resetDirectDispatchersForTests();

    await expect(
      proxyAwareFetch("https://integrate.api.nvidia.com/v1/chat/completions", {
        method: "POST",
        body: "{}",
      })
    ).rejects.toThrow(/fetch failed/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // The image fetch pins a validated IP through options.dispatcher to refuse SSRF
  // (open-sse/translator/concerns/image.js). Replaying on the shared fresh-socket
  // agent would re-resolve DNS and could land on the private address the pin exists
  // to block, so a caller-supplied dispatcher is never swapped.
  it("keeps a caller-pinned dispatcher and does not replay it on a stale socket", async () => {
    const pinned = { dispatch() {} };
    const fetchMock = vi.fn()
      .mockRejectedValue(Object.assign(new Error("fetch failed"), { cause: { code: "UND_ERR_SOCKET" } }));
    vi.doMock("undici", async () => {
      const actual = await vi.importActual("undici");
      return { ...actual, fetch: fetchMock };
    });

    const { proxyAwareFetch, resetDirectDispatchersForTests } = await import("../../open-sse/utils/proxyFetch.js");
    resetDirectDispatchersForTests();

    await expect(
      proxyAwareFetch("https://example.com/image.png", { method: "GET", dispatcher: pinned })
    ).rejects.toThrow(/fetch failed/);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].dispatcher).toBe(pinned);
  });

  it("uses the fresh-socket dispatcher immediately when forceFreshSocket is requested", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({ status: 200, ok: true });
    vi.doMock("undici", async () => {
      const actual = await vi.importActual("undici");
      return { ...actual, fetch: fetchMock };
    });

    const { proxyAwareFetch, getFreshRetryDispatcher, resetDirectDispatchersForTests } = await import("../../open-sse/utils/proxyFetch.js");
    resetDirectDispatchersForTests();

    await proxyAwareFetch(
      "https://integrate.api.nvidia.com/v1/chat/completions",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
      { forceFreshSocket: true }
    );

    const freshDispatcher = await getFreshRetryDispatcher(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].dispatcher).toBe(freshDispatcher);
  });

  it("BaseExecutor.execute sets forceFreshSocket=true when retrying after connect timeout or 502", async () => {
    const fetchMock = vi.fn();
    vi.doMock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: (...args) => fetchMock(...args) }));

    const { BaseExecutor } = await import("../../open-sse/executors/base.js");
    const ex = new BaseExecutor("nvidia", {
      baseUrl: "https://integrate.api.nvidia.com/v1/chat/completions",
      timeoutMs: 15,
      retry: { 502: { attempts: 2, delayMs: 0 } },
    });

    fetchMock
      .mockImplementationOnce((_url, opts) => new Promise((_resolve, reject) => {
        opts.signal.addEventListener("abort", () => {
          const err = new Error("fetch connect timeout");
          err.name = "AbortError";
          reject(err);
        });
      }))
      .mockResolvedValueOnce({ status: 200, headers: { get: () => "application/json" } });

    const out = await ex.execute({
      model: "deepseek-ai/deepseek-v4-flash",
      body: { messages: [] },
      stream: true,
      credentials: { apiKey: "nvapi-key" },
    });

    expect(out.response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][2]).toBeNull();
    expect(fetchMock.mock.calls[1][2]).toEqual({ forceFreshSocket: true });
  });

  it("DefaultExecutor.transformRequest strips stream_options on non-streaming calls without mutating input body", async () => {
    const { DefaultExecutor } = await import("../../open-sse/executors/default.js");
    const ex = new DefaultExecutor("nvidia");
    const input = {
      model: "deepseek-ai/deepseek-v4-flash",
      messages: [{ role: "user", content: "hi" }],
      stream_options: { include_usage: true },
    };

    const nonStreamBody = ex.transformRequest("deepseek-ai/deepseek-v4-flash", input, false, { apiKey: "nvapi-x" });
    expect(nonStreamBody.stream_options).toBeUndefined();
    expect(input.stream_options).toEqual({ include_usage: true });

    const omittedStreamArgBody = ex.transformRequest("deepseek-ai/deepseek-v4-flash", input);
    expect(omittedStreamArgBody.stream_options).toBeUndefined();

    const streamBody = ex.transformRequest("deepseek-ai/deepseek-v4-flash", input, true, { apiKey: "nvapi-x" });
    expect(streamBody.stream_options).toEqual({ include_usage: true });
  });
});

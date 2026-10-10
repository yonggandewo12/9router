/**
 * Codex executors are process-wide singletons, so a request-scoped decision
 * (compact endpoint, prompt-cache session) that lands on `this` is read back by
 * whichever request touches the executor next. Both leaks were user-visible: a
 * normal /responses call right after a compaction POSTed to /responses/compact,
 * and concurrent conversations shared one session_id / prompt_cache_key, which
 * is exactly the affinity knob the cache depends on.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: fetchMock,
}));

import { getExecutor } from "../../open-sse/executors/index.js";
import { readWithTimeout } from "../../open-sse/utils/streamRead.js";

const MODEL = "gpt-5";

function makeCredentials(connectionId = "conn-a") {
  return { accessToken: "tok", connectionId, rawHeaders: {}, providerSpecificData: {} };
}

function bodyFor(promptCacheKey, extra = {}) {
  return {
    model: MODEL,
    input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
    stream: true,
    prompt_cache_key: promptCacheKey,
    ...extra,
  };
}

function sseResponse() {
  return new Response(`data: ${JSON.stringify({ type: "response.output_text.delta", text: "ok" })}\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

const executor = getExecutor("codex");

function sentRequest(callIndex) {
  const [url, init] = fetchMock.mock.calls[callIndex];
  return { url, headers: init.headers, body: JSON.parse(init.body) };
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(() => Promise.resolve(sseResponse()));
});

describe("codex per-execute hookCtx", () => {
  it("keeps the compact endpoint on the call that asked for it", async () => {
    await executor.execute({ model: MODEL, body: bodyFor("conv-a", { _compact: true }), stream: true, credentials: makeCredentials(), log: { debug: vi.fn(), warn: vi.fn() } });
    await executor.execute({ model: MODEL, body: bodyFor("conv-b"), stream: true, credentials: makeCredentials(), log: { debug: vi.fn(), warn: vi.fn() } });

    expect(sentRequest(0).url).toMatch(/\/compact$/);
    expect(sentRequest(1).url).not.toMatch(/\/compact$/);
    expect(sentRequest(1).url).toMatch(/\/responses$/);
  });

  it("never forwards the internal _compact flag", async () => {
    await executor.execute({ model: MODEL, body: bodyFor("conv-a", { _compact: true }), stream: true, credentials: makeCredentials(), log: { debug: vi.fn() } });
    expect(sentRequest(0).body).not.toHaveProperty("_compact");
  });

  // chatCore retries a 401 with the SAME body object after refreshing credentials, and
  // buildUrl runs before transformRequest can strip the flag — so the marker has to stay
  // readable (to pick /compact again) while never reaching JSON.stringify.
  it("keeps /compact across a retry that reuses the body", async () => {
    const compactBody = bodyFor("conv-a", { _compact: true });
    await executor.execute({ model: MODEL, body: compactBody, stream: true, credentials: makeCredentials(), log: { debug: vi.fn() } });
    await executor.execute({ model: MODEL, body: compactBody, stream: true, credentials: makeCredentials(), log: { debug: vi.fn() } });

    expect(sentRequest(0).url).toMatch(/\/compact$/);
    expect(sentRequest(1).url).toMatch(/\/compact$/);
    expect(sentRequest(0).body).not.toHaveProperty("_compact");
    expect(sentRequest(1).body).not.toHaveProperty("_compact");
    expect(JSON.stringify(compactBody)).not.toMatch(/_compact/);
  });

  it("gives each concurrent request its own cache session", async () => {
    await Promise.all([
      executor.execute({ model: MODEL, body: bodyFor("conv-a"), stream: true, credentials: makeCredentials(), log: { debug: vi.fn() } }),
      executor.execute({ model: MODEL, body: bodyFor("conv-b"), stream: true, credentials: makeCredentials("conn-b"), log: { debug: vi.fn() } }),
    ]);

    const [first, second] = [sentRequest(0), sentRequest(1)];
    expect(first.headers.session_id).toBe("conv-a");
    expect(second.headers.session_id).toBe("conv-b");
    expect(first.body.prompt_cache_key).toBe("conv-a");
    expect(second.body.prompt_cache_key).toBe("conv-b");
  });

  it("falls back to a connection-scoped session, not the previous request", async () => {
    const noSession = { model: MODEL, input: "hi", stream: true };
    await executor.execute({ model: MODEL, body: noSession, stream: true, credentials: makeCredentials("conn-a"), log: { debug: vi.fn() } });

    const { headers, body } = sentRequest(fetchMock.mock.calls.length - 1);
    // Earlier calls in this file used conv-a / conv-b; a stale `this` session
    // would show up as one of those here.
    expect(headers.session_id).not.toBe("conv-a");
    expect(headers.session_id).not.toBe("conv-b");
    expect(headers.session_id).toBe(body.prompt_cache_key);
  });

  it("stores no request state on the singleton", async () => {
    await executor.execute({ model: MODEL, body: bodyFor("conv-a", { _compact: true }), stream: true, credentials: makeCredentials(), log: { debug: vi.fn() } });
    expect(executor).not.toHaveProperty("_currentSessionId");
    expect(executor).not.toHaveProperty("_isCompact");
    expect(executor).not.toHaveProperty("sessionId");
  });
});

describe("codex SSE peek is bounded", () => {
  it("propagates the cancellation instead of hanging on a silent stream", async () => {
    const ctrl = new AbortController();
    const stalled = new Response(new ReadableStream({ start() { /* headers arrived, no bytes */ } }), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });

    setTimeout(() => ctrl.abort(new Error("client gone")), 10);
    // The abandoned read() stays pending, so the body cannot be re-locked without
    // risking a dropped chunk — the peek has to surface the cancellation.
    await expect(executor._peekSseTransientError(stalled, ctrl.signal)).rejects.toThrow(/client gone|abort/i);
  }, 2000);

  it("still re-assembles a stream whose read failed outright", async () => {
    const broken = new Response(new ReadableStream({
      start(controller) { controller.error(new Error("socket hang up")); },
    }), { status: 200, headers: { "content-type": "text/event-stream" } });

    const peek = await executor._peekSseTransientError(broken, undefined);
    expect(peek.matched).toBeNull();
    expect(peek.replacementBody).toBeTruthy();
  });

  it("turns a stalled peek into a clean error response, not an open socket", async () => {
    const spy = vi.spyOn(executor, "_peekSseTransientError")
      .mockRejectedValueOnce(new Error("codex sse peek stalled"));

    const result = await executor.execute({ model: MODEL, body: bodyFor("conv-a"), stream: true, credentials: makeCredentials(), log: { debug: vi.fn(), warn: vi.fn() } });
    spy.mockRestore();

    expect(result.response.status).toBe(504);
    expect((await result.response.json()).error.message).toMatch(/stalled/);
  });

  it("readWithTimeout times out on a silent reader", async () => {
    const stream = new ReadableStream({ start() { /* never pushes */ } });
    const reader = stream.getReader();
    await expect(readWithTimeout(reader, null, 5, "peek stalled")).rejects.toThrow("peek stalled");
  }, 2000);
});

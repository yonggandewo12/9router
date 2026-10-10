/**
 * grok-cli put five request-scoped values on the singleton executor
 * (_currentSessionId/_currentReqId/_currentTurnIdx/_agentId/_currentModel), set in
 * transformRequest and read in buildHeaders. BaseExecutor runs those two back to back
 * for one request, so a single call looked fine — but two concurrent calls
 * interleaved, and the second overwrote the first's ids before its headers were
 * built. Upstream that merges two conversations' context, serves the wrong
 * x-grok-model-override, and mis-numbers turns.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: fetchMock,
}));

import { getExecutor } from "../../open-sse/executors/index.js";

const executor = getExecutor("grok-cli");

function sseResponse() {
  return new Response('data: {"type":"response.output_text.delta","text":"ok"}\n\n', {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function body(model, text) {
  return { model, input: [{ type: "message", role: "user", content: text }] };
}

function creds(connectionId, extra = {}) {
  return { accessToken: "tok", connectionId, rawHeaders: {}, providerSpecificData: { ...extra } };
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(() => Promise.resolve(sseResponse()));
});

describe("grok-cli per-execute hookCtx", () => {
  it("gives each concurrent request its own session, model and turn", async () => {
    await Promise.all([
      executor.execute({ model: "grok-4.5", body: body("grok-4.5", "a"), stream: true, credentials: creds("conn-a", { email: "a@x.com", deviceId: "dev-a" }), log: { debug: vi.fn() } }),
      executor.execute({ model: "grok-build", body: body("grok-build", "b"), stream: true, credentials: creds("conn-b", { email: "b@x.com", deviceId: "dev-b" }), log: { debug: vi.fn() } }),
    ]);

    const sent = fetchMock.mock.calls.map(([, init]) => init.headers);
    const models = sent.map(h => h["x-grok-model-override"]).sort();
    expect(models).toEqual(["grok-4.5", "grok-build"]);

    // Each request's identity headers belong to its own connection.
    for (const headers of sent) {
      const isA = headers["x-grok-agent-id"] === "dev-a";
      expect(headers["x-email"]).toBe(isA ? "a@x.com" : "b@x.com");
      expect(headers["x-grok-agent-id"]).toBe(isA ? "dev-a" : "dev-b");
      expect(headers["x-grok-session-id"]).toBe(headers["x-grok-conv-id"]);
      expect(headers["x-grok-session-id"]).toBeTruthy();
      expect(headers["x-grok-req-id"]).toBeTruthy();
      expect(headers["x-grok-turn-idx"]).toBe("1");
    }
    // Two conversations must not share a session id.
    expect(sent[0]["x-grok-session-id"]).not.toBe(sent[1]["x-grok-session-id"]);
    expect(sent[0]["x-grok-req-id"]).not.toBe(sent[1]["x-grok-req-id"]);
  });

  it("still sends an agent id when the connection carries no deviceId", async () => {
    // transformRequest used to overwrite the machine-derived fallback with null, so
    // x-grok-agent-id silently disappeared for OAuth connections without a deviceId.
    await executor.execute({ model: "grok-4.5", body: body("grok-4.5", "hi"), stream: true, credentials: creds("conn-plain"), log: { debug: vi.fn() } });

    const headers = fetchMock.mock.calls[0][1].headers;
    expect(headers["x-grok-agent-id"]).toMatch(/^[0-9a-f-]{20,}$/i);
  });

  it("stores no request state on the singleton", async () => {
    await executor.execute({ model: "grok-4.5", body: body("grok-4.5", "hi"), stream: true, credentials: creds("conn-a"), log: { debug: vi.fn() } });

    for (const field of ["_currentSessionId", "_currentReqId", "_currentTurnIdx", "_agentId", "_currentModel"]) {
      expect(executor).not.toHaveProperty(field);
    }
  });
});

/**
 * Qoder can fail a stream *after* it committed HTTP 200 (queue throttle 10605
 * arrives as a non-200 envelope frame). The executor turns that into an in-band
 * OpenAI error frame; these tests pin the client-visible outcome for the
 * non-streaming chain: wrapQoderSSE → handleNonStreamingResponse.
 * A dropped error frame here means the client gets HTTP 200 with an empty
 * completion and the account stays in rotation.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
}));

const { __test__: { wrapQoderSSE } } = await import("../../open-sse/executors/qoder.js");
const { handleNonStreamingResponse } = await import("../../open-sse/handlers/chatCore/nonStreamingHandler.js");

const OK_ENV = JSON.stringify({ statusCodeValue: 200, body: JSON.stringify({ choices: [{ delta: { content: "partial" } }] }) });
const QUEUE_ENV = JSON.stringify({
  statusCodeValue: 403,
  body: '{"code":"403","message":"{\\"code\\":\\"10605\\",\\"queueCount\\":9711,\\"retryAfterSeconds\\":30}"}',
});

function sseUpstream(...lines) {
  return new Response(new ReadableStream({
    start(c) {
      const enc = new TextEncoder();
      for (const line of lines) c.enqueue(enc.encode(line));
      c.close();
    },
  }));
}

function stubLogger() {
  return { logProviderResponse() {}, logConvertedResponse() {} };
}

async function callHandler(providerResponse) {
  return handleNonStreamingResponse({
    providerResponse,
    provider: "qoder",
    model: "qoder/ultimate",
    sourceFormat: "openai",
    targetFormat: "openai",
    body: { stream: false },
    stream: false,
    translatedBody: null,
    finalBody: null,
    requestStartTime: Date.now(),
    connectionId: "c1",
    apiKey: "k",
    clientRawRequest: null,
    onRequestSuccess: () => {},
    reqLogger: stubLogger(),
    toolNameMap: null,
    customToolNames: null,
    trackDone: () => {},
    appendLog: () => {},
    pxpipe: null,
    reqTag: "t",
    log: null,
  });
}

describe("qoder mid-stream error → non-streaming client", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns an error result instead of a 200 completion", async () => {
    const wrapped = await wrapQoderSSE(sseUpstream(`data: ${OK_ENV}\n\n`, `data: ${QUEUE_ENV}\n\n`), "qoder/ultimate");
    const result = await callHandler(wrapped);

    expect(result.success).toBe(false);
    expect(result.status).toBe(502);
    const body = await result.response.json();
    expect(body.error.message).toContain("10605");
    // the 502 is what makes chatCore cool the connection down and try the next account
    expect(body.choices).toBeUndefined();
  });

  it("still returns the completion when no error frame arrives", async () => {
    const wrapped = await wrapQoderSSE(sseUpstream(`data: ${OK_ENV}\n\n`, "data: [DONE]\n\n"), "qoder/ultimate");
    const result = await callHandler(wrapped);

    expect(result.success).toBe(true);
    const body = await result.response.json();
    expect(body.choices[0].message.content).toBe("partial");
  });
});

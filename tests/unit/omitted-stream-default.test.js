// OpenAI's contract: an omitted `stream` means non-streaming. chatCore used to
// read the omission as "stream" (`body.stream !== false`) while a same-format
// lane forwarded the client body untouched, so the provider was never told to
// stream. The SSE response handler then wrapped the provider's JSON answer in an
// event-stream envelope — 200 + `text/event-stream` + `{...chat.completion...}` +
// `data: [DONE]`, which no JSON or SSE client can parse — and the streaming usage
// accounting saw no deltas, so saveUsageStats dropped the all-zero success row and
// the turn vanished from cost stats. Proven live against bazaarlink on 2026-10-28.
import { describe, it, expect, vi, beforeEach } from "vitest";

const { getExecutorMock } = vi.hoisted(() => ({ getExecutorMock: vi.fn() }));

vi.mock("../../open-sse/executors/index.js", async (importOriginal) => ({
  ...(await importOriginal()),
  getExecutor: getExecutorMock,
}));

vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => ({
    logClientRawRequest: vi.fn(), logRawRequest: vi.fn(), logTargetRequest: vi.fn(),
    logProviderResponse: vi.fn(), logConvertedResponse: vi.fn(), logError: vi.fn(),
  }),
}));

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
}));

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
const { saveRequestUsage } = await import("@/lib/usageDb.js");

// A provider that answers with a single JSON document — what an OpenAI-format
// upstream does when the outbound body carries no `stream: true`.
const JSON_ANSWER = {
  id: "chatcmpl-1",
  object: "chat.completion",
  model: "auto:free",
  choices: [{ index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 86, completion_tokens: 11, total_tokens: 97 },
};

const args = (body, extra = {}) => ({
  body,
  modelInfo: { provider: "bazaarlink", model: "auto:free" },
  credentials: { apiKey: "fake=1", providerSpecificData: {} },
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), line: vi.fn() },
  connectionId: "c1",
  rtkEnabled: false,
  headroomEnabled: false,
  cavemanEnabled: false,
  ponytailEnabled: false,
  // `*/*` on purpose: the Accept-header escape hatch must not be what saves this.
  clientRawRequest: { endpoint: "/v1/chat/completions", body, headers: { accept: "*/*" } },
  ...extra,
});

const messages = [{ role: "user", content: "Reply with the single word: pong" }];

beforeEach(() => {
  vi.clearAllMocks();
  getExecutorMock.mockReturnValue({
    noAuth: true,
    execute: async () => ({
      response: new Response(JSON.stringify(JSON_ANSWER), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      url: "https://bazaarlink.ai/api/v1/chat/completions",
      headers: {},
      transformedBody: null,
    }),
  });
});

describe("an omitted stream field is a non-streaming request", () => {
  it("answers parseable JSON instead of an SSE-wrapped body", async () => {
    const result = await handleChatCore(args({ model: "bzl/auto:free", messages }));

    expect(result.success).toBe(true);
    expect(result.response.headers.get("content-type")).toContain("application/json");
    const text = await result.response.text();
    expect(text).not.toContain("data: [DONE]");
    expect(JSON.parse(text).choices[0].message.content).toBe("pong");
  });

  it("records the turn's usage instead of dropping an all-zero row", async () => {
    await handleChatCore(args({ model: "bzl/auto:free", messages }));

    expect(saveRequestUsage).toHaveBeenCalledOnce();
    expect(saveRequestUsage.mock.calls[0][0]).toMatchObject({
      provider: "bazaarlink",
      tokens: expect.objectContaining({ prompt_tokens: 86, completion_tokens: 11 }),
    });
  });

  it("matches an explicit stream:false", async () => {
    const omitted = await handleChatCore(args({ model: "bzl/auto:free", messages }));
    const explicit = await handleChatCore(args({ model: "bzl/auto:free", messages, stream: false }));

    expect(omitted.response.headers.get("content-type")).toBe(explicit.response.headers.get("content-type"));
  });

  it("still streams for a client that asks for it", async () => {
    getExecutorMock.mockReturnValue({
      noAuth: true,
      execute: async () => ({
        response: new Response(
          `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "pong" } }] })}\n\n`
          + `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: JSON_ANSWER.usage })}\n\n`
          + "data: [DONE]\n\n",
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
        url: "https://bazaarlink.ai/api/v1/chat/completions",
        headers: {},
        transformedBody: null,
      }),
    });

    const result = await handleChatCore(args({ model: "bzl/auto:free", messages, stream: true }));

    expect(result.response.headers.get("content-type")).toContain("text/event-stream");
    const text = await result.response.text();
    expect(text).toContain("pong");
    expect(text).toContain("data: [DONE]");
  });

  // The provider's own SSE answer must still collapse to JSON for this client:
  // fixing the default must not strand a lane that streams no matter what it is
  // sent. nonStreamingHandler's event-stream branch owns that case.
  it("collapses a provider that streamed anyway", async () => {
    getExecutorMock.mockReturnValue({
      noAuth: true,
      execute: async () => ({
        response: new Response(
          `data: ${JSON.stringify({ id: "c", choices: [{ index: 0, delta: { content: "pong" } }] })}\n\n`
          + `data: ${JSON.stringify({ id: "c", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: JSON_ANSWER.usage })}\n\n`
          + "data: [DONE]\n\n",
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
        url: "https://bazaarlink.ai/api/v1/chat/completions",
        headers: {},
        transformedBody: null,
      }),
    });

    const result = await handleChatCore(args({ model: "bzl/auto:free", messages }));

    expect(result.response.headers.get("content-type")).toContain("application/json");
    expect(JSON.parse(await result.response.text()).choices[0].message.content).toBe("pong");
    expect(saveRequestUsage).toHaveBeenCalledOnce();
  });
});

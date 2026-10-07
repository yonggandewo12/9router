import { describe, it, expect, vi, beforeEach } from "vitest";

// Cache breakpoints must survive everything chatCore does AFTER translation.
// prepareClaudeRequest anchors inside translateRequest; the token savers and tool
// normalization then reshape system/tools/messages, and an anchor left pointing at
// pre-mutation bytes costs a full-price cache re-write on every following request.
// Regression guard for the re-anchor-at-dispatch change.

const { executeMock } = vi.hoisted(() => ({ executeMock: vi.fn() }));

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: () => ({ noAuth: true, execute: executeMock }),
}));

vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => ({
    logClientRawRequest: vi.fn(), logRawRequest: vi.fn(), logTargetRequest: vi.fn(),
    logProviderResponse: vi.fn(), logConvertedResponse: vi.fn(), logError: vi.fn(),
  }),
}));

vi.mock("../../open-sse/utils/stream.js", () => ({
  COLORS: { red: "", reset: "" },
  createPassthroughStreamWithLogger: vi.fn(() => new TransformStream()),
}));

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => { }),
  saveRequestDetail: vi.fn(async () => { }),
}));

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");

function sentBody() {
  return executeMock.mock.calls[0][0].body;
}

function markers(list) {
  return list.filter(x => x?.cache_control).length;
}

beforeEach(() => {
  vi.clearAllMocks();
  executeMock.mockResolvedValue({
    response: new Response(JSON.stringify({
      id: "msg_test", object: "chat.completion",
      choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop", index: 0 }],
    }), { status: 200, headers: { "content-type": "application/json" } }),
    url: "https://api.anthropic.com/v1/messages",
    headers: {},
    transformedBody: null,
  });
});

const openaiBody = (extra = {}) => ({
  model: "claude-sonnet-4.5",
  stream: false,
  messages: [
    { role: "system", content: "project rules that never change" },
    { role: "user", content: "hello" },
  ],
  ...extra,
});

const args = (extra = {}) => ({
  body: openaiBody(),
  modelInfo: { provider: "anthropic", model: "claude-sonnet-4.5" },
  credentials: { apiKey: "test-key", providerSpecificData: {} },
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
  connectionId: "test-conn",
  rtkEnabled: false,
  headroomEnabled: false,
  cavemanEnabled: false,
  ponytailEnabled: false,
  clientRawRequest: { endpoint: "/v1/chat/completions", body: {}, headers: { accept: "application/json" } },
  ...extra,
});

describe("handleChatCore cache anchoring (translated path)", () => {
  it("anchors system caching on the tail block even when a saver appends after translation", async () => {
    await handleChatCore(args({ cavemanEnabled: true, cavemanLevel: "lite" }));

    const body = sentBody();
    expect(Array.isArray(body.system)).toBe(true);
    // Exactly one breakpoint, and it is the LAST block — an injected prompt must
    // not end up wedged in front of the marker, which moves the cached bytes.
    expect(markers(body.system)).toBe(1);
    expect(body.system[body.system.length - 1].cache_control).toBeDefined();
    expect(body.system.some(b => b?.text?.includes("project rules"))).toBe(true);
  });

  it("keeps the tool breakpoint on the last tool when tools are declared", async () => {
    await handleChatCore(args({
      body: openaiBody({
        tools: [
          { type: "function", function: { name: "read_file", description: "d", parameters: { type: "object", properties: {} } } },
          { type: "function", function: { name: "write_file", description: "d", parameters: { type: "object", properties: {} } }, cache_control: { type: "ephemeral" } },
        ],
      }),
    }));

    const body = sentBody();
    expect(body.tools).toHaveLength(2);
    expect(markers(body.tools)).toBe(1);
    expect(body.tools[body.tools.length - 1].cache_control).toBeDefined();
  });

  it("reports the local prep split so provider latency and self latency are separable", async () => {
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), line: vi.fn(), errorLine: vi.fn() };
    await handleChatCore(args({ log }));

    const done = log.line.mock.calls.filter(c => c[2]?.startsWith?.("DONE"));
    expect(done.length).toBeGreaterThan(0);
    expect(done[0][2]).toMatch(/PREP \d+ms/);
  });
});

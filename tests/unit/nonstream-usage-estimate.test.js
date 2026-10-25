// A non-streaming turn used to be billed only from `body.usage`. Providers that
// answer without a usage block — every web-cookie lane, DeepSeek/ChatGPT among
// them — returned 0/0, and saveUsageStats drops an all-zero success row, so the
// turn appeared in neither the Usage panel nor the cost totals while the
// streaming path (which estimates) recorded the same turn normally. These tests
// pin the estimate fallback, live-verified against a packaged build.
import { describe, expect, it, beforeEach, vi } from "vitest";

vi.mock("@/lib/localDb", () => ({ getApiKeys: vi.fn(async () => [{ key: "test-key", isActive: true }]) }));
vi.mock("@/shared/constants/config", () => ({ UPDATER_CONFIG: { appPort: 20127 } }));
vi.mock("@/shared/utils/machineId", () => ({ getConsistentMachineId: vi.fn(async () => "cli-token") }));
vi.mock("@/lib/usageDb.js", () => ({
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
}));

const { handleNonStreamingResponse } = await import("../../open-sse/handlers/chatCore/nonStreamingHandler.js");
const { saveRequestUsage } = await import("@/lib/usageDb.js");

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function call(responseBody, body = { stream: false, messages: [{ role: "user", content: "say ok" }] }, formats = {}) {
  return handleNonStreamingResponse({
    providerResponse: jsonResponse(responseBody),
    provider: "deepseek-web",
    model: "deepseek-v4-pro",
    sourceFormat: formats.sourceFormat || "openai",
    targetFormat: formats.targetFormat || "openai",
    body,
    stream: false,
    translatedBody: null,
    finalBody: null,
    requestStartTime: Date.now(),
    connectionId: "c1",
    apiKey: "k",
    clientRawRequest: null,
    onRequestSuccess: () => {},
    reqLogger: { logProviderResponse() {}, logConvertedResponse() {} },
    toolNameMap: null,
    customToolNames: null,
    trackDone: () => {},
    pxpipe: null,
    reqTag: "t",
    log: null,
  });
}

function recordedUsage() {
  expect(saveRequestUsage).toHaveBeenCalledTimes(1);
  return saveRequestUsage.mock.calls[0][0].tokens;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("non-streaming usage when the upstream reports none", () => {
  it("estimates instead of silently dropping the turn", async () => {
    const result = await call({ choices: [{ message: { role: "assistant", content: "ok" } }] });
    expect(result.success).toBe(true);

    const tokens = recordedUsage();
    expect(tokens.prompt_tokens).toBeGreaterThan(0);
    expect(tokens.completion_tokens).toBeGreaterThan(0);
    expect(tokens.total_tokens).toBe(tokens.prompt_tokens + tokens.completion_tokens);

    // The client sees the same estimate plus the +2000 context headroom, exactly
    // like a streaming turn of the same model — not 2000/0 for a billed turn.
    const body = await result.response.json();
    expect(body.usage.prompt_tokens).toBe(tokens.prompt_tokens + 2000);
    expect(body.usage.completion_tokens).toBe(tokens.completion_tokens);
  });

  it("treats an all-zero usage block as missing (the shape web executors return)", async () => {
    await call({
      choices: [{ message: { role: "assistant", content: "ok" } }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
    expect(recordedUsage().completion_tokens).toBeGreaterThan(0);
  });

  it("bills thinking and tool calls, not only the visible text", async () => {
    await call({
      choices: [{
        message: {
          role: "assistant",
          content: "",
          reasoning_content: "a".repeat(400),
          tool_calls: [{ id: "1", function: { name: "read_file", arguments: "{\"path\":\"a.js\"}" } }],
        },
      }],
    });
    expect(recordedUsage().completion_tokens).toBeGreaterThan(100);
  });

  it("keeps real upstream usage untouched", async () => {
    await call({
      choices: [{ message: { role: "assistant", content: "ok" } }],
      usage: { prompt_tokens: 4242, completion_tokens: 77, total_tokens: 4319 },
    });
    const tokens = recordedUsage();
    expect(tokens).toMatchObject({ prompt_tokens: 4242, completion_tokens: 77 });
    expect(tokens.estimated).toBeUndefined();

    // Only the client envelope gets the +2000 context headroom buffer.
    const body = await (await call({
      choices: [{ message: { role: "assistant", content: "ok" } }],
      usage: { prompt_tokens: 4242, completion_tokens: 77, total_tokens: 4319 },
    })).response.json();
    expect(body.usage.prompt_tokens).toBe(6242);
  });

  it("reports the estimate in the client's own field names", async () => {
    // In this handler `sourceFormat` is the format the CLIENT asked for. A
    // Claude client that gets an OpenAI-shaped completion still reads
    // input_tokens; filtering the estimate by the wrong format would strip every
    // count and leave `{estimated:true}` — worse than no usage at all.
    const result = await call(
      { choices: [{ message: { role: "assistant", content: "ok" } }], usage: { prompt_tokens: 0, completion_tokens: 0 } },
      { stream: false, messages: [{ role: "user", content: "say ok" }] },
      { sourceFormat: "claude", targetFormat: "openai" }
    );
    const body = await result.response.json();
    expect(body.usage.input_tokens).toBeGreaterThan(2000);
    expect(body.usage.output_tokens).toBeGreaterThan(0);
    expect(body.usage.prompt_tokens).toBeUndefined();

    // The ledger is canonical OpenAI either way.
    const tokens = recordedUsage();
    expect(tokens.prompt_tokens).toBeGreaterThan(0);
    expect(tokens.completion_tokens).toBeGreaterThan(0);
  });

  it("leaves a body shape it does not recognize alone", async () => {
    // A Gemini body reports usageMetadata, not usage: no choices, not a Claude
    // message — nothing here to attach a prompt_tokens block to.
    const result = await call(
      { candidates: [{ content: { parts: [{ text: "ok" }] } }] },
      { stream: false, messages: [{ role: "user", content: "say ok" }] },
      { sourceFormat: "gemini", targetFormat: "gemini" }
    );
    const body = await result.response.json();
    expect(body.candidates).toBeDefined();
    expect(body.usage).toBeUndefined();
  });

  it("estimates from a Claude-shaped answer too", async () => {
    await call(
      { type: "message", role: "assistant", content: [{ type: "text", text: "a".repeat(400) }], stop_reason: "end_turn" },
      { stream: false, messages: [{ role: "user", content: "say ok" }] },
      { sourceFormat: "claude", targetFormat: "claude" }
    );
    // 400 chars of answer ≈ 100 output tokens; the OpenAI-only reader would
    // have reported 0 and dropped the row entirely.
    expect(recordedUsage().completion_tokens).toBeGreaterThan(50);
  });
});

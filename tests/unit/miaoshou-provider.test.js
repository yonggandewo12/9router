// 妙手 (CatPaw) lane — registry/executor unit coverage.
//
// Wire facts and their evidence live in open-sse/providers/registry/miaoshou.js
// and open-sse/executors/miaoshou.js; this file pins the behaviour those
// comments promise so a refactor cannot quietly break the protocol.
import { describe, expect, it, vi, beforeEach } from "vitest";

// reportDone/stopTurn fire proxyAwareFetch from the streaming paths under test;
// mock it so no test ever touches the real upstream.
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 })),
}));

import REGISTRY from "../../open-sse/providers/registry/index.js";
import { PROVIDERS, PROVIDER_MODELS } from "../../open-sse/providers/index.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { getModelMeta } from "../../open-sse/config/providerModels.js";
import { parseModel, resolveProviderAlias } from "../../open-sse/services/model.js";
import { getExecutor, hasSpecializedExecutor } from "../../open-sse/executors/index.js";
import {
  extractMiaoshouToken,
  toMiaoshouMessages,
  toToolConfigs,
  planTurn,
  CATPAW_BUILTIN_TOOLS,
  __internal__,
} from "../../open-sse/executors/miaoshou.js";
import {
  tokenFromProcessEnv,
  __internal__ as credInternal,
} from "../../open-sse/shared/miaoshou/credentials.js";
import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";

const TOKEN = "AgGEIIJcTestPassportToken";

describe("妙手 (CatPaw) provider", () => {
  const entry = REGISTRY.find((candidate) => candidate.id === "miaoshou");

  it("is registered with an alias that resolves both ways", () => {
    expect(entry).toBeTruthy();
    expect(entry.alias).toBe("ms");
    expect(resolveProviderAlias("ms")).toBe("miaoshou");
    expect(resolveProviderAlias("miaoshou")).toBe("miaoshou");
    expect(resolveProviderAlias("catpaw")).toBe("miaoshou");
    expect(parseModel("ms/glm-5.3")).toEqual({
      provider: "miaoshou",
      model: "glm-5.3",
      isAlias: false,
      providerAlias: "ms",
    });
  });

  it("publishes transport + models for the runtime tables", () => {
    expect(PROVIDERS.miaoshou.baseUrl).toBe("https://ai.catpaw.meituan.com/api/agent/conversation/turn");
    expect(PROVIDERS.miaoshou.forceStream).toBe(true);
    const models = PROVIDER_MODELS.ms;
    expect(models.length).toBeGreaterThan(0);
    expect(models.map((m) => m.id)).toContain("longcat-2.5");
    // Every model must carry the upstream numeric id — the turn body has no
    // other way to name a model.
    for (const model of models) {
      expect(Number.isFinite(Number(model.modelType))).toBe(true);
    }
  });

  it("uses the specialized executor", () => {
    expect(hasSpecializedExecutor("miaoshou")).toBe(true);
    expect(hasSpecializedExecutor("ms")).toBe(true);
    expect(getExecutor("miaoshou").provider).toBe("miaoshou");
  });

  it("declares vision per model but no thinking knob", () => {
    expect(getCapabilitiesForModel("miaoshou", "longcat-2.5").vision).toBe(true);
    expect(getCapabilitiesForModel("miaoshou", "minimax-m3").vision).toBe(false);
    // The gateway decides when to think; advertising control would be a lie.
    expect(getCapabilitiesForModel("miaoshou", "glm-5.3").reasoning).toBe(false);
  });

  // The ceilings are read back from the upstream's own per-turn `contextInfo`
  // (measured 2026-11-05 for every routable row), NOT guessed: they differ by
  // 5x across the catalog, and capacityAdapter trims history against them.
  it("reports the measured per-model context window and output ceiling", () => {
    const expected = {
      "longcat-2.5": [204800, 32768],
      "longcat-2.0": [204800, 32768],
      "glm-5.3": [204800, 32000],
      "glm-5.3-flash": [204800, 32000],
      "glm-5.3-flashx": [204800, 32000],
      "deepseek-v4.1-flash": [1024000, 32768],
      "deepseek-v4-pro": [204800, 32768],
      "minimax-m3": [921600, 32768],
      "kimi-k3.1-pro": [900000, 32768],
      "kimi-k3": [204800, 32000],
      auto: [204800, 32000],
    };
    for (const [id, [contextLength, maxOutputTokens]] of Object.entries(expected)) {
      const meta = getModelMeta("ms", id);
      expect([meta.contextLength, meta.maxOutputTokens], id).toEqual([contextLength, maxOutputTokens]);
      const caps = getCapabilitiesForModel("miaoshou", id);
      expect([caps.contextWindow, caps.maxOutput], `${id} capabilities`).toEqual([contextLength, maxOutputTokens]);
    }
  });

  it("resolves the upstream numeric model id for every catalog row", () => {
    const meta = getModelMeta("ms", "glm-5.3");
    expect(meta?.modelType).toBe(89);
    expect(__internal__.modelEntryOf("longcat-2.5").modelType).toBe(10002544);
    expect(__internal__.modelEntryOf("nope")).toBeNull();
  });
});

describe("妙手 credential parsing", () => {
  it("accepts a bare token", () => {
    expect(extractMiaoshouToken({ apiKey: TOKEN })).toBe(TOKEN);
  });

  it("accepts a cookie header and a single name=value pair", () => {
    expect(extractMiaoshouToken({ apiKey: `Cookie: X-Passport-Token=${TOKEN}` })).toBe(TOKEN);
    expect(extractMiaoshouToken({ apiKey: `X-Passport-Token=${TOKEN}` })).toBe(TOKEN);
    expect(extractMiaoshouToken({ apiKey: `other=1; X-Passport-Token=${TOKEN}; more=2` })).toBe(TOKEN);
  });

  it("reads providerSpecificData.cookie and returns empty for nothing", () => {
    expect(extractMiaoshouToken({ providerSpecificData: { cookie: TOKEN } })).toBe(TOKEN);
    expect(extractMiaoshouToken({})).toBe("");
    expect(extractMiaoshouToken(null)).toBe("");
  });

  it("decodes the CLI's CATPAW_CONFIG_CONTENT env blob", () => {
    const config = JSON.stringify({
      cookie: `X-Passport-Token=${TOKEN}`,
      authTokens: { "x-passport-token": TOKEN },
      baseURL: "https://ai.catpaw.meituan.com",
      mcpServers: { x: { command: "/Applications/妙手.app/Contents/MacOS/妙手" } },
    });
    const psLine = `1234 /path/catpaw-cli server CATPAW_CONFIG_CONTENT=${config} OTHER=value`;
    expect(tokenFromProcessEnv(psLine)).toBe(TOKEN);
    expect(credInternal.TOKEN_ENV).toBe("CATPAW_CONFIG_CONTENT");
  });

  it("returns empty for a non-JSON or unrelated process line", () => {
    expect(tokenFromProcessEnv("1234 catpaw-cli server OTHER=1")).toBe("");
    expect(tokenFromProcessEnv(`CATPAW_CONFIG_CONTENT={oops`)).toBe("");
  });
});

describe("妙手 message conversion", () => {
  it("drops system prompts and reports them separately", () => {
    const messages = [
      { role: "system", content: "be brief" },
      { role: "user", content: "hi" },
    ];
    expect(__internal__.collectSystemPrompt(messages)).toBe("be brief");
    expect(toMiaoshouMessages(messages).map((m) => m.type)).toEqual(["user"]);
  });

  it("maps user text and images into blocks", () => {
    const converted = toMiaoshouMessages([
      {
        role: "user",
        content: [
          { type: "text", text: "what color" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
        ],
      },
    ]);
    expect(converted[0].content).toEqual([
      { type: "text", text: "what color" },
      { type: "image_url", imageUrl: { url: "data:image/png;base64,AAAA", detail: "auto" } },
    ]);
  });

  it("turns OpenAI tool_calls into sibling tool_use blocks and tool turns into tool_result", () => {
    const converted = toMiaoshouMessages([
      { role: "user", content: "weather?" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"北京"}' } }],
      },
      { role: "tool", tool_call_id: "call_1", name: "get_weather", content: '{"temp":18}' },
    ]);
    expect(converted.map((m) => m.type)).toEqual(["user", "assistant", "tool"]);
    expect(converted[1].content).toEqual([
      { type: "tool_use", toolCallId: "call_1", toolName: "get_weather", toolParams: '{"city":"北京"}' },
    ]);
    expect(converted[2].content[0]).toMatchObject({
      type: "tool_result",
      toolCallId: "call_1",
      toolName: "get_weather",
      toolResult: '{"temp":18}',
    });
  });

  it("gives every message a fresh id (the gateway answers 431 on reuse)", () => {
    const a = toMiaoshouMessages([{ role: "user", content: "one" }]);
    const b = toMiaoshouMessages([{ role: "user", content: "two" }]);
    expect(a[0].messageId).not.toBe(b[0].messageId);
  });

  it("maps OpenAI tools to fromClient toolConfigs", () => {
    const configs = toToolConfigs([
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Get weather",
          parameters: { type: "object", properties: { city: { type: "string" } } },
        },
      },
      { type: "function", function: { name: "" } },
    ]);
    expect(configs).toEqual([
      {
        name: "get_weather",
        enable: true,
        fromClient: true,
        description: "Get weather",
        inputSchema: { type: "object", properties: { city: { type: "string" } } },
      },
    ]);
    expect(toToolConfigs(undefined)).toEqual([]);
  });
});

describe("妙手 built-in tool surface", () => {
  const { toolConfigsWithBuiltinsOff } = __internal__;

  it("switches the gateway's own agent tools off", () => {
    // Without these the upstream answers turns with tool calls for tools the
    // client never declared (measured: web_search, bash).
    const configs = toolConfigsWithBuiltinsOff([]);
    expect(configs).toHaveLength(CATPAW_BUILTIN_TOOLS.length);
    for (const config of configs) expect(config.enable).toBe(false);
    expect(configs.map((c) => c.name)).toEqual(
      expect.arrayContaining(["web_search", "web_fetch", "bash", "read_file", "run_terminal_cmd", "task"]),
    );
  });

  it("keeps client tools enabled and never contradicts one", () => {
    const configs = toolConfigsWithBuiltinsOff([
      { type: "function", function: { name: "get_weather", description: "d", parameters: { type: "object" } } },
      // A client that owns a built-in name must win: no enable:false twin.
      { type: "function", function: { name: "bash" } },
    ]);
    expect(configs.filter((c) => c.name === "bash")).toEqual([
      { name: "bash", enable: true, fromClient: true },
    ]);
    expect(configs.find((c) => c.name === "get_weather")).toMatchObject({ enable: true, fromClient: true });
    expect(configs.filter((c) => c.enable === false)).toHaveLength(CATPAW_BUILTIN_TOOLS.length - 1);
  });
});

describe("妙手 upstream failure status mapping", () => {
  // Captured 2026-11-05: every conversation endpoint reports business failures
  // as an HTTP 200 envelope, and /turn reports them in-band as an SSE frame.
  const envelope400 = { unifyCode: 1005010001, code: 400, msg: "消息列表的最后一条必须是 user 类型，实际是: assistant", success: false };
  const frame400 = { conversationId: "c", error: { code: 400, unifyCode: 1005010001, message: "会话未在执行中" } };
  const deadToken = { unifyCode: 1003010001, code: 401, msg: "passport auth failed: 请重新登录", data: null, success: false };

  const { upstreamStatus } = __internal__;

  it("keeps a request-scoped refusal a 4xx instead of a 502", () => {
    // 502 is unmatched by ERROR_RULES, so it would cool a healthy account down.
    expect(upstreamStatus(200, envelope400)).toBe(400);
    expect(upstreamStatus(200, frame400)).toBe(400);
    expect(upstreamStatus(431, { code: 431, msg: "消息已存在" })).toBe(431);
  });

  it("reads the auth failure from the status, the envelope and the frame", () => {
    expect(upstreamStatus(401, deadToken)).toBe(401);
    // A dead passport token delivered inside an HTTP 200 envelope is still auth.
    expect(upstreamStatus(200, deadToken)).toBe(401);
    expect(upstreamStatus(200, { error: { code: 401, unifyCode: 1003010001, message: "请重新登录" } })).toBe(401);
  });

  it("falls back to 502 only when the upstream gave no usable code", () => {
    expect(upstreamStatus(200, null)).toBe(502);
    expect(upstreamStatus(200, { success: false, msg: "boom" })).toBe(502);
    expect(upstreamStatus(503, "not json")).toBe(503);
  });
});

describe("妙手 turn planning", () => {
  it("splits the trailing user turn off the replay", () => {
    const converted = toMiaoshouMessages([
      { role: "user", content: "one" },
      { role: "assistant", content: "two" },
      { role: "user", content: "three" },
    ]);
    const { replay, prompt } = planTurn(converted);
    expect(replay.map((m) => m.type)).toEqual(["user", "assistant"]);
    expect(prompt.content[0].text).toBe("three");
  });

  it("drops a trailing assistant so the round body still ends in user", () => {
    const converted = toMiaoshouMessages([
      { role: "user", content: "one" },
      { role: "assistant", content: "partial answer" },
    ]);
    const { replay, prompt } = planTurn(converted);
    // The gateway only replays user/assistant/tool turns and generates the next
    // assistant message, so a trailing assistant is dropped, not re-sent.
    expect(replay).toEqual([]);
    expect(prompt.content[0].text).toBe("one");
  });

  it("appends a synthetic user turn when the history ends in a tool result", () => {
    const converted = toMiaoshouMessages([
      { role: "user", content: "weather?" },
      {
        role: "assistant",
        tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "call_1", name: "get_weather", content: '{"temp":18}' },
    ]);
    const { replay, prompt } = planTurn(converted);
    expect(replay.map((m) => m.type)).toEqual(["user", "assistant", "tool"]);
    expect(prompt.type).toBe("user");
    // The gateway rejects a message list whose last entry is `tool`.
    expect(replay[replay.length - 1].type).toBe("tool");
    expect(prompt.content[0].text.length).toBeGreaterThan(0);
  });
});

// ── Streaming paths ────────────────────────────────────────────────────────
// streamResponse/jsonBodyResponse are the highest-risk code in the lane: the
// upstream answers SSE frames that carry the WHOLE message so far (cumulative
// text, cumulative tool args, usage on its own frame), and everything the
// client sees is produced by diffing those. These tests pin that diffing.

const fetchMock = () => vi.mocked(proxyAwareFetch);

function sseBody(frames) {
  const text = frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("") + "data: [DONE]\n\n";
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

async function readChunks(stream) {
  const text = await new Response(stream).text();
  return text
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter((payload) => payload && payload !== "[DONE]")
    .map((payload) => JSON.parse(payload));
}

const STREAM_CTX = () => ({
  model: "glm-5.3",
  conversationId: "conv-test",
  turnRequestId: "turn-test",
  token: TOKEN,
  proxyOptions: null,
  clientSignal: undefined,
  log: null,
});

const upstreamCalls = (needle) =>
  fetchMock().mock.calls.filter(([url]) => String(url).includes(needle));

describe("妙手 streaming (cumulative frame diffing)", () => {
  beforeEach(() => {
    fetchMock().mockClear();
  });

  it("diffs cumulative text frames into content deltas", async () => {
    const frames = [
      { message: { content: [{ type: "text", text: "你好" }] } },
      { message: { content: [{ type: "text", text: "你好，世界" }], finished: true } },
    ];
    const chunks = await readChunks(__internal__.streamResponse(sseBody(frames), STREAM_CTX()));

    const content = chunks
      .map((c) => c.choices?.[0]?.delta?.content)
      .filter(Boolean)
      .join("");
    expect(content).toBe("你好，世界");
    // Role chunk first, plain stop finish last.
    expect(chunks[0].choices[0].delta.role).toBe("assistant");
    expect(chunks[chunks.length - 1].choices[0].finish_reason).toBe("stop");
  });

  it("emits reasoning_content deltas from block reasoningContent", async () => {
    const frames = [
      { message: { content: [{ type: "text", text: "", reasoningContent: "思考" }] } },
      { message: { content: [{ type: "text", text: "回答", reasoningContent: "思考完毕" }], finished: true } },
    ];
    const chunks = await readChunks(__internal__.streamResponse(sseBody(frames), STREAM_CTX()));

    const reasoning = chunks
      .map((c) => c.choices?.[0]?.delta?.reasoning_content)
      .filter(Boolean)
      .join("");
    expect(reasoning).toBe("思考完毕");
    const content = chunks
      .map((c) => c.choices?.[0]?.delta?.content)
      .filter(Boolean)
      .join("");
    expect(content).toBe("回答");
  });

  it("folds cache_read_tokens back into prompt_tokens on the final chunk", async () => {
    const frames = [
      { message: { content: [{ type: "text", text: "hi", finished: true }] } },
      // A warm session answers the UNCACHED prompt in prompt_tokens and keeps
      // the hits in cache_read_tokens (measured 171 + 19456).
      { contextInfo: { usage: { prompt_tokens: 171, cache_read_tokens: 19456, completion_tokens: 5 } } },
    ];
    const chunks = await readChunks(__internal__.streamResponse(sseBody(frames), STREAM_CTX()));

    expect(chunks[chunks.length - 1].usage).toEqual({
      prompt_tokens: 19627,
      completion_tokens: 5,
      total_tokens: 19632,
      prompt_tokens_details: { cached_tokens: 19456 },
    });
  });

  it("streams cumulative tool args as incremental deltas with a stable index", async () => {
    const block = (toolParams) => ({
      type: "tool_use",
      toolCallId: "call_1",
      toolName: "get_weather",
      toolParams,
    });
    const frames = [
      { message: { content: [block("")] } },
      { message: { content: [block('{"city":')] } },
      { message: { content: [block('{"city": "北京"}')], finished: true } },
    ];
    const chunks = await readChunks(__internal__.streamResponse(sseBody(frames), STREAM_CTX()));

    const toolChunks = chunks.filter((c) => c.choices?.[0]?.delta?.tool_calls);
    const first = toolChunks[0].choices[0].delta.tool_calls[0];
    expect(first.id).toBe("call_1");
    expect(first.type).toBe("function");
    expect(first.function.name).toBe("get_weather");

    const args = toolChunks
      .map((c) => c.choices[0].delta.tool_calls[0].function.arguments)
      .join("");
    expect(args).toBe('{"city": "北京"}');
    // One index per tool, reused across every delta (OpenAI streaming contract).
    expect(new Set(toolChunks.map((c) => c.choices[0].delta.tool_calls[0].index))).toEqual(new Set([0]));

    // A turn that produced tool_use must finish as "tool_calls" or the client
    // never runs the tool.
    expect(chunks[chunks.length - 1].choices[0].finish_reason).toBe("tool_calls");
  });

  it("assigns each concurrent tool its own index", async () => {
    const frames = [
      {
        message: {
          content: [
            { type: "tool_use", toolCallId: "call_a", toolName: "read", toolParams: "{}" },
            { type: "tool_use", toolCallId: "call_b", toolName: "grep", toolParams: "{}" },
          ],
          finished: true,
        },
      },
    ];
    const chunks = await readChunks(__internal__.streamResponse(sseBody(frames), STREAM_CTX()));

    const toolChunks = chunks.filter((c) => c.choices?.[0]?.delta?.tool_calls);
    // First-sighting chunks carry the id; the arg deltas that follow (same
    // frame, full args available immediately) only carry index + arguments.
    const sightings = toolChunks.filter((c) => c.choices[0].delta.tool_calls[0].id);
    const ids = sightings.map((c) => c.choices[0].delta.tool_calls[0].id);
    expect(ids).toEqual(["call_a", "call_b"]);
    const indices = sightings.map((c) => c.choices[0].delta.tool_calls[0].index);
    expect(indices).toEqual([0, 1]);
  });

  it("reports an in-band error frame as a choices-less chunk, not a normal finish", async () => {
    const frames = [{ error: { code: 400, unifyCode: 1005010001, message: "会话未在执行中" } }];
    const chunks = await readChunks(__internal__.streamResponse(sseBody(frames), STREAM_CTX()));

    // fail() opens with the role chunk, then the choices-less error chunk.
    expect(chunks).toHaveLength(2);
    expect(chunks[0].choices[0].delta.role).toBe("assistant");
    const errorChunk = chunks[1];
    expect(errorChunk.choices).toEqual([]);
    expect(errorChunk.error.code).toBe(1005010001);
    expect(errorChunk.error.status).toBe(400);
    expect(errorChunk.error.message).toContain("会话未在执行中");
  });

  it("ends cleanly (stop, no error chunk) when the client signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const frames = [{ message: { content: [{ type: "text", text: "never read", finished: true }] } }];

    const chunks = await readChunks(
      __internal__.streamResponse(sseBody(frames), { ...STREAM_CTX(), clientSignal: controller.signal }),
    );

    // readFrames breaks before the first read: role + finish only.
    expect(chunks).toHaveLength(2);
    expect(chunks[1].choices[0].finish_reason).toBe("stop");
  });

  it("marks the upstream terminal exactly once on a completed turn", async () => {
    const frames = [{ message: { content: [{ type: "text", text: "ok", finished: true }] } }];
    await readChunks(__internal__.streamResponse(sseBody(frames), STREAM_CTX()));

    const events = upstreamCalls("/api/agent/conversation/event");
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0][1].body).data.status).toBe("completed");
    // A turn nobody aborted must never be stopped.
    expect(upstreamCalls("/api/agent/conversation/turn/stop")).toHaveLength(0);
  });

  it("fires stop + canceled exactly once when the consumer cancels before reading", async () => {
    const frames = [{ message: { content: [{ type: "text", text: "half", finished: true }] } }];
    const stream = __internal__.streamResponse(sseBody(frames), STREAM_CTX());
    // cancel() and start()'s finally both run on a disconnect — the terminal
    // flags must collapse them into one stop and one canceled event.
    await stream.cancel();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(upstreamCalls("/api/agent/conversation/turn/stop")).toHaveLength(1);
    const events = upstreamCalls("/api/agent/conversation/event");
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0][1].body).data.status).toBe("canceled");
  });
});

describe("妙手 non-streaming fold (jsonBodyResponse)", () => {
  beforeEach(() => {
    fetchMock().mockClear();
  });

  it("folds cumulative text frames into one completion", async () => {
    const frames = [
      { message: { content: [{ type: "text", text: "你好" }] } },
      { message: { content: [{ type: "text", text: "你好，世界" }], finished: true } },
    ];
    const { status, body } = await __internal__.jsonBodyResponse(sseBody(frames), STREAM_CTX());

    expect(status).toBe(200);
    expect(body.choices[0].message.content).toBe("你好，世界");
    expect(body.choices[0].message.role).toBe("assistant");
    expect(body.choices[0].finish_reason).toBe("stop");
  });

  it("reports null content for a pure tool-call turn and tool_calls finish", async () => {
    const frames = [
      {
        message: {
          content: [{ type: "tool_use", toolCallId: "call_9", toolName: "search", toolParams: '{"q":"x"}' }],
          finished: true,
        },
        contextInfo: { usage: { prompt_tokens: 10, cache_read_tokens: 0, completion_tokens: 3 } },
      },
    ];
    const { status, body } = await __internal__.jsonBodyResponse(sseBody(frames), STREAM_CTX());

    expect(status).toBe(200);
    // OpenAI clients expect null (not "") when the turn is a pure tool call.
    expect(body.choices[0].message.content).toBeNull();
    expect(body.choices[0].message.tool_calls).toEqual([
      { id: "call_9", type: "function", function: { name: "search", arguments: '{"q":"x"}' } },
    ]);
    expect(body.choices[0].finish_reason).toBe("tool_calls");
    expect(body.usage).toEqual({ prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 });
  });

  it("returns the mapped status for an in-band error instead of HTTP 200", async () => {
    const frames = [{ error: { code: 400, unifyCode: 1005010001, message: "会话未在执行中" } }];
    const { status, body } = await __internal__.jsonBodyResponse(sseBody(frames), STREAM_CTX());

    expect(status).toBe(400);
    expect(body.error.message).toContain("会话未在执行中");
    expect(body.error.code).toBe(1005010001);
  });
});

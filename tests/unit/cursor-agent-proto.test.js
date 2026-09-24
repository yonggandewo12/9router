import { describe, expect, it } from "vitest";
import {
  decodeMessage,
  encodeField,
  encodeMcpTool,
  buildChatRequest,
  encodeToolResult,
  buildToolResultRequest,
  generateToolResultBody,
  extractTextFromResponse,
  parseConnectRPCFrame,
} from "../../open-sse/utils/cursorProtobuf.js";
import {
  buildAgentRunFrame,
  isAgentCapableRequest,
  CursorExecutor,
} from "../../open-sse/executors/cursor.js";

// Cursor protocol codec tests — validate what the production code actually speaks:
//   * ChatService (api2.cursor.sh): StreamUnifiedChat* protos in cursorProtobuf.js.
//   * AgentService (agent.v1): the run frame built by cursor.js. It carries text,
//     declared MCP tool schemas (field 4) and tool-call history; only image parts
//     still need the legacy protobuf path (see cursor.js isAgentCapableRequest).
// Field numbers verified against the encoders themselves and Cursor's protos.
// Pure round-trip, no network.

const LEN = 2;
const VARINT = 0;

const str = (value) => Buffer.from(value).toString("utf8");
const bytes = (value) => Buffer.from(value);

// ==================== ChatService: MCP tool declarations ====================

describe("Cursor ChatService MCP tool codec (cursorProtobuf.js)", () => {
  it("encodes MCPTool: name(1), description(2), parameters JSON(3), server(4)", () => {
    const schema = { type: "object", properties: { city: { type: "string" } }, required: ["city"] };
    const tool = encodeMcpTool({ function: { name: "get_weather", description: "Get weather", parameters: schema } });
    const msg = decodeMessage(tool);
    expect(str(msg.get(1)[0].value)).toBe("get_weather");
    expect(str(msg.get(2)[0].value)).toBe("Get weather");
    // ChatService carries the schema as a JSON string, not a google.protobuf.Value.
    expect(JSON.parse(str(msg.get(3)[0].value))).toEqual(schema);
    expect(str(msg.get(4)[0].value)).toBe("custom");
  });

  it("preserves nested JSON-schema types", () => {
    const schema = {
      type: "object",
      properties: {
        query: { type: "string", description: "search query" },
        opts: { type: "array", items: { type: "string" } },
      },
      required: ["query"],
    };
    const msg = decodeMessage(encodeMcpTool({ function: { name: "search", parameters: schema } }));
    expect(JSON.parse(str(msg.get(3)[0].value))).toEqual(schema);
  });

  it("accepts flat tool shape (no .function wrapper)", () => {
    const msg = decodeMessage(encodeMcpTool({ name: "noop", description: "d", input_schema: { type: "object" } }));
    expect(str(msg.get(1)[0].value)).toBe("noop");
    expect(str(msg.get(2)[0].value)).toBe("d");
    expect(JSON.parse(str(msg.get(3)[0].value))).toEqual({ type: "object" });
  });

  it("omits empty name/description/parameters but always sets server", () => {
    const msg = decodeMessage(encodeMcpTool({ function: {} }));
    expect(msg.has(1)).toBe(false);
    expect(msg.has(2)).toBe(false);
    expect(msg.has(3)).toBe(false);
    expect(str(msg.get(4)[0].value)).toBe("custom");
  });

  it("attaches each tool as a repeated MCP_TOOLS(34) entry and flips agentic mode", () => {
    const tools = [
      { function: { name: "get_weather", parameters: { type: "object" } } },
      { function: { name: "calculate", parameters: { type: "object" } } },
    ];
    const request = decodeMessage(decodeMessage(buildChatRequest([{ role: "user", content: "hi" }], "gpt-5.2", tools)).get(1)[0].value);
    expect(request.get(34).length).toBe(2);
    expect(str(decodeMessage(request.get(34)[0].value).get(1)[0].value)).toBe("get_weather");
    expect(str(decodeMessage(request.get(34)[1].value).get(1)[0].value)).toBe("calculate");
    expect(request.get(27)[0].value).toBe(1); // is_agentic
    expect(str(request.get(54)[0].value)).toBe("Agent"); // unified_mode_name
  });

  it("emits no MCP_TOOLS(34) and stays in Ask mode without tools", () => {
    const request = decodeMessage(decodeMessage(buildChatRequest([{ role: "user", content: "hi" }], "gpt-5.2", [])).get(1)[0].value);
    expect(request.has(34)).toBe(false);
    expect(request.get(27)[0].value).toBe(0); // is_agentic
    expect(str(request.get(54)[0].value)).toBe("Ask");
  });
});

// ==================== ChatService: tool call decoding ====================

describe("Cursor ChatService tool-call decoding (extractTextFromResponse)", () => {
  const mcpParams = (name, argsJson) =>
    encodeField(1, LEN, concatAll(encodeField(1, LEN, name), encodeField(3, LEN, argsJson)));

  const clientSideToolV2Call = (parts) => concatAll(...parts);

  function responseWithToolCall(callBytes) {
    return new Uint8Array(encodeField(1, LEN, callBytes));
  }

  function concatAll(...parts) {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let offset = 0;
    for (const part of parts) {
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  }

  it("reads id, formatted name and MCP arguments from a ClientSideToolV2Call", () => {
    const call = clientSideToolV2Call([
      encodeField(1, VARINT, 19), // tool = MCP
      encodeField(3, LEN, "call_abc\nmc_model9"), // tool_call_id (model id after delimiter)
      encodeField(9, LEN, "mcp_custom_get_weather"), // name
      encodeField(11, VARINT, 1), // is_last
      encodeField(27, LEN, mcpParams("get_weather", '{"city":"Hanoi"}')), // mcp_params
    ]);
    const result = extractTextFromResponse(responseWithToolCall(call));
    expect(result.toolCall).toEqual({
      id: "call_abc",
      type: "function",
      function: { name: "get_weather", arguments: '{"city":"Hanoi"}' },
      isLast: true,
    });
  });

  it("falls back to raw_args(10) and keeps the surfaced name when mcp_params is absent", () => {
    const call = clientSideToolV2Call([
      encodeField(1, VARINT, 19),
      encodeField(3, LEN, "call_1"),
      encodeField(9, LEN, "mcp_custom_calculate"),
      encodeField(10, LEN, '{"expr":"1+1"}'),
    ]);
    const { toolCall } = extractTextFromResponse(responseWithToolCall(call));
    expect(toolCall.id).toBe("call_1");
    expect(toolCall.function).toEqual({ name: "mcp_custom_calculate", arguments: '{"expr":"1+1"}' });
    expect(toolCall.isLast).toBe(false);
  });

  it("returns text/thinking instead of a tool call for a StreamUnifiedChatResponse", () => {
    const thinking = encodeField(1, LEN, "plan");
    const response = encodeField(2, LEN, concatAll(encodeField(1, LEN, "hello"), encodeField(25, LEN, thinking)));
    const result = extractTextFromResponse(new Uint8Array(response));
    expect(result.text).toBe("hello");
    expect(result.thinking).toBe("plan");
    expect(result.toolCall).toBeNull();
  });
});

// ==================== ChatService: tool result encoding ====================

describe("Cursor ChatService tool-result codec (cursorProtobuf.js)", () => {
  it("builds a ClientSideToolV2Result frame with stripped selected_tool and split ids", () => {
    const framed = buildToolResultRequest({
      tool_call_id: "call_abc\nmc_model9",
      tool_name: "mcp_custom_get_weather",
      result_content: '{"temp":32}',
    });
    const wrapper = decodeMessage(framed);
    expect(wrapper.has(2)).toBe(true); // StreamUnifiedChatRequestWithTools.client_side_tool_v2_result
    const cv2 = decodeMessage(wrapper.get(2)[0].value);
    expect(cv2.get(1)[0].value).toBe(19); // tool = MCP
    expect(str(cv2.get(35)[0].value)).toBe("call_abc");
    expect(str(cv2.get(48)[0].value)).toBe("model9");
    expect(cv2.has(49)).toBe(false); // tool_index intentionally omitted

    const mcpResult = decodeMessage(cv2.get(28)[0].value);
    expect(str(mcpResult.get(1)[0].value)).toBe("get_weather"); // prefix stripped
    expect(str(mcpResult.get(2)[0].value)).toBe('{"temp":32}');
  });

  it("keeps an unformatted tool name as-is in the MCP result", () => {
    const cv2 = decodeMessage(
      decodeMessage(buildToolResultRequest({ tool_call_id: "c1", tool_name: "lookup", result_content: "ok" })).get(2)[0].value,
    );
    const mcpResult = decodeMessage(cv2.get(28)[0].value);
    expect(str(mcpResult.get(1)[0].value)).toBe("lookup");
    expect(str(mcpResult.get(2)[0].value)).toBe("ok");
    expect(cv2.has(48)).toBe(false); // no model_call_id without the "\nmc_" delimiter
  });

  it("frames the result for the wire via generateToolResultBody", () => {
    const frame = generateToolResultBody({ tool_call_id: "c1", tool_name: "mcp_custom_noop", result_content: "done" });
    const parsed = parseConnectRPCFrame(Buffer.from(frame));
    expect(parsed.flags).toBe(0x00); // Cursor rejects compressed requests
    expect(parsed.consumed).toBe(frame.length);
    expect(new Uint8Array(parsed.payload)).toEqual(
      new Uint8Array(
        buildToolResultRequest({ tool_call_id: "c1", tool_name: "mcp_custom_noop", result_content: "done" }),
      ),
    );
  });

  it("nests the full tool-result structure inside a ConversationMessage", () => {
    const msg = decodeMessage(
      encodeToolResult({
        tool_call_id: "call_7",
        tool_name: "get_weather",
        tool_index: 2,
        raw_args: '{"city":"Hanoi"}',
        result_content: "sunny",
      }),
    );
    expect(str(msg.get(1)[0].value)).toBe("call_7"); // call id
    expect(str(msg.get(2)[0].value)).toBe("mcp_custom_get_weather"); // formatted name
    expect(msg.get(3)[0].value).toBe(2); // tool index
    expect(str(msg.get(5)[0].value)).toBe('{"city":"Hanoi"}'); // raw args
    const cv2 = decodeMessage(msg.get(8)[0].value); // result
    expect(cv2.get(1)[0].value).toBe(19);
    expect(str(decodeMessage(cv2.get(28)[0].value).get(2)[0].value)).toBe("sunny");
    expect(cv2.get(49)[0].value).toBe(2); // tool_index present inside a message
    const call = decodeMessage(msg.get(11)[0].value); // tool_call echo
    expect(str(call.get(9)[0].value)).toBe("mcp_custom_get_weather");
    const mcpParams = decodeMessage(call.get(27)[0].value);
    const nested = decodeMessage(mcpParams.get(1)[0].value);
    expect(str(nested.get(1)[0].value)).toBe("get_weather");
    expect(str(nested.get(4)[0].value)).toBe("custom");
  });
});

// ==================== AgentService (agent.v1) run frame ====================

describe("Cursor AgentService executor helpers (cursor.js)", () => {
  describe("isAgentCapableRequest", () => {
    it("accepts plain text content", () => {
      expect(isAgentCapableRequest({ messages: [{ role: "user", content: "hi" }] })).toBe(true);
    });

    it("accepts array text content", () => {
      expect(isAgentCapableRequest({ messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] })).toBe(true);
    });

    it("accepts request with tools declared", () => {
      expect(isAgentCapableRequest({ messages: [{ role: "user", content: "hi" }], tools: [{ function: { name: "t" } }] })).toBe(true);
    });

    it("accepts history with assistant tool_calls + tool results", () => {
      expect(isAgentCapableRequest({
        messages: [
          { role: "user", content: "weather?" },
          { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "get_weather", arguments: "{}" } }] },
          { role: "tool", tool_call_id: "c1", content: "sunny" },
          { role: "user", content: "thanks" },
        ],
      })).toBe(true);
    });

    it("rejects non-text (image) content", () => {
      expect(isAgentCapableRequest({ messages: [{ role: "user", content: [{ type: "image_url" }] }] })).toBe(false);
    });

    it("rejects missing messages", () => {
      expect(isAgentCapableRequest({})).toBe(false);
      expect(isAgentCapableRequest(null)).toBe(false);
    });
  });

  describe("buildAgentRunFrame", () => {
    // buildAgentRunFrame returns a wrapped Connect-RPC frame (5-byte header + AgentClientMessage).
    const unwrap = (frame) => frame.subarray(5);
    const runOf = (frame) => decodeMessage(decodeMessage(frame).get(1)[0].value);
    const userActionOf = (run) => decodeMessage(decodeMessage(run.get(2)[0].value).get(1)[0].value);

    it("encodes a text-only run request with system + model", () => {
      const frame = unwrap(buildAgentRunFrame(
        [{ role: "system", content: "be brief" }, { role: "user", content: "hi" }],
        "gpt-5.2",
      ));
      const clientMsg = decodeMessage(frame);
      expect(clientMsg.has(1)).toBe(true); // run_request
      const run = runOf(frame);
      expect(run.has(2)).toBe(true); // action
      expect(run.has(9)).toBe(true); // requested_model
      // custom_system_prompt (field 8) makes AgentService return an empty turn.
      expect(run.has(8)).toBe(false);
      expect(run.has(3)).toBe(true); // ModelDetails — required for thinking variants
      const userMessage = decodeMessage(userActionOf(run).get(1)[0].value);
      const userText = Buffer.from(userMessage.get(1)[0].value).toString("utf8");
      expect(userText).toContain("be brief");
      expect(userText).toContain("hi");
    });

    it("encodes mcp_tools (field 4) when tools are provided", () => {
      const tools = [{ function: { name: "get_weather", description: "weather", parameters: { type: "object", properties: { city: { type: "string" } } } } }];
      const run = runOf(unwrap(buildAgentRunFrame([{ role: "user", content: "weather?" }], "gpt-5.2", tools)));
      expect(run.has(4)).toBe(true); // mcp_tools
      const mcpTools = decodeMessage(run.get(4)[0].value);
      expect(mcpTools.get(1).length).toBe(1);
    });

    it("omits mcp_tools when no tools provided", () => {
      const run = runOf(unwrap(buildAgentRunFrame([{ role: "user", content: "hi" }], "gpt-5.2", [])));
      expect(run.has(4)).toBe(false);
    });

    it("encodes conversation_history(7) from prior turns, user/assistant variants, oldest first", () => {
      const messages = [
        { role: "user", content: "weather in Tokyo?" },
        { role: "assistant", content: "checking", tool_calls: [{ id: "c1", type: "function", function: { name: "get_weather", arguments: '{"city":"Tokyo"}' } }] },
        { role: "tool", tool_call_id: "c1", content: "18C cloudy" },
        { role: "user", content: "thanks" },
      ];
      const userAction = userActionOf(runOf(unwrap(buildAgentRunFrame(messages, "gpt-5.2", []))));
      expect(userAction.has(7)).toBe(true);
      const history = decodeMessage(userAction.get(7)[0].value);
      expect(history.get(1).length).toBeGreaterThanOrEqual(2); // prior turns, oldest first

      // ConversationHistoryMessage.user vs .assistant variants (field 1 vs field 2).
      expect(decodeMessage(history.get(1)[0].value).has(1)).toBe(true);
      expect(decodeMessage(history.get(1)[1].value).has(2)).toBe(true);

      const historyBytes = Buffer.concat(history.get(1).map((entry) => Buffer.from(entry.value)));
      const carries = (text) => historyBytes.includes(Buffer.from(text, "utf8"));
      expect(carries("weather in Tokyo?")).toBe(true);
      expect(carries("checking")).toBe(true);
      expect(carries("thanks")).toBe(false); // the current turn is not duplicated
    });

    it("sends a placeholder user text when the current turn is empty", () => {
      const userAction = userActionOf(runOf(unwrap(buildAgentRunFrame([{ role: "user", content: "" }], "gpt-5.2"))));
      expect(str(decodeMessage(userAction.get(1)[0].value).get(1)[0].value)).toBe("Continue.");
    });
  });
});


// ==================== AgentService routing decision ====================

describe("CursorExecutor agent.v1 vs ChatService routing (cursor.js)", () => {
  async function agentPathTaken(body) {
    const executor = new CursorExecutor();
    let called = false;
    executor.executeAgent = async () => {
      called = true;
      return { response: new Response("agent") };
    };
    // The legacy ChatService branch must never run here: it needs headers/network.
    executor.buildHeaders = () => {
      throw new Error("LEGACY_PATH");
    };
    try {
      await executor.execute({ model: "gpt-5.2", body, stream: false, credentials: {} });
    } catch (error) {
      if (error.message !== "LEGACY_PATH") throw error;
    }
    return called;
  }

  it("sends a plain text turn to AgentService", async () => {
    expect(await agentPathTaken({ messages: [{ role: "user", content: "hi" }] })).toBe(true);
  });

  it("sends array text content to AgentService", async () => {
    expect(await agentPathTaken({ messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] })).toBe(true);
  });

  it("sends a text turn that merely declares tools to AgentService", async () => {
    // Compatible clients always attach their built-in tool schemas; that alone
    // must not pin the request to the retired ChatService.
    expect(await agentPathTaken({
      messages: [{ role: "user", content: "hi" }],
      tools: [{ function: { name: "t" } }],
    })).toBe(true);
  });

  it("sends a conversation with assistant tool_calls to AgentService", async () => {
    // The agent.v1 frame carries mcp_tools and tool-call history now, so full
    // tool conversations ride the agent path too (isAgentCapableRequest).
    expect(await agentPathTaken({
      messages: [
        { role: "user", content: "weather?" },
        { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "get_weather", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "c1", content: "sunny" },
        { role: "user", content: "thanks" },
      ],
    })).toBe(true);
  });

  it("sends a bare tool-result message to AgentService", async () => {
    expect(await agentPathTaken({
      messages: [
        { role: "user", content: "weather?" },
        { role: "tool", tool_call_id: "c1", content: "sunny" },
      ],
    })).toBe(true);
  });

  it("keeps non-text (image) content on ChatService", async () => {
    expect(await agentPathTaken({ messages: [{ role: "user", content: [{ type: "image_url" }] }] })).toBe(false);
  });

  it("keeps requests without messages on ChatService", async () => {
    expect(await agentPathTaken({})).toBe(false);
    expect(await agentPathTaken(null)).toBe(false);
  });
});

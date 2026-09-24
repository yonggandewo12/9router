/**
 * Regression: an Anthropic-format client sending stream:false against an
 * openai-responses upstream model (e.g. free-code's non-streaming fallback
 * hitting 9router for muse-spark-1.3-contributor-free) received the RAW
 * OpenAI chat.completion body — no `content` array. The Anthropic SDK
 * parses it with content: undefined and the client crashed with
 * "undefined is not an object (evaluating 'r of e')" in its degenerate
 * response checks.
 *
 * translateNonStreamingResponse had an OPENAI→CLAUDE branch but none for
 * OPENAI_RESPONSES→CLAUDE even though the forced-streaming executor
 * normalizes SSE to chat.completion shape first.
 */

import { describe, it, expect } from "vitest";
import { translateNonStreamingResponse } from "../../open-sse/handlers/chatCore/nonStreamingHandler.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

const chatBody = (over = {}) => ({
  id: "chatcmpl-1790242325477",
  object: "chat.completion",
  created: 1790242325,
  model: "muse-spark-1.3-contributor-free",
  choices: [{
    index: 0,
    message: { role: "assistant", content: "hello world" },
    finish_reason: "stop",
  }],
  usage: { prompt_tokens: 100, completion_tokens: 7, total_tokens: 107 },
  ...over,
});

describe("translateNonStreamingResponse: openai-responses → claude", () => {
  it("converts a chat.completion body to an Anthropic message with a content array", () => {
    const out = translateNonStreamingResponse(chatBody(), FORMATS.OPENAI_RESPONSES, FORMATS.CLAUDE);

    expect(out.type).toBe("message");
    expect(out.role).toBe("assistant");
    expect(Array.isArray(out.content)).toBe(true);
    expect(out.content).toEqual([{ type: "text", text: "hello world" }]);
    expect(out.stop_reason).toBe("end_turn");
    expect(out.usage).toEqual({ input_tokens: 100, output_tokens: 7 });
  });

  it("maps tool_calls to tool_use blocks and finish_reason to tool_use stop", () => {
    const body = chatBody({
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "call_1", type: "function", function: { name: "echo", arguments: "{\"text\":\"hi\"}" } }],
        },
        finish_reason: "tool_calls",
      }],
    });
    const out = translateNonStreamingResponse(body, FORMATS.OPENAI_RESPONSES, FORMATS.CLAUDE);

    const toolUse = out.content.find(b => b.type === "tool_use");
    expect(toolUse).toBeDefined();
    expect(toolUse.id).toBe("call_1");
    expect(toolUse.name).toBe("echo");
    expect(toolUse.input).toEqual({ text: "hi" });
    expect(out.stop_reason).toBe("tool_use");
  });

  it("keeps reasoning_content as a leading thinking block", () => {
    const body = chatBody({
      choices: [{
        index: 0,
        message: { role: "assistant", content: "answer", reasoning_content: "pondering" },
        finish_reason: "stop",
      }],
    });
    const out = translateNonStreamingResponse(body, FORMATS.OPENAI_RESPONSES, FORMATS.CLAUDE);

    expect(out.content[0]).toEqual({ type: "thinking", thinking: "pondering" });
    expect(out.content[1]).toEqual({ type: "text", text: "answer" });
  });

  it("still converts plain OPENAI → CLAUDE (existing branch unchanged)", () => {
    const out = translateNonStreamingResponse(chatBody(), FORMATS.OPENAI, FORMATS.CLAUDE);
    expect(out.type).toBe("message");
    expect(Array.isArray(out.content)).toBe(true);
  });
});

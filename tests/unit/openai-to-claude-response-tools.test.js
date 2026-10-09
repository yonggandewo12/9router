import { describe, expect, it } from "vitest";
import { openaiToClaudeResponse } from "../../open-sse/translator/response/openai-to-claude.js";

function createState() {
  return { toolCalls: new Map(), nextBlockIndex: 0 };
}

function getInputJsonDelta(events) {
  return events.find((event) => event.type === "content_block_delta" && event.delta?.type === "input_json_delta")?.delta.partial_json;
}

describe("openaiToClaudeResponse tool argument sanitization", () => {
  it("drops invalid Read pages and clamps numeric bounds", () => {
    const state = createState();

    openaiToClaudeResponse({
      id: "chatcmpl-test-read",
      model: "test-model",
      choices: [{ delta: { tool_calls: [{ index: 0, id: "toolu_read", function: { name: "Read" } }] } }],
    }, state);

    const events = openaiToClaudeResponse({
      id: "chatcmpl-test-read",
      model: "test-model",
      choices: [{
        delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ file_path: "F:/repo/file.js", offset: -5, limit: 999999999, pages: "" }) } }] },
        finish_reason: "tool_calls",
      }],
    }, state);

    expect(JSON.parse(getInputJsonDelta(events))).toEqual({
      file_path: "F:/repo/file.js",
      offset: 0,
      limit: 2000,
    });
  });

  it("keeps valid PDF pages", () => {
    const state = createState();

    openaiToClaudeResponse({
      id: "chatcmpl-test-pdf",
      model: "test-model",
      choices: [{ delta: { tool_calls: [{ index: 0, id: "toolu_pdf", function: { name: "proxy_Read" } }] } }],
    }, state);

    const events = openaiToClaudeResponse({
      id: "chatcmpl-test-pdf",
      model: "test-model",
      choices: [{
        delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ file_path: "F:/repo/doc.pdf", pages: "1-3" }) } }] },
        finish_reason: "tool_calls",
      }],
    }, state);

    expect(JSON.parse(getInputJsonDelta(events))).toEqual({
      file_path: "F:/repo/doc.pdf",
      pages: "1-3",
    });
  });
});

describe("openaiToClaudeResponse tool argument streaming", () => {
  const chunk = (delta, finishReason = null) => ({
    id: "chatcmpl-stream",
    model: "test-model",
    choices: [{ delta, finish_reason: finishReason }],
  });

  it("forwards fragments of a non-Read tool as they arrive", () => {
    const state = createState();
    openaiToClaudeResponse(chunk({ tool_calls: [{ index: 0, id: "toolu_w", function: { name: "Write", arguments: "" } }] }), state);

    const first = openaiToClaudeResponse(chunk({ tool_calls: [{ index: 0, function: { arguments: '{"file_path":"/a.js",' } }] }), state);
    const second = openaiToClaudeResponse(chunk({ tool_calls: [{ index: 0, function: { arguments: '"content":"x"}' } }] }), state);
    expect(getInputJsonDelta(first)).toBe('{"file_path":"/a.js",');
    expect(getInputJsonDelta(second)).toBe('"content":"x"}');

    // Finish closes the block; re-emitting the args would corrupt the client's
    // concatenation of partial_json fragments.
    const done = openaiToClaudeResponse(chunk({}, "tool_calls"), state);
    expect(getInputJsonDelta(done)).toBeUndefined();
    expect(done.some((e) => e.type === "content_block_stop")).toBe(true);
  });

  it("flushes args buffered before the tool name was known", () => {
    const state = createState();
    openaiToClaudeResponse(chunk({ tool_calls: [{ index: 0, id: "toolu_l", function: { arguments: '{"q":' } }] }), state);
    const named = openaiToClaudeResponse(chunk({ tool_calls: [{ index: 0, function: { name: "Grep", arguments: '"x"}' } }] }), state);
    expect(getInputJsonDelta(named)).toBe('{"q":"x"}');
    expect(getInputJsonDelta(openaiToClaudeResponse(chunk({}, "tool_calls"), state))).toBeUndefined();
  });
});

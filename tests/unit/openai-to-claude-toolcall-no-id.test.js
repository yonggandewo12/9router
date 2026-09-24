/**
 * Regression: muse-spark (via opencode-zen) streams tool-call deltas whose
 * FIRST chunk for an index carries no `id` (only name and/or arguments).
 * The old gate `if (tc.id && !state.toolCalls.has(idx))` never opened a
 * content_block for such tool calls, so the finish pass emitted a
 * content_block_stop for an index that never got a content_block_start.
 * Strict Anthropic clients (free-code CLI) crashed on the orphan events:
 *   "API Error: undefined is not an object (evaluating 'r of e')"
 *
 * Also guards against upstreams that repeat finish_reason across chunks,
 * which used to duplicate message_delta/message_stop in the SSE stream.
 */

import { describe, it, expect } from "vitest";
import { openaiToClaudeResponse } from "../../open-sse/translator/response/openai-to-claude.js";

const newState = () => ({
  toolCalls: new Map(),
  nextBlockIndex: 0,
  thinkingBlockStarted: false,
  textBlockStarted: false,
  finishReasonSent: false,
  claudeFinishSent: false,
});

const chunk = (delta, finish_reason = null) => ({
  id: "chatcmpl-regress",
  model: "muse-spark-1.3",
  choices: [{ index: 0, delta, finish_reason }],
});

describe("openaiToClaudeResponse: tool calls without id on first chunk", () => {
  it("opens a content_block when the first tool-call chunk has name+args but no id", () => {
    const state = newState();
    const events = openaiToClaudeResponse(
      chunk({
        tool_calls: [{ index: 0, function: { name: "Bash", arguments: '{"comm' } }],
      }),
      state,
    );

    const start = events.find(e => e.type === "content_block_start");
    expect(start).toBeDefined();
    expect(start.content_block.type).toBe("tool_use");
    expect(start.content_block.name).toBe("Bash");
    expect(start.content_block.id).toBeTruthy();

    // Finish must stop the SAME index that was opened (no orphan stop).
    const finish = openaiToClaudeResponse(chunk({}, "tool_calls"), state);
    const stop = finish.find(e => e.type === "content_block_stop");
    expect(stop.index).toBe(start.index);
    expect(state.toolCalls.get(0).blockIndex).toBe(start.index);
  });

  it("fills in the id when it arrives on a later chunk", () => {
    const state = newState();
    openaiToClaudeResponse(
      chunk({ tool_calls: [{ index: 0, function: { name: "Read", arguments: "{}" } }] }),
      state,
    );
    openaiToClaudeResponse(
      chunk({ tool_calls: [{ index: 0, id: "call_real_123" }] }),
      state,
    );
    expect(state.toolCalls.get(0).id).toBe("call_real_123");
    // A late id must not open a second block.
    const again = openaiToClaudeResponse(
      chunk({ tool_calls: [{ index: 0, id: "call_other", function: { arguments: "" } }] }),
      state,
    );
    expect(again).toBeNull();
  });

  it("keeps the legacy shape working (id on first chunk)", () => {
    const state = newState();
    const events = openaiToClaudeResponse(
      chunk({
        tool_calls: [{ index: 0, id: "call_abc", function: { name: "echo", arguments: '{"a":1}' } }],
      }),
      state,
    );
    const start = events.find(e => e.type === "content_block_start");
    expect(start.content_block.id).toBe("call_abc");
    expect(state.toolCalls.get(0).id).toBe("call_abc");
  });
});

describe("openaiToClaudeResponse: repeated finish_reason", () => {
  it("emits message_delta/message_stop only once", () => {
    const state = newState();
    const first = openaiToClaudeResponse(chunk({ content: "done" }, "stop"), state);
    expect(first.filter(e => e.type === "message_delta")).toHaveLength(1);
    expect(first.filter(e => e.type === "message_stop")).toHaveLength(1);

    const second = openaiToClaudeResponse(chunk({}, "stop"), state);
    expect(second).toBeNull();
  });
});

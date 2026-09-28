/**
 * MiniMax thinking semantics (live-captured 2026-09-28 on api.minimaxi.com):
 *   - /v1/chat/completions inlines reasoning in delta.content wrapped in
 *     think tags unless the request carries reasoning_split:true (then
 *     reasoning_content + reasoning_details[] come back separately).
 *   - /anthropic/v1/messages with NO thinking field (or {type:"disabled"})
 *     returns zero thinking blocks and the reasoning inside text_delta, so the
 *     engine must always ask for the thinking channel (thinkingCanDisable:false
 *     + explicit adaptive when the client expresses no intent).
 */

import { describe, it, expect } from "vitest";
import { applyThinking } from "../../open-sse/translator/concerns/thinkingUnified.js";

const apply = (targetFormat, body, model = "MiniMax-M3") => {
  const b = { max_tokens: 100, messages: [{ role: "user", content: "test" }], ...body };
  applyThinking(targetFormat, model, b, "minimax-cn");
  return b;
};

describe("MiniMax thinking normalization", () => {
  it("asks for the thinking channel when the client sends no thinking intent", () => {
    for (const targetFormat of ["claude", "openai"]) {
      const body = apply(targetFormat, {});
      expect(body.thinking).toEqual({ type: "adaptive" });
    }
  });

  it("clamps explicit off requests to adaptive (canDisable:false)", () => {
    const claudeOff = apply("claude", { thinking: { type: "disabled" } });
    expect(claudeOff.thinking).toEqual({ type: "adaptive" });

    const effortNone = apply("claude", { output_config: { effort: "none" } });
    expect(effortNone.thinking).toEqual({ type: "adaptive" });

    const openaiNone = apply("openai", { reasoning_effort: "none" });
    expect(openaiNone.thinking).toEqual({ type: "adaptive" });
  });

  it("requests reasoning_split on the OpenAI wire only", () => {
    expect(apply("openai", {}).reasoning_split).toBe(true);
    expect(apply("claude", {}).reasoning_split).toBeUndefined();
  });

  it("applies the same split behavior across the M-series family", () => {
    for (const model of ["MiniMax-M2.7", "MiniMax-M2.7-highspeed", "MiniMax-M2.5", "MiniMax-M2.1", "MiniMax-M2"]) {
      const body = apply("openai", {}, model);
      expect(body.reasoning_split).toBe(true);
      expect(body.thinking).toEqual({ type: "adaptive" });
    }
  });

  it("leaves non-MiniMax providers untouched when the client sends no intent", () => {
    const body = { max_tokens: 100, messages: [{ role: "user", content: "test" }] };
    applyThinking("claude", "claude-sonnet-4-5", body, "claude");
    expect(body.thinking).toBeUndefined();
    expect(body.reasoning_split).toBeUndefined();
  });
});

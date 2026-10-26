// Stream chunk filter: what is allowed to reach the client. Deleting a chunk here silently
// drops model output, so every accepted shape is pinned — including the vendor reasoning
// aliases, the legacy function_call shape and streamed audio.
import { describe, it, expect, vi } from "vitest";
import { hasValuableContent } from "../../open-sse/utils/streamHelpers.js";
import { createPassthroughStreamWithLogger } from "../../open-sse/utils/stream.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

// stream.js reports pending/usage through the DB shim; keep the suite off the real data dir.
vi.mock("@/lib/usageDb.js", () => ({
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
  trackPendingRequest: vi.fn(),
  statsEmitter: { on: vi.fn(), emit: vi.fn() },
}));

const chat = (delta, finish = null) => ({ id: "x", choices: [{ index: 0, delta, finish_reason: finish }] });

describe("hasValuableContent — OpenAI chat shape", () => {
  it("keeps the obvious answer frames", () => {
    expect(hasValuableContent(chat({ content: "hi" }), FORMATS.OPENAI)).toBe(true);
    expect(hasValuableContent(chat({ content: [{ type: "text", text: "" }] }), FORMATS.OPENAI)).toBe(true);
    expect(hasValuableContent(chat({ reasoning_content: "think" }), FORMATS.OPENAI)).toBe(true);
    expect(hasValuableContent(chat({ tool_calls: [{ id: "c1" }] }), FORMATS.OPENAI)).toBe(true);
    expect(hasValuableContent(chat({}, "stop"), FORMATS.OPENAI)).toBe(true);
    expect(hasValuableContent(chat({ role: "assistant" }), FORMATS.OPENAI)).toBe(true);
  });

  // Regression: alias lanes (delta.reasoning / reasoning_details[]), legacy function_call
  // and audio-output deltas were deleted before they reached the client, so the model's own
  // output vanished and the turn looked empty downstream.
  it("keeps vendor reasoning aliases, legacy function_call and audio payloads", () => {
    expect(hasValuableContent(chat({ reasoning: "think" }), FORMATS.OPENAI)).toBe(true);
    expect(hasValuableContent(chat({ reasoning_details: [{ text: "think" }] }), FORMATS.OPENAI)).toBe(true);
    expect(hasValuableContent(chat({ function_call: { name: "f" } }), FORMATS.OPENAI)).toBe(true);
    expect(hasValuableContent(chat({ function_call: { arguments: "{\"a\":" } }), FORMATS.OPENAI)).toBe(true);
    expect(hasValuableContent(chat({ audio: { data: "AAAA" } }), FORMATS.OPENAI)).toBe(true);
    expect(hasValuableContent(chat({ audio: { transcript: "hello" } }), FORMATS.OPENAI)).toBe(true);
    expect(hasValuableContent(chat({ audio: { chunk: "AAAA" } }), FORMATS.OPENAI)).toBe(true);
  });

  it("still drops frames with nothing in them", () => {
    expect(hasValuableContent(chat({}), FORMATS.OPENAI)).toBe(false);
    expect(hasValuableContent(chat({ content: "" }), FORMATS.OPENAI)).toBe(false);
    expect(hasValuableContent(chat({ reasoning: "   " }), FORMATS.OPENAI)).toBe(false);
    expect(hasValuableContent(chat({ reasoning_details: [{ text: "" }] }), FORMATS.OPENAI)).toBe(false);
    expect(hasValuableContent(chat({ function_call: {} }), FORMATS.OPENAI)).toBe(false);
    expect(hasValuableContent(chat({ audio: {} }), FORMATS.OPENAI)).toBe(false);
    expect(hasValuableContent(chat({ tool_calls: [] }), FORMATS.OPENAI)).toBe(false);
  });
});

describe("hasValuableContent — other formats", () => {
  it("Anthropic Messages: empty text/thinking deltas drop, anything with payload or structure stays", () => {
    expect(hasValuableContent({ type: "content_block_delta", delta: { type: "text_delta", text: "" } }, FORMATS.CLAUDE)).toBe(false);
    expect(hasValuableContent({ type: "content_block_delta", delta: { type: "text_delta", text: "hi" } }, FORMATS.CLAUDE)).toBe(true);
    expect(hasValuableContent({ type: "content_block_delta", delta: { type: "thinking_delta", thinking: "hmm" } }, FORMATS.CLAUDE)).toBe(true);
    expect(hasValuableContent({ type: "content_block_start", content_block: { type: "thinking" } }, FORMATS.CLAUDE)).toBe(true);
    expect(hasValuableContent({ type: "message_start" }, FORMATS.CLAUDE)).toBe(true);
  });

  it("formats the filter cannot read are forwarded untouched", () => {
    expect(hasValuableContent({ candidates: [] }, FORMATS.GEMINI)).toBe(true);
  });
});

describe("passthrough stream delivers the alias payloads", () => {
  it("a reasoning-alias-only turn reaches the client byte-for-byte", async () => {
    const enc = new TextEncoder();
    const frames = [
      `data: ${JSON.stringify(chat({ role: "assistant" }))}\n\n`,
      `data: ${JSON.stringify(chat({ reasoning: "hidden thought " }))}\n\n`,
      `data: ${JSON.stringify(chat({ content: "answer" }))}\n\n`,
      `data: ${JSON.stringify(chat({}, "stop"))}\n\n`,
      "data: [DONE]\n\n",
    ];
    const source = new ReadableStream({
      start(c) { for (const f of frames) c.enqueue(enc.encode(f)); c.close(); },
    });
    const out = await new Response(source.pipeThrough(createPassthroughStreamWithLogger("openai"))).text();
    expect(out).toContain('"reasoning":"hidden thought "');
    expect(out).toContain('"content":"answer"');
    expect(out).toContain("[DONE]");
  });
});

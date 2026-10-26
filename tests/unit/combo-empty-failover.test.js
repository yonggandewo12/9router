// empty-content failover for combo streaming responses.
import { describe, it, expect, vi } from "vitest";
import {
  deltaHasClientContent,
  deltaHasModelActivity,
  inspectSSELine,
  scanSSEBuffer,
  isNoRetryFinish,
  peekStreamForContent,
  reconstructStream,
} from "../../open-sse/services/emptyFailover.js";
import { NO_RETRY_EMPTY_FINISH } from "../../open-sse/translator/schema/finishReasons.js";
import { handleComboChat } from "../../open-sse/services/combo.js";

// The combo cases below build real streaming responses; keep request-detail writes off disk.
vi.mock("@/lib/usageDb.js", () => ({
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
  appendRequestLog: vi.fn(async () => {}),
  trackPendingRequest: vi.fn(),
}));

const enc = new TextEncoder();
const dec = new TextDecoder();

// Build a ReadableStream of encoded SSE frames. `delays[i]` (ms) optionally staggers frame i.
function sseStream(frames, delays = []) {
  let i = 0;
  return new ReadableStream({
    async pull(controller) {
      if (i >= frames.length) { controller.close(); return; }
      const d = delays[i] || 0;
      if (d) await new Promise((r) => setTimeout(r, d));
      controller.enqueue(enc.encode(frames[i]));
      i++;
    },
  });
}

const ROLE = `data: {"id":"x","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n`;
const EMPTY_STOP = `data: {"id":"x","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":30194,"completion_tokens":15}}\n\n`;
const CONTENT = `data: {"id":"x","choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":null}]}\n\n`;
const DONE = `data: [DONE]\n\n`;
const FILTER_STOP = `data: {"id":"x","choices":[{"index":0,"delta":{},"finish_reason":"content_filter"}]}\n\n`;
const REASONING = `data: {"id":"x","choices":[{"index":0,"delta":{"reasoning_content":"thinking..."},"finish_reason":null}]}\n\n`;

describe("deltaHasClientContent", () => {
  it("role-only delta is NOT content", () => expect(deltaHasClientContent({ role: "assistant" })).toBe(false));
  it("empty string content is NOT content", () => expect(deltaHasClientContent({ content: "" })).toBe(false));
  it("reasoning_content is NOT content", () => expect(deltaHasClientContent({ reasoning_content: "x" })).toBe(false));
  it("non-empty string content IS content", () => expect(deltaHasClientContent({ content: "hi" })).toBe(true));
  it("content array IS content", () => expect(deltaHasClientContent({ content: [{ type: "text", text: "a" }] })).toBe(true));
  it("tool_calls IS content", () => expect(deltaHasClientContent({ tool_calls: [{ id: "1" }] })).toBe(true));
  it("legacy function_call IS content; an empty one is not", () => {
    expect(deltaHasClientContent({ function_call: { name: "f", arguments: "{" } })).toBe(true);
    expect(deltaHasClientContent({ function_call: { name: "", arguments: "" } })).toBe(false);
  });
  it("null/garbage is NOT content", () => { expect(deltaHasClientContent(null)).toBe(false); expect(deltaHasClientContent("x")).toBe(false); });
});

// Activity is the peek's commit signal: content OR reasoning. It is deliberately wider
// than "content" so a thinking stream is not held until its first visible text.
describe("deltaHasModelActivity", () => {
  it("role-only / empty delta is NOT activity", () => {
    expect(deltaHasModelActivity({ role: "assistant" })).toBe(false);
    expect(deltaHasModelActivity({})).toBe(false);
    expect(deltaHasModelActivity(null)).toBe(false);
  });
  it("reasoning_content / reasoning / reasoning_details ARE activity", () => {
    expect(deltaHasModelActivity({ reasoning_content: "thinking" })).toBe(true);
    expect(deltaHasModelActivity({ reasoning: "thinking" })).toBe(true);
    expect(deltaHasModelActivity({ reasoning_details: [{ type: "reasoning.text", text: "t" }] })).toBe(true);
  });
  it("empty reasoning strings are NOT activity", () => {
    expect(deltaHasModelActivity({ reasoning_content: "" })).toBe(false);
    expect(deltaHasModelActivity({ reasoning: "" })).toBe(false);
    expect(deltaHasModelActivity({ reasoning_details: [] })).toBe(false);
  });
  // Whitespace-only output is not a payload on either side of the peek: the JSON verdict
  // (combo.js isZeroContentResponse) trims, so the stream must not commit on " " either.
  it("blank-only payload is neither content nor activity", () => {
    expect(deltaHasClientContent({ content: " " })).toBe(false);
    expect(deltaHasClientContent({ content: "\n" })).toBe(false);
    expect(deltaHasModelActivity({ content: " " })).toBe(false);
    expect(deltaHasModelActivity({ reasoning_content: "   " })).toBe(false);
    expect(deltaHasModelActivity({ reasoning_content: " real thought " })).toBe(true);
  });
  it("content and tool calls are activity too", () => {
    expect(deltaHasModelActivity({ content: "hi" })).toBe(true);
    expect(deltaHasModelActivity({ tool_calls: [{ id: "1" }] })).toBe(true);
    expect(deltaHasModelActivity({ function_call: { name: "f", arguments: "{}" } })).toBe(true);
  });
  it("a streaming audio delta is activity only with a payload (structural handle is not)", () => {
    expect(deltaHasModelActivity({ audio: { id: "a1", data: "AAAA" } })).toBe(true);
    expect(deltaHasModelActivity({ audio: { transcript: "hi" } })).toBe(true);
    expect(deltaHasModelActivity({ audio: {} })).toBe(false);
    expect(deltaHasModelActivity({ audio: { id: "a1" } })).toBe(false);
  });
});

describe("inspectSSELine", () => {
  it("[DONE] carries nothing", () => expect(inspectSSELine("data: [DONE]")).toMatchObject({ content: false, finishReason: null }));
  it("role frame: no content, no finish", () => {
    const r = inspectSSELine(ROLE.trim());
    expect(r.content).toBe(false); expect(r.finishReason).toBe(null);
  });
  it("empty stop frame: no content, finish stop", () => {
    const r = inspectSSELine(EMPTY_STOP.trim());
    expect(r.content).toBe(false); expect(r.finishReason).toBe("stop");
  });
  it("content frame: content true", () => expect(inspectSSELine(CONTENT.trim()).content).toBe(true));
  it("reasoning frame: activity true, content false", () => {
    const r = inspectSSELine(REASONING.trim());
    expect(r.content).toBe(false);
    expect(r.activity).toBe(true);
  });
  it("non-data lines are inert", () => {
    expect(inspectSSELine("event: ping").content).toBe(false);
    expect(inspectSSELine(": keep-alive").content).toBe(false);
  });
});

describe("scanSSEBuffer latches", () => {
  it("stays empty across role+stop", () => {
    const st = scanSSEBuffer(ROLE + EMPTY_STOP);
    expect(st.sawActivity).toBe(false); expect(st.finishReason).toBe("stop");
  });
  it("latches once content is seen", () => {
    const st = scanSSEBuffer(ROLE + CONTENT + EMPTY_STOP);
    expect(st.sawActivity).toBe(true);
  });
  it("latches once reasoning is seen (activity, but still no usable content)", () => {
    const st = scanSSEBuffer(ROLE + REASONING);
    expect(st.sawActivity).toBe(true);
    expect(st.sawContent).toBe(false);
  });
});

describe("isNoRetryFinish", () => {
  it("content_filter → no retry", () => expect(isNoRetryFinish("content_filter")).toBe(true));
  it("stop → retry (false)", () => expect(isNoRetryFinish("stop")).toBe(false));
  it("null → false", () => expect(isNoRetryFinish(null)).toBe(false));
  it("schema set holds content_filter", () => expect(NO_RETRY_EMPTY_FINISH.has("content_filter")).toBe(true));
});

describe("peekStreamForContent", () => {
  it("MALFORMED-style empty stream → outcome empty, finish stop", async () => {
    const p = await peekStreamForContent(sseStream([ROLE, EMPTY_STOP, DONE]));
    expect(p.outcome).toBe("empty");
    expect(p.finishReason).toBe("stop");
  });

  it("content stream → outcome content", async () => {
    const p = await peekStreamForContent(sseStream([ROLE, CONTENT, EMPTY_STOP, DONE]));
    expect(p.outcome).toBe("content");
  });

  it("reasoning-only then abort → committed on activity (reasoning is not client content but IS model output)", async () => {
    const p = await peekStreamForContent(sseStream([ROLE, REASONING, EMPTY_STOP, DONE]));
    expect(p.outcome).toBe("content");
    // The head still replays byte-for-byte, so the client receives the reasoning frame.
    const rebuilt = reconstructStream(p.head, p.reader);
    const out = await (async () => { const rd = rebuilt.getReader(); let s = ""; while (true) { const { done, value } = await rd.read(); if (done) break; s += dec.decode(value); } return s; })();
    expect(out).toContain('"reasoning_content":"thinking..."');
  });

  // The reason activity commits: waiting for client text adds the whole thinking phase to
  // TTFT (and this test would otherwise sit here until the 45s deadline).
  it("commits on the reasoning frame instead of waiting for text", async () => {
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(enc.encode(ROLE + REASONING));
        // ...then the upstream goes quiet: no further frame ever arrives.
      },
    });
    const p = await Promise.race([
      peekStreamForContent(stream),
      new Promise((_, rej) => setTimeout(() => rej(new Error("peek held a reasoning stream")), 1000)),
    ]);
    expect(p.outcome).toBe("content");
    expect(dec.decode(p.head[p.head.length - 1])).toContain("thinking...");
    await p.reader.cancel();
  });

  // The peek's error branch had no coverage: a stream that dies before any payload must
  // still be judged empty (so the combo moves to the next candidate) and the replay handed
  // back to the caller must surface the same failure rather than look like a clean end.
  it("a stream that errors before any payload → empty, error surfaced on replay", async () => {
    const stream = new ReadableStream({
      pull() { return Promise.reject(new Error("network reset")); },
    });
    const p = await peekStreamForContent(stream);
    expect(p.outcome).toBe("empty");
    expect(p.error?.message).toBe("network reset");
    await expect(new Response(reconstructStream(p.head, p.reader, p.pendingRead)).text())
      .rejects.toThrow("network reset");
  });

  it("content-filter empty → empty with content_filter reason (caller won't retry)", async () => {
    const p = await peekStreamForContent(sseStream([ROLE, FILTER_STOP, DONE]));
    expect(p.outcome).toBe("empty");
    expect(isNoRetryFinish(p.finishReason)).toBe(true);
  });

  it("deadline fail-open: slow first content → committed as content", async () => {
    // content frame delayed 200ms, deadline 30ms → must commit (not falsely fall through)
    const p = await peekStreamForContent(sseStream([ROLE, CONTENT, DONE], [0, 200]), { deadlineMs: 30 });
    expect(p.outcome).toBe("content");
    expect(p.timedOut).toBe(true);
  });

  // Regression for C1: the deadline must NOT drop the in-flight chunk. Reconstruct + drain and
  // assert the delayed content actually reaches the client (previously it was silently lost).
  it("deadline hand-off preserves the delayed content frame end-to-end", async () => {
    const frames = [ROLE, CONTENT, EMPTY_STOP, DONE];
    const p = await peekStreamForContent(sseStream(frames, [0, 200]), { deadlineMs: 30 });
    expect(p.outcome).toBe("content");
    expect(p.timedOut).toBe(true);
    const rebuilt = reconstructStream(p.head, p.reader, p.pendingRead);
    const rd = rebuilt.getReader(); let out = "";
    while (true) { const { done, value } = await rd.read(); if (done) break; out += dec.decode(value); }
    expect(out).toBe(frames.join(""));           // no loss, no reorder
    expect(out).toContain('"content":"OK"');      // the slow frame survived
  });

  // Regression for M1: a zero/NaN deadline must NOT disable the timeout (no infinite hang).
  it("deadline=0 is clamped (does not hang on a normal stream)", async () => {
    const p = await peekStreamForContent(sseStream([ROLE, EMPTY_STOP, DONE]), { deadlineMs: 0 });
    expect(p.outcome).toBe("empty");
  });
  it("deadline=NaN is clamped", async () => {
    const p = await peekStreamForContent(sseStream([ROLE, CONTENT, DONE]), { deadlineMs: NaN });
    expect(p.outcome).toBe("content");
  });
});

describe("partial lines", () => {
  it("never parses an incomplete trailing line (no parse warnings at chunk boundaries)", () => {
    const warn = vi.spyOn(console, "log").mockImplementation(() => {});
    const half = CONTENT.slice(0, 30); // a data: line cut mid-JSON
    const st = scanSSEBuffer(ROLE + half);
    expect(st.sawActivity).toBe(false);
    expect(st.pending).toBe(half);
    expect(warn).not.toHaveBeenCalled();
    scanSSEBuffer(st.pending + CONTENT.slice(30), st); // completed by the next chunk
    expect(st.sawActivity).toBe(true);
    warn.mockRestore();
  });

  it("detects content on a final line that has no trailing newline", async () => {
    const p = await peekStreamForContent(sseStream([ROLE, CONTENT.trim()]));
    expect(p.outcome).toBe("content");
  });

  // The done branch decides on activity too: a reasoning line that arrives as the last
  // fragment (no trailing newline) has to commit, or a thinking turn that ends exactly
  // there is billed as an empty generation and replayed on the next combo member.
  it("detects reasoning on a final line with no trailing newline", async () => {
    const p = await peekStreamForContent(sseStream([ROLE, REASONING.trim()]));
    expect(p.outcome).toBe("content");
    expect(p.finishReason).toBe(null);
  });
});

describe("reconstructStream is byte-faithful", () => {
  async function drain(stream) {
    const rd = stream.getReader(); let out = "";
    while (true) { const { done, value } = await rd.read(); if (done) break; out += dec.decode(value); }
    return out;
  }

  it("content case replays head + remaining identically", async () => {
    const frames = [ROLE, CONTENT, EMPTY_STOP, DONE];
    const p = await peekStreamForContent(sseStream(frames));
    const rebuilt = reconstructStream(p.head, p.reader);
    expect(await drain(rebuilt)).toBe(frames.join(""));
  });

  it("empty case (fully buffered) replays identically", async () => {
    const frames = [ROLE, EMPTY_STOP, DONE];
    const p = await peekStreamForContent(sseStream(frames));
    const rebuilt = reconstructStream(p.head, p.reader);
    expect(await drain(rebuilt)).toBe(frames.join(""));
  });
});

// The peek reads the CLIENT-format stream. /v1/messages clients get Anthropic Messages SSE and
// /v1/responses clients get OpenAI Responses SSE: typed events, no `choices`.
const ev = (o) => `data: ${JSON.stringify(o)}`;

describe("inspectSSELine — Anthropic Messages client format", () => {
  it("text_delta with text IS content; empty text_delta is NOT", () => {
    expect(inspectSSELine(ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } })).content).toBe(true);
    expect(inspectSSELine(ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "" } })).content).toBe(false);
  });
  it("thinking_delta is NOT content (as reasoning_content is not), but IS activity", () => {
    const r = inspectSSELine(ev({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } }));
    expect(r.content).toBe(false);
    expect(r.activity).toBe(true);
  });
  it("a thinking block start commits only when it carries text; an empty one is structural", () => {
    expect(inspectSSELine(ev({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } })).activity).toBe(false);
    expect(inspectSSELine(ev({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "hmm" } })).activity).toBe(true);
    expect(inspectSSELine(ev({ type: "content_block_start", index: 0, content_block: { type: "redacted_thinking", data: "Zk" } })).activity).toBe(true);
    expect(inspectSSELine(ev({ type: "content_block_start", index: 0, content_block: { type: "redacted_thinking", data: "" } })).activity).toBe(false);
  });
  it("a tool_use block start IS content; input_json_delta with JSON IS content", () => {
    expect(inspectSSELine(ev({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "t", name: "f", input: {} } })).content).toBe(true);
    expect(inspectSSELine(ev({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"a\":" } })).content).toBe(true);
  });
  it("message_start, an empty text block start, ping, message_stop, error are NOT content", () => {
    for (const o of [
      { type: "message_start", message: { content: [] } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "ping" },
      { type: "message_stop" },
      { type: "error", error: { type: "api_error", message: "x" } },
    ]) expect(inspectSSELine(ev(o)).content).toBe(false);
  });
  it("message_delta stop_reason maps to the hub vocabulary; refusal → content_filter (no-retry)", () => {
    expect(inspectSSELine(ev({ type: "message_delta", delta: { stop_reason: "end_turn" } })).finishReason).toBe("stop");
    const refusal = inspectSSELine(ev({ type: "message_delta", delta: { stop_reason: "refusal" } })).finishReason;
    expect(refusal).toBe("content_filter");
    expect(isNoRetryFinish(refusal)).toBe(true);
  });
});

describe("inspectSSELine — OpenAI Responses client format", () => {
  const fc = { id: "fc_call_1", type: "function_call", arguments: "", call_id: "call_1", name: "f" };
  const ctc = { id: "ctc_call_2", type: "custom_tool_call", input: "", call_id: "call_2", name: "apply_patch" };
  it("response.output_text.delta with text IS content; empty delta is NOT", () => {
    expect(inspectSSELine(ev({ type: "response.output_text.delta", item_id: "msg_1", delta: "hi" })).content).toBe(true);
    expect(inspectSSELine(ev({ type: "response.output_text.delta", item_id: "msg_1", delta: "" })).content).toBe(false);
  });
  it("response.output_text.done with text IS content; empty text is NOT", () => {
    expect(inspectSSELine(ev({ type: "response.output_text.done", item_id: "msg_1", text: "hi" })).content).toBe(true);
    expect(inspectSSELine(ev({ type: "response.output_text.done", item_id: "msg_1", text: "" })).content).toBe(false);
  });
  it("a function_call or custom_tool_call output item (added or done) IS content", () => {
    expect(inspectSSELine(ev({ type: "response.output_item.added", output_index: 0, item: fc })).content).toBe(true);
    expect(inspectSSELine(ev({ type: "response.output_item.done", output_index: 0, item: { ...fc, arguments: "{}" } })).content).toBe(true);
    expect(inspectSSELine(ev({ type: "response.output_item.added", output_index: 0, item: ctc })).content).toBe(true);
  });
  it("function-call argument / custom-tool input deltas with text ARE content; empty ones are NOT", () => {
    expect(inspectSSELine(ev({ type: "response.function_call_arguments.delta", item_id: "fc_call_1", delta: "{\"a\":" })).content).toBe(true);
    expect(inspectSSELine(ev({ type: "response.function_call_arguments.delta", item_id: "fc_call_1", delta: "" })).content).toBe(false);
    expect(inspectSSELine(ev({ type: "response.custom_tool_call_input.delta", item_id: "ctc_call_2", delta: "*** Begin Patch" })).content).toBe(true);
  });
  it("reasoning payload frames are NOT content but ARE activity", () => {
    for (const o of [
      { type: "response.reasoning_summary_text.delta", item_id: "rs_1", summary_index: 0, delta: "thinking" },
      { type: "response.reasoning_summary_text.done", item_id: "rs_1", summary_index: 0, text: "thinking" },
      { type: "response.reasoning_text.delta", item_id: "rs_1", delta: "thinking" },
    ]) {
      expect(inspectSSELine(ev(o)).content).toBe(false);
      expect(inspectSSELine(ev(o)).activity).toBe(true);
    }
  });
  it("a reasoning item counts as activity only when the wire gave it a payload", () => {
    const withSummary = { type: "response.output_item.done", output_index: 0, item: { id: "rs_1", type: "reasoning", summary: [{ type: "summary_text", text: "thinking" }] } };
    const withEncrypted = { type: "response.output_item.added", output_index: 0, item: { id: "rs_1", type: "reasoning", encrypted_content: "Ekg..." } };
    expect(inspectSSELine(ev(withSummary)).content).toBe(false);
    expect(inspectSSELine(ev(withSummary)).activity).toBe(true);
    expect(inspectSSELine(ev(withEncrypted)).activity).toBe(true);
    // blank payload on the item is still nothing
    expect(inspectSSELine(ev({ ...withEncrypted, item: { id: "rs_1", type: "reasoning", encrypted_content: "  " } })).activity).toBe(false);
  });
  it("structural item / part announcements with no payload are neither content nor activity", () => {
    for (const o of [
      { type: "response.output_item.added", output_index: 0, item: { id: "rs_1", type: "reasoning", summary: [] } },
      { type: "response.reasoning_summary_part.added", item_id: "rs_1", summary_index: 0, part: { type: "summary_text", text: "" } },
      { type: "response.reasoning_summary_text.delta", item_id: "rs_1", summary_index: 0, delta: "" },
    ]) {
      expect(inspectSSELine(ev(o)).content).toBe(false);
      expect(inspectSSELine(ev(o)).activity).toBe(false);
    }
  });
  it("response.created, response.in_progress, a message item / empty content part are NOT content", () => {
    for (const o of [
      { type: "response.created", response: { id: "resp_1", status: "in_progress", output: [] } },
      { type: "response.in_progress", response: { id: "resp_1", status: "in_progress" } },
      { type: "response.output_item.added", output_index: 0, item: { id: "msg_1", type: "message", content: [], role: "assistant" } },
      { type: "response.content_part.added", item_id: "msg_1", part: { type: "output_text", text: "" } },
    ]) expect(inspectSSELine(ev(o)).content).toBe(false);
  });
  it("response.completed → stop (retryable when empty)", () => {
    const r = inspectSSELine(ev({ type: "response.completed", response: { id: "resp_1", status: "completed" } }));
    expect(r).toMatchObject({ content: false, finishReason: "stop" });
    expect(isNoRetryFinish(r.finishReason)).toBe(false);
  });
  it("response.incomplete: content_filter → content_filter (no-retry); max_output_tokens → length", () => {
    const filtered = inspectSSELine(ev({ type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "content_filter" } } }));
    expect(filtered).toMatchObject({ content: false, finishReason: "content_filter" });
    expect(isNoRetryFinish(filtered.finishReason)).toBe(true);
    const truncated = inspectSSELine(ev({ type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } } }));
    expect(truncated.finishReason).toBe("length");
  });
  it("response.failed → a finish that falls through (not no-retry)", () => {
    const r = inspectSSELine(ev({ type: "response.failed", response: { status: "failed", error: { code: "server_error", message: "x" } } }));
    expect(r).toMatchObject({ content: false, finishReason: "failed" });
    expect(isNoRetryFinish(r.finishReason)).toBe(false);
  });
});

// Combos through the real combo.js, each member's Response built by the real streaming
// pipeline (upstream bytes → client-format transform), per client format.
describe("combo fall-through per client format (real combo.js + streaming pipeline)", async () => {
  const { createStreamController } = await import("../../open-sse/utils/streamHandler.js");
  const { handleStreamingResponse, buildOnStreamComplete } = await import("../../open-sse/handlers/chatCore/streamingHandler.js");
  const { handleComboChat } = await import("../../open-sse/services/combo.js");
  const { initTranslators } = await import("../../open-sse/translator/index.js");
  const { FORMATS } = await import("../../open-sse/translator/formats.js");
  await initTranslators();

  const LOG = { line: vi.fn(), errorLine: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const memberResponse = async (frames, sourceFormat, targetFormat, model) => {
    const body = { model, stream: true, messages: [{ role: "user", content: "hi" }] };
    const { onStreamComplete, streamDetailId } = buildOnStreamComplete({
      provider: "openai", model, connectionId: "conn", apiKey: "sk-x", requestStartTime: Date.now(), body, stream: true,
      clientRawRequest: { endpoint: "/v1/chat/completions" }, reqTag: "t", log: LOG,
    });
    const res = await handleStreamingResponse({
      providerResponse: new Response(sseStream(frames), { status: 200, headers: { "Content-Type": "text/event-stream" } }),
      provider: "openai", model, sourceFormat, targetFormat, body, stream: true, requestStartTime: Date.now(),
      connectionId: "conn", apiKey: "sk-x", streamController: createStreamController({ log: LOG, provider: "openai", model }),
      onStreamComplete, streamDetailId, reqTag: "t", log: LOG,
    });
    return res.response;
  };
  async function combo(memberFrames, { sourceFormat = FORMATS.OPENAI, targetFormat = FORMATS.OPENAI } = {}) {
    const tried = [];
    const res = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: memberFrames.map((_, i) => `openai/m${i}`),
      handleSingleModel: async (_b, m) => { tried.push(m); return memberResponse(memberFrames[Number(m.slice(-1))], sourceFormat, targetFormat, m); },
      log: LOG, comboName: `c-${Math.random()}`, comboStrategy: "fallback",
    });
    return { out: await res.text(), tried };
  }
  const C = (t) => `data: {"id":"x","choices":[{"index":0,"delta":{"content":"${t}"},"finish_reason":null}]}\n\n`;
  const TOOL = `data: {"id":"xxxxxxxxxx","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"f","arguments":"{}"}}]},"finish_reason":null}]}\n\n`;
  const STOP = `data: {"id":"x","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n`;
  // chat-format provider frames, translated per client format
  const clients = {
    "OpenAI chat": { sourceFormat: FORMATS.OPENAI },
    "Anthropic Messages": { sourceFormat: FORMATS.CLAUDE },
    "OpenAI Responses": { sourceFormat: FORMATS.OPENAI_RESPONSES },
  };
  for (const [name, fmt] of Object.entries(clients)) {
    describe(`${name} client`, () => {
      it("a good first member is committed — the next member is NOT called", async () => {
        const { out, tried } = await combo([[ROLE, C("from-m0"), STOP, DONE], [ROLE, C("from-m1"), STOP, DONE]], fmt);
        expect(tried).toEqual(["openai/m0"]);
        expect(out).toContain("from-m0");
      });
      it("empty-content first member (role + stop), good second → falls through", async () => {
        const { out, tried } = await combo([[ROLE, STOP, DONE], [ROLE, C("from-m1"), STOP, DONE]], fmt);
        expect(tried).toEqual(["openai/m0", "openai/m1"]);
        expect(out).toContain("from-m1");
      });
      it("zero-byte first member, good second → falls through", async () => {
        const { out, tried } = await combo([[], [ROLE, C("from-m1"), STOP, DONE]], fmt);
        expect(tried).toEqual(["openai/m0", "openai/m1"]);
        expect(out).toContain("from-m1");
      });
      it("all members empty → every member is tried, the last one is returned as-is", async () => {
        const { out, tried } = await combo([[ROLE, STOP, DONE], [ROLE, STOP, DONE]], fmt);
        expect(tried).toEqual(["openai/m0", "openai/m1"]);
        expect(out).not.toContain("from-m");
      });
      it("a tool call counts as content", async () => {
        const { tried } = await combo([[ROLE, TOOL, DONE], [ROLE, C("from-m1"), STOP, DONE]], fmt);
        expect(tried).toEqual(["openai/m0"]);
      });
      it("reasoning-only first member is committed (model output, not an empty stream)", async () => {
        // Trade-off documented on deltaHasModelActivity: committing on the first token is
        // what keeps the peek from adding the thinking phase to client TTFT. A think-then-
        // abort no longer fails over; a stream that never emits a token still does.
        const { tried } = await combo([[ROLE, REASONING, STOP, DONE], [ROLE, C("from-m1"), STOP, DONE]], fmt);
        expect(tried).toEqual(["openai/m0"]);
      });
    });
  }
  it("OpenAI chat / Anthropic clients: a content_filter finish is NOT retried", async () => {
    for (const sourceFormat of [FORMATS.OPENAI, FORMATS.CLAUDE]) {
      const { tried } = await combo([[ROLE, FILTER_STOP, DONE], [ROLE, C("from-m1"), STOP, DONE]], { sourceFormat });
      expect(tried).toEqual(["openai/m0"]);
    }
  });

  // Responses provider + Responses client: same-format passthrough of Responses events.
  describe("OpenAI Responses client, Responses provider (passthrough)", () => {
    const RESP = { sourceFormat: FORMATS.OPENAI_RESPONSES, targetFormat: FORMATS.OPENAI_RESPONSES };
    const rev = (o) => `event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`;
    const CREATED = rev({ type: "response.created", response: { id: "resp_1", status: "in_progress", output: [] } });
    const COMPLETED = rev({ type: "response.completed", response: { id: "resp_1", status: "completed" } });
    const TEXT = (t) => rev({ type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: t });
    const FC = rev({ type: "response.output_item.added", output_index: 0, item: { id: "fc_call_1", type: "function_call", arguments: "", call_id: "call_1", name: "f" } });
    const REASON = rev({ type: "response.reasoning_summary_text.delta", item_id: "rs_1", summary_index: 0, delta: "hmm" });
    const FILTERED = rev({ type: "response.incomplete", response: { id: "resp_1", status: "incomplete", incomplete_details: { reason: "content_filter" } } });
    it("good first → only the first member is called", async () => {
      const { out, tried } = await combo([[CREATED, TEXT("from-m0"), COMPLETED], [CREATED, TEXT("from-m1"), COMPLETED]], RESP);
      expect(tried).toEqual(["openai/m0"]);
      expect(out).toContain("from-m0");
    });
    it("empty first (created → completed), good second → falls through", async () => {
      const { out, tried } = await combo([[CREATED, COMPLETED], [CREATED, TEXT("from-m1"), COMPLETED]], RESP);
      expect(tried).toEqual(["openai/m0", "openai/m1"]);
      expect(out).toContain("from-m1");
    });
    it("zero-byte first (response.failed terminal) → falls through, the failure is not forwarded", async () => {
      const { out, tried } = await combo([[], [CREATED, TEXT("from-m1"), COMPLETED]], RESP);
      expect(tried).toEqual(["openai/m0", "openai/m1"]);
      expect(out).toContain("from-m1");
      expect(out).not.toContain("response.failed");
    });
    it("a function_call item counts as content; reasoning-only is committed as activity", async () => {
      expect((await combo([[CREATED, FC, COMPLETED], [CREATED, TEXT("from-m1"), COMPLETED]], RESP)).tried).toEqual(["openai/m0"]);
      expect((await combo([[CREATED, REASON, COMPLETED], [CREATED, TEXT("from-m1"), COMPLETED]], RESP)).tried).toEqual(["openai/m0"]);
    });
    it("response.incomplete (content_filter) is NOT retried", async () => {
      const { out, tried } = await combo([[CREATED, FILTERED], [CREATED, TEXT("from-m1"), COMPLETED]], RESP);
      expect(tried).toEqual(["openai/m0"]);
      expect(out).toContain('"reason":"content_filter"');
    });
  });
});

// TTFT regression: the content peek used to hold the client's stream for the whole
// reasoning phase (until the first visible text or the 45s deadline). It must now
// release as soon as the model emits anything, and not run at all when no failover
// target is left.
describe("combo peek does not add thinking latency", () => {
  const silent = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, line: () => {}, errorLine: () => {} };
  const sseResponse = (frames) => new Response(new ReadableStream({
    start(c) {
      for (const f of frames) c.enqueue(enc.encode(f));
      // deliberately never closed: an upstream that started generating and then stalled
    },
  }), { status: 200, headers: { "content-type": "text/event-stream" } });

  it("commits a reasoning-first stream immediately instead of waiting for text", async () => {
    const res = await Promise.race([
      handleComboChat({
        body: { messages: [{ role: "user", content: "hi" }] },
        models: ["openai/m0", "openai/m1"],
        handleSingleModel: async () => sseResponse([ROLE, REASONING]),
        log: silent, comboName: "peek-latency", comboStrategy: "fallback",
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("combo held a reasoning stream")), 1000)),
    ]);
    expect(res.status).toBe(200);
    const reader = res.body.getReader();
    let head = "";
    while (!head.includes('"reasoning_content":"thinking..."')) {
      const { done, value } = await reader.read();
      if (done) break;
      head += dec.decode(value);
    }
    expect(head).toContain('"reasoning_content":"thinking..."');
    await reader.cancel();
  });

  const sseResponseClosed = (frames) => new Response(new ReadableStream({
    start(c) { for (const f of frames) c.enqueue(enc.encode(f)); c.close(); },
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
  const mkLog = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), line: vi.fn(), errorLine: vi.fn() });

  async function lastSeat(frames, log = mkLog()) {
    const raced = await Promise.race([
      handleComboChat({
        body: { messages: [{ role: "user", content: "hi" }] },
        models: ["openai/only"],
        handleSingleModel: async () => sseResponseClosed(frames),
        log, comboName: `last-${Math.random()}`, comboStrategy: "fallback",
        emptyTurnNotice: true,
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("last candidate was peeked")), 500)),
    ]);
    return { out: await raced.text(), log };
  }

  it("returns the last candidate immediately (no failover target left to decide for)", async () => {
    const stream = new ReadableStream({
      start(c) { c.enqueue(enc.encode(ROLE)); /* never closed: the old peek would park 45s here */ },
    });
    const res = await Promise.race([
      handleComboChat({
        body: { messages: [{ role: "user", content: "hi" }] },
        models: ["openai/only"],
        handleSingleModel: async () => new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } }),
        log: mkLog(), comboName: "peek-last", comboStrategy: "fallback",
        emptyTurnNotice: true,
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("last candidate was peeked")), 500)),
    ]);
    expect(res.status).toBe(200);
    const reader = res.body.getReader();
    expect(dec.decode((await reader.read()).value)).toContain('"role":"assistant"');
    await reader.cancel();
  });

  // Media/search lanes share handleComboChat but not the chat stream shape (codex image
  // models stream their own SSE event types). They opt out, so no tap is attached at all.
  it("a lane without the chat opt-in gets no tap and no empty-turn warning", async () => {
    const frames = [ROLE, EMPTY_STOP, DONE];
    const log = mkLog();
    const res = await handleComboChat({
      body: { prompt: "a cat" },
      models: ["openai/only"],
      handleSingleModel: async () => sseResponseClosed(frames),
      log, comboName: "media-lane", comboStrategy: "fallback",
    });
    expect(await res.text()).toBe(frames.join(""));
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("an answered last seat streams byte-identically and logs no empty-turn warning", async () => {
    const frames = [ROLE, CONTENT, EMPTY_STOP, DONE];
    const { out, log } = await lastSeat(frames);
    expect(out).toBe(frames.join(""));
    expect(log.warn).not.toHaveBeenCalled();
  });

  // The warn the removed last-seat peek used to print, kept alive by a byte-transparent tap.
  it("a last seat that reasoned but never answered still warns, without holding the stream", async () => {
    const frames = [ROLE, REASONING, EMPTY_STOP, DONE];
    const { out, log } = await lastSeat(frames);
    expect(out).toBe(frames.join(""));
    const warnings = log.warn.mock.calls.map((c) => c.slice(1).join(" "));
    expect(warnings.some((w) => /reasoning but never answered/.test(w))).toBe(true);
  });

  it("a last seat that produced no payload at all warns as empty", async () => {
    const frames = [ROLE, EMPTY_STOP, DONE];
    const { out, log } = await lastSeat(frames);
    expect(out).toBe(frames.join(""));
    const warnings = log.warn.mock.calls.map((c) => c.slice(1).join(" "));
    expect(warnings.some((w) => /returned empty \(stop\)/.test(w))).toBe(true);
  });

  it("a non-SSE last seat is returned untouched (no tap, no warn)", async () => {
    const json = new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
      status: 200, headers: { "content-type": "application/json" },
    });
    const log = mkLog();
    const res = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["openai/only"],
      handleSingleModel: async () => json,
      log, comboName: "last-json", comboStrategy: "fallback",
    });
    expect(res).toBe(json);
    expect(log.warn).not.toHaveBeenCalled();
  });
});

// Detect a streamed completion that finished without ever producing a payload, so
// handleComboChat can fall through to the next candidate instead of returning a 200 that
// carries nothing.
//
// Why this exists: Gemini aborts a generation with finishReason MALFORMED_FUNCTION_CALL
// (the model attempts a native function call the API can't serialize). Upstream still
// returns HTTP 200 and streams a terminal frame with empty content, which the translator
// maps to finish_reason "stop". The combo's HTTP-status check then logs "succeeded" and
// the empty response reaches the client.
//
// The signal is STRUCTURAL, not an enum: "no payload frame ever arrived" — where a payload
// is answer text, a tool call, reasoning/thinking text or streamed audio (see
// deltaHasModelActivity). That covers MALFORMED_FUNCTION_CALL, any future abort reason, and a
// stream that simply dies — with no reason vocabulary to keep in sync. The finish-reason enum
// is used only in the inverse: to NOT retry a legitimately-empty content-filter block.
//
// Deliberate limit: reasoning counts as a payload, so a model that thinks and then aborts
// without ever answering is committed rather than replayed on the next candidate. That is the
// price of not holding the client's stream for the whole thinking phase; a turn that produced
// tokens is already billed upstream, so re-running it buys a second charge for a coin flip.
// combo.js notices that shape after the fact (withEmptyTurnNotice) and logs it, so the turn is
// visible to the operator even though it is no longer retried.

import {
  NO_RETRY_EMPTY_FINISH, OPENAI_FINISH, RESPONSES_STATUS, RESPONSES_INCOMPLETE_REASON,
} from "../translator/schema/finishReasons.js";
import { CLAUDE_BLOCK, RESPONSES_ITEM } from "../translator/schema/blocks.js";
import { CLAUDE_EVENT, CLAUDE_DELTA, RESPONSES_EVENT, RESPONSES_EVENT_PREFIX } from "../translator/schema/streamEvents.js";
import { toOpenAIFinish } from "../translator/concerns/finishReason.js";
import { extractReasoningText } from "../translator/concerns/reasoning.js";
import { FORMATS } from "../translator/formats.js";
import { EMPTY_PEEK_DEADLINE_MS, STREAM_STALL_TIMEOUT_MS } from "../config/runtimeConfig.js";
import { parseSSELine } from "../utils/streamHelpers.js";

// OpenAI chat content test. A chunk counts as content only if it carries
// assistant output the caller can consume:
//   * delta.content (non-empty string, or non-empty array of parts)
//   * delta.tool_calls (a real tool call)
// It deliberately does NOT count:
//   * delta.role — 9router emits {role:"assistant"} on the first frame regardless of
//     content; treating it as content would defeat the whole check (and A0's own retry,
//     which is gated on "no chunk received yet").
//   * reasoning_content / delta.reasoning — a think-then-abort produces reasoning only,
//     which is not client-usable content. It IS model activity though: the peek commits
//     on it (deltaHasModelActivity) so a thinking turn is not held until its first text.
// A blank-only payload counts as neither, matching the non-streaming JSON verdict
// (combo.js isZeroContentResponse trims before asking the same question); the peek then
// keeps waiting for the next frame, which costs one frame of latency, not the turn.
const nonEmptyString = (s) => typeof s === "string" && s.trim().length > 0;

export function deltaHasClientContent(delta) {
  if (!delta || typeof delta !== "object") return false;
  const c = delta.content;
  if (nonEmptyString(c)) return true;
  if (Array.isArray(c) && c.length > 0) return true;
  if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) return true;
  // Legacy function calling (pre-tool_calls wire shape) is still streamed by some
  // OpenAI-compatible gateways.
  const fc = delta.function_call;
  if (fc && typeof fc === "object" && (nonEmptyString(fc.name) || nonEmptyString(fc.arguments))) return true;
  // OpenAI "Responses" style / non-chat deltas occasionally use output_text
  if (nonEmptyString(delta.output_text)) return true;
  return false;
}

/**
 * Model activity: a frame carrying generated payload the model actually produced —
 * answer text, a tool call, reasoning, or audio. This is the peek's ONE commit signal:
 * once a frame carries activity the candidate is kept, whether that frame arrives mid
 * stream or as the stream's last fragment.
 *
 * `deltaHasClientContent` stays the narrower "would the client get anything usable"
 * question (activity is defined as content ∪ reasoning), and both answers are reported
 * by inspectSSELine so the two concepts stay readable at the call sites and in tests.
 *
 * Invariant: every signal must carry a NON-BLANK payload. Pure structural frames
 * (delta.role, an empty content block start, an item/part announcement) never commit:
 * 9router emits some of them on every request, and an empty 200 would otherwise look
 * like a finished generation and never fail over. A part array counts as a payload even
 * when a part's own text is blank, which is exactly how the JSON verdict reads it.
 *
 * Why reasoning commits: holding a thinking stream until its first text delta adds the
 * whole thinking phase to the caller's TTFT (measured end to end through handleChat:
 * first client byte 1569ms → 271ms for a 1.5s thinking turn, identical bytes delivered),
 * and a long reasoning turn can sit there for most of the 45s peek deadline even though
 * the upstream started streaming at once. The non-streaming JSON path already treated
 * reasoning as usable output (combo.js isZeroContentResponse), so this also makes the two
 * agree.
 */
export function deltaHasModelActivity(delta) {
  if (deltaHasClientContent(delta)) return true;
  if (!delta || typeof delta !== "object") return false;
  // reasoning_content (DeepSeek/MiniMax/GLM), reasoning (some compat layers),
  // reasoning_details[] — the vendor vocabulary lives in one helper (concerns/reasoning).
  if (extractReasoningText(delta).trim().length > 0) return true;
  // Streaming audio output (gpt-4o-audio style) — bytes or a transcript, not an empty handle.
  // Both this arm and the legacy function_call one above only ever fire for client formats
  // whose stream keeps every chunk (streamHelpers.hasValuableContent returns true for
  // anything that is neither OpenAI-chat nor Anthropic shaped — Gemini, Ollama, Antigravity);
  // on the two structured formats a payload-less handle is filtered before it reaches here.
  const audio = delta.audio;
  if (audio && typeof audio === "object" && (nonEmptyString(audio.data) || nonEmptyString(audio.transcript))) return true;
  return false;
}

// The peek reads the CLIENT-format stream: OpenAI chat (/v1/chat/completions), Anthropic
// Messages (/v1/messages) or OpenAI Responses (/v1/responses). Two decisions come out of
// every frame: `content` (answer text / tool call — would the client get anything usable)
// and `activity` (content OR a reasoning/audio payload — has the model started generating).
// The peek commits on activity. A seat is only judged an empty generation when it ENDS with
// no activity at all; a seat that opens the stream and then goes quiet hits the peek deadline
// and is committed fail-open (preferring a slow answer over discarding a live upstream).
// A format the peek cannot read shows neither, so every one of its members would be judged
// empty in turn. Finish reasons are reported in the hub (OpenAI) vocabulary so
// isNoRetryFinish applies to every format.

// Anthropic Messages event.
function inspectClaudeEvent(obj) {
  let content = false, activity = false, finishReason = null;
  if (obj.type === CLAUDE_EVENT.CONTENT_BLOCK_DELTA) {
    const d = obj.delta || {};
    if (d.type === CLAUDE_DELTA.TEXT && nonEmptyString(d.text)) content = true;
    if (d.type === CLAUDE_DELTA.INPUT_JSON && nonEmptyString(d.partial_json)) content = true;
    if (d.type === CLAUDE_DELTA.THINKING && nonEmptyString(d.thinking)) activity = true;
  } else if (obj.type === CLAUDE_EVENT.CONTENT_BLOCK_START) {
    const b = obj.content_block || {};
    if (b.type === CLAUDE_BLOCK.TOOL_USE) content = true;
    if (b.type === CLAUDE_BLOCK.TEXT && nonEmptyString(b.text)) content = true;
    // Only a start frame that already carries thinking text commits — an empty
    // content_block_start is structural (see the deltaHasModelActivity invariant).
    if (b.type === CLAUDE_BLOCK.THINKING && nonEmptyString(b.thinking)) activity = true;
    if (b.type === CLAUDE_BLOCK.REDACTED_THINKING && nonEmptyString(b.data)) activity = true;
  } else if (obj.type === CLAUDE_EVENT.MESSAGE_DELTA && obj.delta?.stop_reason) {
    // refusal → content_filter (the translator renders content_filter as refusal for Claude clients)
    finishReason = toOpenAIFinish(obj.delta.stop_reason, FORMATS.CLAUDE);
  }
  return { content, activity: activity || content, finishReason };
}

// OpenAI Responses event. Tool calls are function_call / custom_tool_call output items or
// their argument deltas. Terminal events: completed → stop; incomplete → content_filter
// (no-retry) or length by incomplete_details.reason; failed → "failed" (retryable).
const RESPONSES_TOOL_ITEMS = new Set([RESPONSES_ITEM.FUNCTION_CALL, RESPONSES_ITEM.CUSTOM_TOOL_CALL]);
const RESPONSES_INCOMPLETE_FINISH = {
  [RESPONSES_INCOMPLETE_REASON.CONTENT_FILTER]: OPENAI_FINISH.CONTENT_FILTER,
  [RESPONSES_INCOMPLETE_REASON.MAX_OUTPUT_TOKENS]: OPENAI_FINISH.LENGTH,
};
function inspectResponsesEvent(obj) {
  let content = false, activity = false, finishReason = null;
  switch (obj.type) {
    case RESPONSES_EVENT.OUTPUT_TEXT_DELTA:
    case RESPONSES_EVENT.FUNCTION_CALL_ARGUMENTS_DELTA:
    case RESPONSES_EVENT.CUSTOM_TOOL_CALL_INPUT_DELTA:
      content = nonEmptyString(obj.delta);
      break;
    case RESPONSES_EVENT.OUTPUT_TEXT_DONE:
      content = nonEmptyString(obj.text);
      break;
    case RESPONSES_EVENT.OUTPUT_ITEM_ADDED:
    case RESPONSES_EVENT.OUTPUT_ITEM_DONE:
      content = RESPONSES_TOOL_ITEMS.has(obj.item?.type);
      // A reasoning item with no summary deltas yet still carried payload when the wire
      // gave it encrypted_content or a summary: that turn was billed and is not empty.
      if (obj.item?.type === RESPONSES_ITEM.REASONING) {
        activity = nonEmptyString(obj.item?.encrypted_content)
          || (Array.isArray(obj.item?.summary) && obj.item.summary.some((s) => nonEmptyString(s?.text)));
      }
      break;
    // Reasoning payloads: encrypted text or its summary. The item / part announcement
    // frames around them are structural and never commit on their own.
    case RESPONSES_EVENT.REASONING_TEXT_DELTA:
    case RESPONSES_EVENT.REASONING_SUMMARY_TEXT_DELTA:
      activity = nonEmptyString(obj.delta);
      break;
    case RESPONSES_EVENT.REASONING_SUMMARY_TEXT_DONE:
      activity = nonEmptyString(obj.text);
      break;
    case RESPONSES_EVENT.COMPLETED:
      finishReason = OPENAI_FINISH.STOP;
      break;
    case RESPONSES_EVENT.INCOMPLETE:
      finishReason = RESPONSES_INCOMPLETE_FINISH[obj.response?.incomplete_details?.reason] || RESPONSES_STATUS.INCOMPLETE;
      break;
    case RESPONSES_EVENT.FAILED:
      finishReason = RESPONSES_STATUS.FAILED;
      break;
  }
  return { content, activity: activity || content, finishReason };
}

// Inspect one complete client-format SSE line (parsed with the shared parseSSELine) and report
// whether it carries content, model activity (content or reasoning), and/or a finish reason.
// Non-data lines and "[DONE]" carry nothing.
export function inspectSSELine(line) {
  const parsed = parseSSELine(line.trimStart());
  if (!parsed || parsed.done) return { content: false, activity: false, finishReason: null };
  if (typeof parsed.type === "string" && !Array.isArray(parsed.choices)) {
    return parsed.type.startsWith(RESPONSES_EVENT_PREFIX) ? inspectResponsesEvent(parsed) : inspectClaudeEvent(parsed);
  }
  let content = false, activity = false, finishReason = null;
  for (const choice of parsed.choices || []) {
    const delta = choice.delta || choice.message || {};
    if (deltaHasClientContent(delta)) content = true;
    if (deltaHasModelActivity(delta)) activity = true;
    if (choice.finish_reason) finishReason = choice.finish_reason;
  }
  return { content, activity: activity || content, finishReason };
}

// Scan the COMPLETE lines of a decoded SSE buffer and update the running decision.
// The trailing fragment (a line still being received) is not parsed — it is returned in
// `state.pending` for the caller to prepend to the next chunk. Both latches are reported:
// `sawActivity` (any payload — what the peek commits on) and `sawContent` (payload the
// client can actually use, so a reasoning-only turn is distinguishable after the fact).
export function scanSSEBuffer(text, state = { sawContent: false, sawActivity: false, finishReason: null }) {
  const lines = text.split("\n");
  state.pending = lines.pop();
  for (const line of lines) {
    const info = inspectSSELine(line);
    if (info.content) state.sawContent = true;
    if (info.activity) state.sawActivity = true;
    if (info.finishReason) state.finishReason = info.finishReason;
  }
  return state;
}

// True when a finished, content-less stream should NOT be retried because the emptiness
// is legitimate and would recur on every candidate (safety / recitation / blocklist /
// prohibited-content). Everything else that finished empty is retryable.
export function isNoRetryFinish(finishReason) {
  if (!finishReason) return false;
  return NO_RETRY_EMPTY_FINISH.has(String(finishReason).toLowerCase());
}

// Peek a streaming Response body: read frames until the first model-output frame (→ "content"),
// the stream ends (→ "empty"), or the deadline elapses (→ "content", fail-open: never hold a
// possibly-valid slow stream). "Model output" is deltaHasModelActivity — content OR a reasoning
// payload — which is what keeps the peek from adding the whole thinking phase to the client's
// TTFT. Returns the decision, the buffered head bytes, the live reader, and — if the deadline
// fired mid-read — the still-pending read() (`pendingRead`) so the caller can resume from it
// WITHOUT abandoning the chunk it will deliver.
export async function peekStreamForContent(body, { deadlineMs = EMPTY_PEEK_DEADLINE_MS } = {}) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const headChunks = [];
  const state = { sawContent: false, sawActivity: false, finishReason: null };
  let textBuf = "";

  // Clamp: 0 / NaN / negative would otherwise disable the timeout and let a stalled-but-open
  // upstream hang the request forever in the hot path. There is no "disable" via this value.
  const validDeadline = Number.isFinite(deadlineMs) && deadlineMs > 0 ? deadlineMs : EMPTY_PEEK_DEADLINE_MS;
  let timer = null;
  const deadline = new Promise((resolve) => { timer = setTimeout(() => resolve("__deadline__"), validDeadline); });
  const settle = (ret) => { if (timer) { clearTimeout(timer); timer = null; } return ret; };

  let pendingRead = null;
  // A reasoning-heavy model can stream megabytes of thinking; without a cap the head
  // buffer grows with it for the whole peek window. Over-cap is treated as content
  // (fail-open commit), same as the deadline: the stream is presumed valid and handed
  // to the client.
  let headBytes = 0;
  const HEAD_CAP_BYTES = 1024 * 1024;
  while (true) {
    if (!pendingRead) pendingRead = reader.read();
    let res;
    try {
      res = await Promise.race([pendingRead, deadline]);
    } catch (err) {
      // Upstream errored mid-peek. Body is locked to this reader; hand it back so the caller
      // can reconstruct (the replay will surface the same error). The failed read is consumed.
      pendingRead = null;
      return settle({ outcome: state.sawActivity ? "content" : "empty", timedOut: false, head: headChunks, reader, pendingRead: null, finishReason: state.finishReason, error: err });
    }
    if (res === "__deadline__") {
      // Fail-open: commit whatever we have. Hand the STILL-PENDING read to the caller so its
      // chunk is replayed, not dropped (fixes the content-dropping deadline race).
      //
      // The peek's own timer is cleared here, and the handed-off read may never settle —
      // an upstream that opened the stream, sent a frame, then froze would hang
      // reconstructStream's pull() (and the client's stream) with NO ceiling at all. The
      // resumed read therefore gets the same stall budget any other stream frame gets.
      clearTimeout(timer);
      timer = null;
      const resumedRead = new Promise((resolve) => {
        const stall = setTimeout(() => resolve({ done: true, value: undefined }), STREAM_STALL_TIMEOUT_MS);
        // A reconstructed stream that the caller never drains would otherwise keep
        // this 6-minute timer (and the process) alive after the request is gone.
        stall.unref?.();
        pendingRead.then(
          (r) => { clearTimeout(stall); resolve(r); },
          (err) => { clearTimeout(stall); resolve(Promise.reject(err)); }
        );
      });
      return { outcome: "content", timedOut: true, head: headChunks, reader, pendingRead: resumedRead, finishReason: state.finishReason };
    }
    const { done, value } = res;
    pendingRead = null;
    if (done) {
      if (textBuf) scanSSEBuffer(textBuf + "\n", state); // final line without a trailing newline
      return settle({ outcome: state.sawActivity ? "content" : "empty", timedOut: false, head: headChunks, reader, pendingRead: null, finishReason: state.finishReason });
    }
    headChunks.push(value);
    headBytes += value.byteLength;
    textBuf += decoder.decode(value, { stream: true });
    scanSSEBuffer(textBuf, state);
    textBuf = state.pending; // only the not-yet-complete line carries over
    if (state.sawActivity || headBytes > HEAD_CAP_BYTES) {
      return settle({ outcome: "content", timedOut: false, head: headChunks, reader, pendingRead: null, finishReason: state.finishReason });
    }
  }
}

// Rebuild a ReadableStream that replays the buffered head bytes, then the handed-off in-flight
// read (if the peek ended on a deadline), then whatever remains from the reader. Sequential —
// only ever one outstanding reader.read() at a time.
export function reconstructStream(head, reader, pendingRead = null) {
  let pending = pendingRead;
  return new ReadableStream({
    start(controller) {
      for (const chunk of head) controller.enqueue(chunk);
    },
    async pull(controller) {
      let result;
      if (pending) { result = await pending; pending = null; }
      else { result = await reader.read(); }
      const { done, value } = result;
      if (done) { controller.close(); return; }
      controller.enqueue(value);
    },
    cancel(reason) {
      try { reader.cancel(reason); } catch { /* already closed */ }
    },
  });
}

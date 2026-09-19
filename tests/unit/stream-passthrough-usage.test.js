/**
 * Passthrough stream invariants — engine-wide, and the shape Trae SOLO emits
 * (usage frame before the finish frame, upstream's own [DONE]).
 *
 * Two regressions pinned here:
 *   1. flush() appended a second [DONE] after upstream's sentinel, so clients
 *      saw the stream terminate twice.
 *   2. The finish chunk's usage was always a character-count estimate, which
 *      discarded the real counts that already arrived and billed the estimate.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
}));

const { createSSEStream } = await import("open-sse/utils/stream.js");
const BUFFER_TOKENS = 2000;

function chunk(delta, extra = {}) {
  return `data: ${JSON.stringify({ id: "chatcmpl-abcdef0123456", object: "chat.completion.chunk", choices: [{ index: 0, delta, ...extra }] })}\n\n`;
}

async function runPassthrough(frames, options = {}) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const stream = createSSEStream({
    mode: "passthrough",
    provider: "trae-enterprise",
    model: "glm-5.1",
    body: { model: "glm-5.1", messages: [{ role: "user", content: "hi" }] },
    ...options,
  });
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();

  const collected = (async () => {
    let out = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return out;
      out += decoder.decode(value, { stream: true });
    }
  })();

  for (const frame of frames) await writer.write(encoder.encode(frame));
  await writer.close();
  const raw = await collected;

  return {
    raw,
    doneCount: (raw.match(/\[DONE\]/g) || []).length,
    dataChunks: raw
      .split("\n")
      .filter((l) => l.startsWith("data: ") && l !== "data: [DONE]")
      .map((l) => JSON.parse(l.slice(6))),
  };
}

describe("passthrough [DONE] handling", () => {
  it("forwards upstream's sentinel exactly once", async () => {
    const { doneCount } = await runPassthrough([
      chunk({ content: "hello" }),
      chunk({}, { finish_reason: "stop" }),
      "data: [DONE]\n\n",
    ]);
    expect(doneCount).toBe(1);
  });

  it("synthesizes the sentinel when upstream never sends one", async () => {
    const { doneCount } = await runPassthrough([
      chunk({ content: "hello" }),
      chunk({}, { finish_reason: "stop" }),
    ]);
    expect(doneCount).toBe(1);
  });
});

describe("passthrough usage on the finish chunk", () => {
  it("keeps real usage that arrived before the finish chunk", async () => {
    let completed = null;
    const { dataChunks } = await runPassthrough(
      [
        chunk({ content: "x".repeat(400) }),
        `data: ${JSON.stringify({ usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } })}\n\n`,
        chunk({}, { finish_reason: "stop" }),
        "data: [DONE]\n\n",
      ],
      { onStreamComplete: (payload, usage) => { completed = usage; } },
    );

    const finish = dataChunks[dataChunks.length - 1];
    expect(finish.choices[0].finish_reason).toBe("stop");
    // An estimate would report ~100 completion tokens for 400 chars and no real prompt count.
    expect(finish.usage).toMatchObject({ prompt_tokens: 100 + BUFFER_TOKENS, completion_tokens: 50 });
    expect(finish.usage.estimated).toBeFalsy();
    // Billing must use the upstream counts, not the estimate.
    expect(completed).toMatchObject({ prompt_tokens: 100, completion_tokens: 50 });
  });

  it("still estimates when the provider reports no usage", async () => {
    let completed = null;
    const { dataChunks } = await runPassthrough(
      [
        chunk({ content: "x".repeat(400) }),
        chunk({}, { finish_reason: "stop" }),
        "data: [DONE]\n\n",
      ],
      { onStreamComplete: (payload, usage) => { completed = usage; } },
    );

    const finish = dataChunks[dataChunks.length - 1];
    // 400 chars of output => 100 tokens; the buffer only applies to the input side.
    expect(finish.usage).toMatchObject({ completion_tokens: 100, estimated: true });
    expect(finish.usage.prompt_tokens).toBeGreaterThan(BUFFER_TOKENS);
    expect(completed).toMatchObject({ estimated: true });
  });
});

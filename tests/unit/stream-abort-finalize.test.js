/**
 * A client that disconnects mid-stream cancels the upstream fetch, so the
 * transform's flush() never runs. Nothing else called the usage tail, which
 * meant the tokens the upstream had already spent were billed to no record at
 * all — the ledger, the request detail and the "📊 done" line simply vanished.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
}));

const { createSSEStream } = await import("open-sse/utils/stream.js");

const encoder = new TextEncoder();

function chunk(delta, extra = {}) {
  return `data: ${JSON.stringify({ id: "chatcmpl-abcdef0123456", object: "chat.completion.chunk", choices: [{ index: 0, delta, ...extra }] })}\n\n`;
}

async function tick() {
  await new Promise(resolve => setTimeout(resolve, 0));
}

// The readable side has no highWaterMark, so a write only advances once something
// pulls the transformed bytes out — a test that never reads stalls on writer.write().
function attachReader(stream) {
  const reader = stream.readable.getReader();
  const drain = (async () => {
    for (;;) {
      try {
        const { done } = await reader.read();
        if (done) return;
      } catch {
        return;
      }
    }
  })();
  return { reader, drain };
}

describe("stream teardown on abort", () => {
  it("runs the usage tail when the client disconnects before [DONE]", async () => {
    const ctrl = new AbortController();
    const completed = [];
    const stream = createSSEStream({
      mode: "passthrough",
      provider: "trae-enterprise",
      model: "glm-5.1",
      body: { model: "glm-5.1", messages: [{ role: "user", content: "hi" }] },
      abortSignal: ctrl.signal,
      onStreamComplete: (payload, usage, _ttft, meta) => completed.push({ payload, usage, meta }),
    });

    attachReader(stream);
    const writer = stream.writable.getWriter();
    await writer.write(encoder.encode(chunk({ content: "x".repeat(400) })));
    await tick();
    await tick();

    ctrl.abort(new Error("client closed"));
    await tick();

    expect(completed).toHaveLength(1);
    const { payload, usage, meta } = completed[0];
    expect(payload.content).toBe("x".repeat(400));
    expect(usage.estimated).toBe(true);
    expect(usage.completion_tokens).toBe(100);
    // What gets recorded is the real estimate, without the client-facing pad.
    expect(usage.prompt_tokens).toBeLessThan(2000);
    // The tail knows it was cut short, so the detail row is not filed as a success.
    expect(meta.aborted).toBe(true);
  });

  it("fires the tail exactly once when the terminal event and the abort race", async () => {
    const ctrl = new AbortController();
    const completed = [];
    const stream = createSSEStream({
      mode: "passthrough",
      provider: "trae-enterprise",
      model: "glm-5.1",
      body: { model: "glm-5.1", messages: [] },
      abortSignal: ctrl.signal,
      onStreamComplete: (payload, usage, _ttft, meta) => completed.push({ usage, meta }),
    });

    const { drain } = attachReader(stream);
    const writer = stream.writable.getWriter();
    await writer.write(encoder.encode(chunk({ content: "hello" })));
    await writer.write(encoder.encode("data: [DONE]\n\n"));
    await writer.close();
    await tick();
    ctrl.abort(new Error("client closed"));
    await tick();

    expect(completed).toHaveLength(1);
    // The stream finished on its own before the abort landed, so it stays a success.
    expect(completed[0].meta.aborted).toBe(false);
    await drain;
  });

  it("finalizes immediately for a signal that is already aborted", async () => {
    const ctrl = new AbortController();
    ctrl.abort(new Error("already gone"));
    const completed = [];

    createSSEStream({
      mode: "passthrough",
      provider: "trae-enterprise",
      model: "glm-5.1",
      body: { model: "glm-5.1", messages: [] },
      abortSignal: ctrl.signal,
      onStreamComplete: (payload, usage) => completed.push(usage),
    });

    // No tokens crossed the wire, so the tail records the request as spent-zero
    // rather than dropping it.
    expect(completed).toHaveLength(1);
    expect(completed[0]).toBeNull();
  });
});

/**
 * An upstream that fails after HTTP 200 was already committed says so in-band
 * (`data: {"error":…}`, `{type:"error",…}`, `response.failed`). The stream used to
 * forward that frame and then file the request as a success with
 * "[Empty streaming response]", so every free-tier gate and mid-stream refusal was
 * invisible in the request detail, the failure stats and the monitor's error badge.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
}));

const { createSSEStream } = await import("open-sse/utils/stream.js");
const { buildOnStreamComplete } = await import("open-sse/handlers/chatCore/streamingHandler.js");
const { saveRequestDetail } = await import("@/lib/usageDb.js");

const encoder = new TextEncoder();

function attachReader(stream) {
  const reader = stream.readable.getReader();
  const decoder = new TextDecoder();
  const chunks = [];
  const drain = (async () => {
    for (;;) {
      try {
        const { done, value } = await reader.read();
        if (done) return;
        chunks.push(decoder.decode(value, { stream: true }));
      } catch {
        return;
      }
    }
  })();
  return { drain, text: () => chunks.join("") };
}

async function tick() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// Drive a passthrough stream (OpenAI client + OpenAI provider, what the OpenCode CLI
// transport produces) and return what the tail callback saw.
async function passthrough(lines) {
  const completed = [];
  const stream = createSSEStream({
    mode: "passthrough",
    provider: "opencode",
    model: "muse-spark-1.3-contributor-free",
    body: { model: "muse-spark-1.3-contributor-free", messages: [{ role: "user", content: "hi" }] },
    onStreamComplete: (payload, usage, _ttft, meta) => completed.push({ payload, usage, meta }),
  });
  const { drain, text } = attachReader(stream);
  const writer = stream.writable.getWriter();
  for (const line of lines) await writer.write(encoder.encode(`${line}\n\n`));
  await writer.close();
  await drain;
  await tick();
  return { completed: completed[0], clientSaw: text() };
}

const content = (t) => `data: ${JSON.stringify({
  id: "chatcmpl-abcdef0123456", object: "chat.completion.chunk",
  choices: [{ index: 0, delta: { content: t }, finish_reason: null }],
})}`;

describe("in-band stream error detection", () => {
  it("records the message and the upstream status instead of a success", async () => {
    const { completed, clientSaw } = await passthrough([
      content("partial"),
      `data: ${JSON.stringify({ error: { message: "This model is not available in your country [RegionError]", type: "opencode_cli_error", code: "403", status: 403 } })}`,
    ]);
    expect(completed.meta.streamError).toEqual({
      message: "This model is not available in your country [RegionError]",
      status: 403,
    });
    // The client keeps receiving the frame verbatim; only the bookkeeping changes.
    expect(clientSaw).toContain("RegionError");
    expect(completed.payload.content).toBe("partial");
  });

  it("keeps usage billing for a turn that failed in-band", async () => {
    const { completed } = await passthrough([
      `data: ${JSON.stringify({ id: "chatcmpl-abcdef0123456", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "x".repeat(400) } }] })}`,
      `data: ${JSON.stringify({ error: { message: "free tier rejected" } })}`,
    ]);
    expect(completed.meta.streamError.message).toBe("free tier rejected");
    expect(completed.meta.streamError.status).toBeNull();
    expect(completed.usage).toBeTruthy();
  });

  it("treats a Responses response.failed terminal and a string error as failures", async () => {
    const failed = await passthrough([
      `data: ${JSON.stringify({ type: "response.failed", response: { id: "r1", status: "failed", error: { code: "server_error", message: "upstream exploded" } } })}`,
    ]);
    expect(failed.completed.meta.streamError.message).toBe("upstream exploded");
    const str = await passthrough([`data: ${JSON.stringify({ error: "quota exceeded" })}`]);
    expect(str.completed.meta.streamError.message).toBe("quota exceeded");
  });

  it("does not invent a failure out of an inert error field", async () => {
    for (const line of [
      `data: ${JSON.stringify({ error: null })}`,
      `data: ${JSON.stringify({ error: {} })}`,
      `data: ${JSON.stringify({ response: { id: "r1", status: "completed", error: null } })}`,
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }], error: undefined })}`,
    ]) {
      const { completed } = await passthrough([line]);
      expect(completed.meta.streamError).toBeFalsy();
    }
  });

  it("flags the same failure in translate mode (claude client, openai provider)", async () => {
    const completed = [];
    const stream = createSSEStream({
      mode: "translate",
      targetFormat: "claude",
      sourceFormat: "openai",
      provider: "opencode",
      model: "big-pickle",
      body: { model: "big-pickle", messages: [] },
      onStreamComplete: (payload, usage, _ttft, meta) => completed.push(meta),
    });
    const { drain } = attachReader(stream);
    const writer = stream.writable.getWriter();
    await writer.write(encoder.encode(`${content("hi")}\n\n`));
    await writer.write(encoder.encode(`data: ${JSON.stringify({ error: { message: "FreeTierError", status: 403 } })}\n\n`));
    await writer.close();
    await drain;
    await tick();
    expect(completed[0].streamError).toEqual({ message: "FreeTierError", status: 403 });
  });

  it("files the request detail as an error, keeping the tokens that were spent", () => {
    const { onStreamComplete } = buildOnStreamComplete({
      provider: "opencode", model: "muse-spark-1.3-contributor-free", connectionId: "conn-1",
      requestStartTime: Date.now(), body: { messages: [] }, stream: true,
      translatedBody: null, finalBody: null, perf: {},
    });
    saveRequestDetail.mockClear();
    onStreamComplete({ content: "partial" }, { prompt_tokens: 100, completion_tokens: 5 }, Date.now(), {
      aborted: false, streamError: { message: "Session not found", status: null },
    });
    const row = saveRequestDetail.mock.calls[0][0];
    expect(row.status).toBe("error");
    expect(row.response.error).toBe("Session not found");
    expect(row.response.status).toBe(502);
    expect(row.tokens).toEqual({ prompt_tokens: 100, completion_tokens: 5 });

    saveRequestDetail.mockClear();
    onStreamComplete({ content: "done" }, { prompt_tokens: 1, completion_tokens: 1 }, Date.now(), { aborted: false });
    expect(saveRequestDetail.mock.calls[0][0].status).toBe("success");
    expect(saveRequestDetail.mock.calls[0][0].response.error).toBeUndefined();
  });
});

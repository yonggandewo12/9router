/**
 * Unit tests for qoder billing error detection.
 *
 * Ensures that billing blocks (code 112, 10605, pricingUrl) are detected
 * on the first SSE frame and returned as 403 responses so chatCore can
 * mark the connection unavailable and trigger combo failover.
 */

import { describe, it, expect } from "vitest";
import { QoderExecutor, __test__ as qoderExecutorInternals } from "../../open-sse/executors/qoder.js";
import { parseSSEToOpenAIResponse } from "../../open-sse/handlers/chatCore/sseToJsonHandler.js";

async function readAll(response) {
  const decoder = new TextDecoder();
  let buf = "";
  const reader = response.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
  }
  return buf + decoder.decode();
}

describe("isBillingBlock", () => {
  const { isBillingBlock } = qoderExecutorInternals;

  it("detects code 112 (quota exhausted)", () => {
    const msg = '{"code":"112","message":"Quota exhausted","pricingUrl":"..."}';
    expect(isBillingBlock(msg)).toBe(true);
  });

  it("detects code 10605 (queue throttle)", () => {
    const msg = '{"code":"10605","message":"Queue limit"}';
    expect(isBillingBlock(msg)).toBe(true);
  });

  it("detects pricingUrl field", () => {
    const msg = '{"message":"Upgrade required","pricingUrl":"https://..."}';
    expect(isBillingBlock(msg)).toBe(true);
  });

  it("returns false for normal errors without billing markers", () => {
    const msg = '{"code":"500","message":"Internal error"}';
    expect(isBillingBlock(msg)).toBe(false);
  });

  it("returns false for empty or non-string input", () => {
    expect(isBillingBlock("")).toBe(false);
    expect(isBillingBlock(null)).toBe(false);
    expect(isBillingBlock(undefined)).toBe(false);
  });

  it("detects an escaped nested block (real qoder 403 → 10605 envelope)", () => {
    const msg = '{"code":"403","message":"{\\"code\\":\\"10605\\",\\"message\\":\\"{\\\\\\"isQueued\\\\\\":true}\\",\\"retryAfterSeconds\\":30}"}';
    expect(isBillingBlock(msg)).toBe(true);
  });
});

describe("parseQueueRetryAfterMs", () => {
  const { parseQueueRetryAfterMs } = qoderExecutorInternals;

  it("uses the upstream retryAfterSeconds for a 10605 throttle", () => {
    const text = '{"code":"403","message":"{\\"code\\":\\"10605\\",\\"retryAfterSeconds\\":30}"}';
    expect(parseQueueRetryAfterMs(text)).toBe(30_000);
  });

  it("returns null when there is no duration to trust", () => {
    expect(parseQueueRetryAfterMs('{"code":"10605","message":"Queue limit"}')).toBeNull();
  });

  it("returns null for a real billing block (code 112)", () => {
    expect(parseQueueRetryAfterMs('{"code":"112","retryAfterSeconds":30}')).toBeNull();
  });

  it("reports the raw duration — markAccountUnavailable owns the cap", () => {
    expect(parseQueueRetryAfterMs('{"code":"10605","retryAfterSeconds":999999}')).toBe(999999_000);
  });
});

describe("wrapQoderSSE billing detection", () => {
  const { wrapQoderSSE } = qoderExecutorInternals;

  function makeResponse(lines, { status = 200 } = {}) {
    const body = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        for (const line of lines) controller.enqueue(encoder.encode(line));
        controller.close();
      },
    });
    return new Response(body, { status });
  }

  it("returns 403 response when first frame is billing block (code 112)", async () => {
    const billingEnv = JSON.stringify({
      statusCodeValue: 403,
      body: '{"code":"112","message":"Quota exhausted","pricingUrl":"https://qoder.sh/pricing"}',
    });
    const upstream = `data: ${billingEnv}\n\n`;

    const wrapped = await wrapQoderSSE(makeResponse([upstream]), "qoder/ultimate");

    expect(wrapped.status).toBe(403);
    expect(wrapped.ok).toBe(false);
    const json = await wrapped.json();
    expect(json.error).toBeDefined();
    expect(json.error.message).toContain("112");
  });

  it("returns 403 response when first frame is billing block (code 10605)", async () => {
    const billingEnv = JSON.stringify({
      statusCodeValue: 429,
      body: '{"code":"10605","message":"Queue limit"}',
    });
    const upstream = `data: ${billingEnv}\n\n`;

    const wrapped = await wrapQoderSSE(makeResponse([upstream]), "qoder/ultimate");

    expect(wrapped.status).toBe(403);
    expect(wrapped.ok).toBe(false);
  });

  it("returns 403 response when first frame has pricingUrl", async () => {
    const billingEnv = JSON.stringify({
      statusCodeValue: 402,
      body: '{"message":"Payment required","pricingUrl":"https://..."}',
    });
    const upstream = `data: ${billingEnv}\n\n`;

    const wrapped = await wrapQoderSSE(makeResponse([upstream]), "qoder/ultimate");

    expect(wrapped.status).toBe(403);
  });

  it("passes through normal errors (non-billing) as wrapped SSE", async () => {
    const errorEnv = JSON.stringify({
      statusCodeValue: 500,
      body: "Internal server error",
    });
    const upstream = `data: ${errorEnv}\n\n`;

    const wrapped = await wrapQoderSSE(makeResponse([upstream]), "qoder/ultimate");

    // Normal error: still 200 response, error text in SSE body
    expect(wrapped.status).toBe(200);
    expect(wrapped.ok).toBe(true);

    const buf = await readAll(wrapped);
    expect(buf).toContain("[qoder error 500");
    expect(buf).toContain("data: [DONE]");
  });

  it("detects a billing block behind a leading heartbeat line", async () => {
    // The peek must skip non-data lines, not re-scan the first one forever.
    const billingEnv = JSON.stringify({
      statusCodeValue: 403,
      body: '{"code":"403","message":"{\\"code\\":\\"10605\\",\\"retryAfterSeconds\\":30}"}',
    });

    const wrapped = await wrapQoderSSE(
      makeResponse([": keepalive\n\n", `data: ${billingEnv}\n\n`]),
      "qoder/ultimate",
    );

    expect(wrapped.status).toBe(403);
    expect(wrapped.ok).toBe(false);
  });

  it("stops peeking at the buffer cap and still surfaces the later error in-band", async () => {
    // A keepalive-only upstream must not make the pre-frame peek buffer forever:
    // detection is abandoned, the replayed heartbeats stay dropped, and the
    // billing envelope that follows still ends the stream with an error frame.
    const heartbeats = Array.from({ length: 300 }, () => `: ping${"p".repeat(1020)}\n`);
    const billingEnv = JSON.stringify({
      statusCodeValue: 403,
      body: '{"code":"112","message":"Quota exhausted","pricingUrl":"https://qoder.sh/pricing"}',
    });

    const wrapped = await wrapQoderSSE(
      makeResponse([...heartbeats, `data: ${billingEnv}\n\n`]),
      "qoder/ultimate",
    );
    expect(wrapped.status).toBe(200); // past the peek: the status can no longer change

    const buf = await readAll(wrapped);
    expect(buf).not.toContain("ping");
    expect(buf).toContain('"error"');
    expect(buf).toContain("data: [DONE]");
  });

  it("reports a mid-stream error as an error frame, never as message content", async () => {
    const okEnv = JSON.stringify({
      statusCodeValue: 200,
      body: JSON.stringify({ choices: [{ delta: { content: "partial" } }] }),
    });
    const errEnv = JSON.stringify({
      statusCodeValue: 403,
      body: '{"code":"403","message":"{\\"code\\":\\"10605\\",\\"queueCount\\":9711,\\"retryAfterSeconds\\":30}"}',
    });

    const wrapped = await wrapQoderSSE(
      makeResponse([`data: ${okEnv}\n\n`, `data: ${errEnv}\n\n`]),
      "qoder/ultimate",
    );
    expect(wrapped.status).toBe(200); // headers already sent

    const buf = await readAll(wrapped);
    const frames = buf
      .split("\n")
      .filter(l => l.startsWith("data: ") && l.trim() !== "data: [DONE]")
      .map(l => JSON.parse(l.slice(6)));
    const errFrame = frames.find(f => f.error);
    expect(errFrame).toBeDefined();
    expect(errFrame.error.message).toContain("10605");
    expect(errFrame.error.message).toContain("qoder error 403"); // real upstream status stays in the message
    // a queue throttle must not read as exhausted quota (clients stop retrying on that)
    expect(errFrame.error.type).toBe("rate_limit_error");
    // no raw upstream JSON smuggled into the conversation, no fake success
    expect(frames.some(f => f.choices?.some(c => c.delta?.content?.includes("10605")))).toBe(false);
    expect(frames.some(f => f.choices?.some(c => c.finish_reason === "stop" && !c.delta?.content?.includes("partial")))).toBe(false);
  });

  it("keeps the upstream status on a mid-stream error that is not a queue throttle", async () => {
    const okEnv = JSON.stringify({ statusCodeValue: 200, body: JSON.stringify({ choices: [{ delta: { content: "partial" } }] }) });
    const errEnv = JSON.stringify({ statusCodeValue: 500, body: '{"code":"500","message":"boom"}' });

    const wrapped = await wrapQoderSSE(makeResponse([`data: ${okEnv}\n\n`, `data: ${errEnv}\n\n`]), "qoder/ultimate");
    const errFrame = (await readAll(wrapped))
      .split("\n")
      .filter(l => l.startsWith("data: ") && l.trim() !== "data: [DONE]")
      .map(l => JSON.parse(l.slice(6)))
      .find(f => f.error);

    expect(errFrame.error.type).toBe("server_error");
  });

  it("passes through successful responses unchanged", async () => {
    const inner = JSON.stringify({ choices: [{ delta: { content: "hello" } }] });
    const successEnv = JSON.stringify({ statusCodeValue: 200, body: inner });
    const upstream = `data: ${successEnv}\n\n`;

    const wrapped = await wrapQoderSSE(makeResponse([upstream]), "qoder/ultimate");

    expect(wrapped.status).toBe(200);
    expect(wrapped.ok).toBe(true);

    const buf = await readAll(wrapped);
    expect(buf).toContain(`data: ${inner}`);
    expect(buf).toContain("data: [DONE]");
  });
});

describe("QoderExecutor.parseError", () => {
  it("converts a queue throttle into an exact resetsAtMs", () => {
    const executor = new QoderExecutor("qoder-cn");
    const inner = '{"code":"403","message":"{\\"code\\":\\"10605\\",\\"queueCount\\":9711,\\"retryAfterSeconds\\":30}"}';
    const bodyText = JSON.stringify({ error: { message: inner, code: 403 } });
    const res = new Response(bodyText, { status: 403 });

    const before = Date.now();
    const parsed = executor.parseError(res, bodyText);
    expect(parsed.status).toBe(403);
    expect(parsed.resetsAtMs).toBeGreaterThanOrEqual(before + 30_000);
    expect(parsed.resetsAtMs).toBeLessThanOrEqual(Date.now() + 30_000);
  });

  it("leaves a real billing block to the status rules", () => {
    const executor = new QoderExecutor("qoder-cn");
    const bodyText = JSON.stringify({ error: { message: '{"code":"112","pricingUrl":"https://qoder.sh/pricing"}', code: 403 } });
    const parsed = executor.parseError(new Response(bodyText, { status: 403 }), bodyText);
    expect(parsed.resetsAtMs).toBeUndefined();
  });
});

describe("wrapped mid-stream error → client-visible outcome", () => {
  it("non-streaming clients get an error, not JSON text in message.content", async () => {
    const { wrapQoderSSE } = qoderExecutorInternals;
    const okEnv = JSON.stringify({ statusCodeValue: 200, body: JSON.stringify({ choices: [{ delta: { content: "partial" } }] }) });
    const errEnv = JSON.stringify({
      statusCodeValue: 403,
      body: '{"code":"403","message":"{\\"code\\":\\"10605\\",\\"queueCount\\":9711,\\"retryAfterSeconds\\":30}"}',
    });
    const upstream = new Response(new ReadableStream({
      start(c) {
        const enc = new TextEncoder();
        c.enqueue(enc.encode(`data: ${okEnv}\n\n`));
        c.enqueue(enc.encode(`data: ${errEnv}\n\n`));
        c.close();
      },
    }));

    const wrapped = await wrapQoderSSE(upstream, "qoder-cn/qfmodel");
    const parsed = parseSSEToOpenAIResponse(await readAll(wrapped), "qoder-cn/qfmodel");

    expect(parsed.error).toBeDefined();
    expect(parsed.error.message).toContain("10605");
    expect(parsed.choices?.[0]?.message?.content ?? "").not.toContain("queueCount");
  });
});

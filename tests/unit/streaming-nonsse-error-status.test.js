/**
 * When upstream answers with an HTML/Cloudflare page instead of SSE, the stream
 * is blocked and turned into a JSON error. The account loop downstream classifies
 * the failure from `status`/`error` — with those missing, a 429 quota page and a
 * 500 origin fault both landed as "unspecified transient failure", which locks the
 * wrong account kind with the wrong cooldown and loses the upstream message.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
}));

const { handleStreamingResponse } = await import("../../open-sse/handlers/chatCore/streamingHandler.js");

function htmlUpstream(status, title) {
  const response = new Response(`<html><head><title>${title}</title></head><body>blocked</body></html>`, {
    status: status || 503,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
  if (!status) Object.defineProperty(response, "status", { value: 0 });
  return response;
}

async function block(status, title = "Cloudflare blocked the request") {
  return handleStreamingResponse({
    providerResponse: htmlUpstream(status, title),
    provider: "somevendor",
    model: "some-model",
    sourceFormat: "claude",
    targetFormat: "claude",
    body: { messages: [] },
    stream: true,
    requestStartTime: Date.now(),
    connectionId: "conn-a",
    clientRawRequest: { endpoint: "/v1/messages", body: {} },
    streamController: { signal: new AbortController().signal, handleError: vi.fn(), isConnected: () => true },
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), errorLine: vi.fn() },
  });
}

describe("non-SSE upstream while streaming", () => {
  it("reports the real status so the account loop classifies correctly", async () => {
    const result = await block(429, "Too many requests");

    expect(result.success).toBe(false);
    expect(result.status).toBe(429);
    expect(result.error).toBe("Too many requests");
    expect(result.response.status).toBe(429);
  });

  it("keeps a missing upstream status as 502 rather than undefined", async () => {
    const result = await block(0, "Origin unreachable");
    expect(result.status).toBe(502);
    expect(result.response.status).toBe(502);
  });

  it("never forwards raw upstream HTML to the client", async () => {
    const result = await block(500, "<script>alert(1)</script>");
    const text = await result.response.text();
    expect(text).not.toContain("<script>");
    expect(text).not.toContain("<html>");
  });
});

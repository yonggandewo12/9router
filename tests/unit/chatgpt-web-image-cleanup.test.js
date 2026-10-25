// The image lane creates a real conversation on the account for every picture
// (the attachments live in it), so cleanup has to run AFTER the bytes are in
// memory — a delete before the download would 404 the image it just produced.
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../../open-sse/executors/chatgpt-web/sentinel.js", () => ({
  SENTINEL_HEADERS: { requirements: "X-Requirements", proof: "X-Proof", prepare: "X-Prepare" },
  fetchSentinelHeaders: async () => ({}),
}));

const net = vi.hoisted(() => ({ calls: [], mode: "ok" }));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: async (url, options) => {
    net.calls.push({ url: String(url), method: options?.method || "GET" });
    return handle(String(url));
  },
}));

const CONVERSATION_ID = "123e4567-e89b-12d3-a456-426614174000";

function pngResponse() {
  return new Response(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]), {
    status: 200,
    headers: { "content-type": "image/png" },
  });
}

function handle(url) {
  if (url.includes("/f/conversation/prepare")) return Response.json({ conduit_token: "tok" });
  if (url.includes("/f/conversation")) {
    return new Response(
      `event: delta\ndata: {"conversation_id":"${CONVERSATION_ID}","file-service://FILE1"}\n\n`,
      { status: 200, headers: { "content-type": "text/event-stream" } }
    );
  }
  if (url.includes("/backend-api/files/FILE1/download")) {
    // A refused generation answers with a file record that has no signed URL.
    return Response.json(net.mode === "no-url" ? {} : { download_url: "https://cdn.test/img.png" });
  }
  if (url === "https://cdn.test/img.png") return pngResponse();
  if (url.endsWith("/delete")) return Response.json({});
  throw new Error(`unexpected fetch: ${url}`);
}

const { generateChatGptWebImageHttp } = await import("../../open-sse/executors/chatgpt-web/imageGenHttp.js");

function run() {
  return generateChatGptWebImageHttp({
    baseUrl: "https://chatgpt.test",
    accessToken: "access",
    cookie: "session=1",
    userAgent: "test-agent",
    prompt: "a cat",
    signal: undefined,
    log: null,
  });
}

beforeEach(() => {
  net.calls = [];
  net.mode = "ok";
});

describe("chatgpt-web image lane cleanup", () => {
  it("deletes the conversation only after the image bytes are downloaded", async () => {
    const media = await run();
    expect(media.mime).toBe("image/png");

    const urls = net.calls.map((c) => c.url);
    const bytesAt = urls.indexOf("https://cdn.test/img.png");
    const deleteAt = urls.findIndex((u) => u.endsWith("/delete"));
    expect(bytesAt).toBeGreaterThan(-1);
    expect(deleteAt).toBeGreaterThan(bytesAt);
    expect(urls[deleteAt]).toContain(`/backend-api/conversation/${CONVERSATION_ID}/delete`);
    expect(net.calls[deleteAt].method).toBe("POST");
  });

  it("still cleans up when the lane fails to produce an image", async () => {
    net.mode = "no-url";
    await expect(run()).rejects.toThrow(/no downloadable file/);
    expect(net.calls.some((c) => c.url.endsWith("/delete"))).toBe(true);
  });
});

/**
 * The media lanes (image / embeddings) each hand-roll the 401 → refresh → retry
 * dance. Two failure modes used to survive it: the retry request went out with no
 * signal at all (an upstream that accepts the connection and never answers holds a
 * worker forever), and the superseded 401 response was dropped with its body unread,
 * which parks the socket until the kernel times out.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: vi.fn(() => ({ refreshCredentials: vi.fn(async () => ({ accessToken: "at-new" })) })),
  hasSpecializedExecutor: vi.fn(() => false),
}));

vi.mock("../../open-sse/services/tokenRefresh.js", () => ({
  refreshWithRetry: vi.fn(async () => ({ accessToken: "at-new", apiKey: "at-new" })),
}));

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
}));

const { handleImageGenerationCore } = await import("../../open-sse/handlers/imageGenerationCore.js");
const { handleEmbeddingsCore } = await import("../../open-sse/handlers/embeddingsCore.js");

const originalFetch = global.fetch;

function unauthorized() {
  const response = new Response(JSON.stringify({ error: { message: "unauthorized" } }), {
    status: 401,
    headers: { "Content-Type": "application/json" },
  });
  const cancel = vi.fn(response.body.cancel.bind(response.body));
  response.body.cancel = cancel;
  return { response, cancel };
}

beforeEach(() => {
  global.fetch = vi.fn();
});

afterEach(() => {
  global.fetch = originalFetch;
});

describe("media lane auth retry", () => {
  it("retries image generation with a bounded signal and releases the 401 socket", async () => {
    const { response: first, cancel } = unauthorized();
    vi.mocked(global.fetch)
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ b64_json: "aGVsbG8=" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));

    await handleImageGenerationCore({
      body: { prompt: "a cat", model: "dall-e-3" },
      modelInfo: { provider: "openai", model: "dall-e-3" },
      credentials: { apiKey: "sk-old", accessToken: "at-old", refreshToken: "rt" },
      log: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    });

    expect(global.fetch).toHaveBeenCalledTimes(2);
    // Headers-only bound on both the first attempt and the retry: generation itself
    // may run for minutes, so the timeout must never wrap the whole response.
    expect(vi.mocked(global.fetch).mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    expect(global.fetch.mock.calls[1][1].signal).toBeInstanceOf(AbortSignal);
    expect(cancel).toHaveBeenCalled();
  });

  it("retries embeddings with a bounded signal and releases the 401 socket", async () => {
    const { response: first, cancel } = unauthorized();
    vi.mocked(global.fetch)
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(new Response(JSON.stringify({ object: "list", data: [{ object: "embedding", index: 0, embedding: [0.1] }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));

    await handleEmbeddingsCore({
      body: { input: "hello", model: "text-embedding-ada-002" },
      modelInfo: { provider: "openai", model: "text-embedding-ada-002" },
      credentials: { apiKey: "sk-old", accessToken: "at-old", refreshToken: "rt" },
      log: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
      onRequestSuccess: null,
      onCredentialsRefreshed: vi.fn(),
    });

    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(global.fetch.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    expect(global.fetch.mock.calls[1][1].signal).toBeInstanceOf(AbortSignal);
    expect(cancel).toHaveBeenCalled();
  });
});

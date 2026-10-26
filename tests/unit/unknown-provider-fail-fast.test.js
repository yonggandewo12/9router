// A provider id that survives only as a leftover DB row (the removed gemini-web)
// used to fall through to DefaultExecutor, whose constructor is
// `super(provider, PROVIDERS[provider] || PROVIDERS.openai)`. The stored cookie
// jar then went to api.openai.com as `Authorization: Bearer <jar>`. Proven live
// on 2026-10-26: re-inserting one gemini-web row made /v1/chat/completions dial
// api.openai.com:443 (UND_ERR_CONNECT_TIMEOUT, 54s of retries). chatCore now
// rejects providers the executor layer cannot resolve, before any credential use.
import { describe, it, expect, vi, beforeEach } from "vitest";

const { getExecutorMock } = vi.hoisted(() => ({ getExecutorMock: vi.fn() }));

// Only getExecutor is spied: isRoutableProvider must see the real executor map,
// otherwise the aliases it exists to protect (brx, veo-free) would be masked.
vi.mock("../../open-sse/executors/index.js", async (importOriginal) => ({
  ...(await importOriginal()),
  getExecutor: getExecutorMock,
}));

vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => ({
    logClientRawRequest: vi.fn(), logRawRequest: vi.fn(), logTargetRequest: vi.fn(),
    logProviderResponse: vi.fn(), logConvertedResponse: vi.fn(), logError: vi.fn(),
  }),
}));

// formatSSE stays real — the bypass path uses it to build the fake SSE body.
vi.mock("../../open-sse/utils/stream.js", async (importOriginal) => ({
  ...(await importOriginal()),
  createPassthroughStreamWithLogger: vi.fn(() => new TransformStream()),
}));

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  saveRequestDetail: vi.fn(async () => { }),
  saveRequestUsage: vi.fn(async () => { }),
}));

const { handleChatCore, isRoutableProvider } = await import("../../open-sse/handlers/chatCore.js");

const body = {
  model: "m",
  stream: false,
  messages: [{ role: "user", content: "hi" }],
};

const args = (provider, extra = {}) => ({
  body,
  modelInfo: { provider, model: "some-model" },
  credentials: { apiKey: "fake=1", providerSpecificData: {} },
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
  connectionId: "c1",
  rtkEnabled: false,
  headroomEnabled: false,
  cavemanEnabled: false,
  ponytailEnabled: false,
  clientRawRequest: { endpoint: "/v1/chat/completions", body: {}, headers: { accept: "application/json" } },
  ...extra,
});

beforeEach(() => {
  vi.clearAllMocks();
  getExecutorMock.mockReturnValue({
    noAuth: true,
    execute: async () => ({
      response: new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      url: "https://example.invalid/v1",
      headers: {},
      transformedBody: null,
    }),
  });
});

describe("unknown providers never reach DefaultExecutor", () => {
  it("404s a removed provider that still has a connection row", async () => {
    const result = await handleChatCore(args("gemini-web"));
    expect(result.status).toBe(404);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Unknown or removed provider: gemini-web/);
    expect(getExecutorMock).not.toHaveBeenCalled();
  });

  it("404s any other unknown id instead of treating it as OpenAI", async () => {
    const result = await handleChatCore(args("some-removed-provider"));
    expect(result.status).toBe(404);
    expect(getExecutorMock).not.toHaveBeenCalled();
  });

  // Bypass (Claude-CLI warmup / title probes) answers without touching a
  // provider, so it could legally run ahead of the guard. It does not: a
  // synthetic 200 would hide a dead model target until the first real turn.
  it("404s a Claude-CLI warmup probe aimed at an unroutable provider", async () => {
    const result = await handleChatCore(args("gemini-web", {
      userAgent: "claude-cli/1.2.3 (external, cli)",
      body: { model: "m", stream: true, messages: [{ role: "user", content: "Warmup" }] },
    }));
    expect(result.status).toBe(404);
    expect(getExecutorMock).not.toHaveBeenCalled();
  });

  // Companion to the case above: proves the probe really is a bypass hit, so
  // the 404 is the guard taking precedence and not a pattern that never matched.
  it("still fakes that warmup for a routable provider", async () => {
    const result = await handleChatCore(args("deepseek-web", {
      userAgent: "claude-cli/1.2.3 (external, cli)",
      body: { model: "m", stream: true, messages: [{ role: "user", content: "Warmup" }] },
    }));
    expect(result.success).toBe(true);
    expect(result.response.status).toBe(200);
    expect(getExecutorMock).not.toHaveBeenCalled();
  });

  it("keeps a registry provider with a transport routable", async () => {
    await handleChatCore(args("deepseek-web"));
    expect(getExecutorMock).toHaveBeenCalledWith("deepseek-web");
  });

  it("keeps a parked provider routable by name (serviceKinds: [])", async () => {
    await handleChatCore(args("perplexity-web"));
    expect(getExecutorMock).toHaveBeenCalledWith("perplexity-web");
  });

  it("keeps executor-only aliases routable", async () => {
    await handleChatCore(args("brx"));
    expect(getExecutorMock).toHaveBeenCalledWith("brx");
  });

  it("keeps compatible nodes routable", async () => {
    await handleChatCore(args("openai-compatible-chat-1234"));
    await handleChatCore(args("anthropic-compatible-5678"));
    expect(getExecutorMock).toHaveBeenCalledTimes(2);
  });
});

describe("isRoutableProvider", () => {
  it("rejects removed providers and empty ids", () => {
    expect(isRoutableProvider("gemini-web")).toBe(false);
    expect(isRoutableProvider("xiaoyi-web")).toBe(false);
    expect(isRoutableProvider("")).toBe(false);
    expect(isRoutableProvider(undefined)).toBe(false);
  });

  it("accepts transports, executors and compatible nodes", () => {
    expect(isRoutableProvider("deepseek-web")).toBe(true);
    expect(isRoutableProvider("brx")).toBe(true);
    expect(isRoutableProvider("openai-compatible-chat-1234")).toBe(true);
    expect(isRoutableProvider("anthropic-compatible-5678")).toBe(true);
  });
});

describe("routing invariant behind the guard", () => {
  // Guards the guard: if a future registry entry is chat-capable but ships
  // neither a transport nor an executor, the new 404 would silently make it
  // unusable. The pass set is PROVIDERS ∪ executor-backed ids ∪ compatible nodes.
  it("every LLM-capable registry provider resolves without the OpenAI fallback", async () => {
    const REGISTRY = (await import("open-sse/providers/registry/index.js")).default;
    const { PROVIDERS } = await import("open-sse/providers/index.js");
    const { hasSpecializedExecutor } = await import("../../open-sse/executors/index.js");

    const unroutable = REGISTRY
      .filter((entry) => (entry.serviceKinds || ["llm"]).includes("llm"))
      .filter((entry) => !PROVIDERS[entry.id] && !hasSpecializedExecutor(entry.id))
      .map((entry) => entry.id);

    expect(unroutable).toEqual([]);
  });

  it("rejects the transport-less media providers on the chat path", async () => {
    const REGISTRY = (await import("open-sse/providers/registry/index.js")).default;
    const { PROVIDERS } = await import("open-sse/providers/index.js");
    const { hasSpecializedExecutor } = await import("../../open-sse/executors/index.js");

    // sdwebui/comfyui/huggingface carry no chat transport: before this guard a
    // chat request naming them was forwarded to api.openai.com with their key.
    for (const id of ["sdwebui", "comfyui", "huggingface"]) {
      expect(PROVIDERS[id]).toBeUndefined();
      expect(hasSpecializedExecutor(id)).toBe(false);
      expect(isRoutableProvider(id)).toBe(false);
    }
  });
});

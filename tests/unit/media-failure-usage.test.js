/**
 * The media lanes (embeddings / image / systemone) record a usage row only on the
 * success branch, and usageHistory is the single record surface that is always on:
 * saveRequestDetail is gated by observability and there is no separate request log
 * any more. So a media turn that failed upstream — a region gate, a quota refusal,
 * a local diffusers server that refused the job — used to leave no trace at all.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  accounts: [],
  markAccountUnavailable: vi.fn(),
  saveRequestUsage: vi.fn(),
  handleEmbeddingsCore: vi.fn(),
  handleImageGenerationCore: vi.fn(),
  handleSystemoneCore: vi.fn(),
  getModelInfo: vi.fn(),
}));

vi.mock("../../src/sse/services/auth.js", () => ({
  getProviderCredentials: async () => mocks.accounts.shift() || null,
  markAccountUnavailable: mocks.markAccountUnavailable,
  clearAccountError: vi.fn(async () => {}),
  extractApiKey: () => "client-key",
  isValidApiKey: vi.fn(),
}));
vi.mock("@/lib/localDb", () => ({ getSettings: async () => ({ requireApiKey: false }) }));
vi.mock("../../src/sse/services/model.js", () => ({
  getModelInfo: mocks.getModelInfo,
  getComboModels: async () => null,
}));
vi.mock("../../open-sse/handlers/embeddingsCore.js", () => ({
  handleEmbeddingsCore: mocks.handleEmbeddingsCore,
}));
vi.mock("../../open-sse/handlers/imageGenerationCore.js", () => ({
  handleImageGenerationCore: mocks.handleImageGenerationCore,
}));
vi.mock("../../open-sse/handlers/systemoneCore.js", () => ({
  handleSystemoneCore: mocks.handleSystemoneCore,
}));
vi.mock("../../open-sse/services/combo.js", () => ({ handleComboChat: vi.fn() }));
vi.mock("../../open-sse/utils/error.js", () => ({
  errorResponse: (status, message) => Response.json({ error: message }, { status }),
  unavailableResponse: (status, message) => Response.json({ error: message }, { status }),
}));
vi.mock("../../src/sse/utils/logger.js", () => ({
  request: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn(), line: vi.fn(), maskKey: vi.fn(),
}));
vi.mock("../../src/sse/services/tokenRefresh.js", () => ({
  updateProviderCredentials: vi.fn(),
  checkAndRefreshToken: async (_provider, credentials) => credentials,
}));
vi.mock("@/lib/usageDb.js", () => ({ saveRequestUsage: mocks.saveRequestUsage }));

const { handleEmbeddings } = await import("../../src/sse/handlers/embeddings.js");
const { handleImageGeneration } = await import("../../src/sse/handlers/imageGeneration.js");
const { handleSystemone } = await import("../../src/sse/handlers/systemone.js");

const ACCOUNT = { accessToken: "at", apiKey: "key", connectionId: "connection-a", connectionName: "Account A" };

function usageRows() {
  return mocks.saveRequestUsage.mock.calls.map(([entry]) => entry);
}

describe("media lanes file provider failures into usageHistory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.saveRequestUsage.mockResolvedValue(undefined);
    mocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: false });
    mocks.accounts.length = 0;
  });

  it("files a refused embedding request with the upstream status", async () => {
    mocks.accounts.push(ACCOUNT);
    mocks.getModelInfo.mockResolvedValue({ provider: "openai", model: "text-embedding-3-small" });
    mocks.handleEmbeddingsCore.mockResolvedValue({ success: false, status: 403, error: "region gated", response: Response.json({ error: "region gated" }, { status: 403 }) });

    await handleEmbeddings(new Request("http://localhost/v1/embeddings", {
      method: "POST",
      body: JSON.stringify({ model: "openai/text-embedding-3-small", input: "hello" }),
    }));

    expect(usageRows()).toEqual([expect.objectContaining({
      provider: "openai",
      model: "text-embedding-3-small",
      connectionId: "connection-a",
      apiKey: "client-key",
      endpoint: "/v1/embeddings",
      status: "FAILED 403",
    })]);
    // A refusal spent nothing; the row is there to be seen, not to be billed.
    expect(usageRows()[0].tokens).toMatchObject({ prompt_tokens: 0, completion_tokens: 0 });
  });

  it("files one row per account a fallback loop tried", async () => {
    mocks.accounts.push(ACCOUNT, { ...ACCOUNT, connectionId: "connection-b", connectionName: "Account B" });
    mocks.getModelInfo.mockResolvedValue({ provider: "openai", model: "text-embedding-3-small" });
    mocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: true });
    mocks.handleEmbeddingsCore.mockResolvedValue({ success: false, status: 429, error: "rate limited", response: Response.json({ error: "rate limited" }, { status: 429 }) });

    await handleEmbeddings(new Request("http://localhost/v1/embeddings", {
      method: "POST",
      body: JSON.stringify({ model: "openai/text-embedding-3-small", input: "hello" }),
    }));

    expect(usageRows().map((r) => `${r.status}|${r.connectionId}`)).toEqual(["FAILED 429|connection-a", "FAILED 429|connection-b"]);
  });

  it("does not file a client cancellation as a provider failure", async () => {
    mocks.accounts.push(ACCOUNT);
    mocks.getModelInfo.mockResolvedValue({ provider: "openai", model: "text-embedding-3-small" });
    mocks.handleEmbeddingsCore.mockResolvedValue({ success: false, status: 499, error: "aborted", response: Response.json({ error: "aborted" }, { status: 499 }) });

    await handleEmbeddings(new Request("http://localhost/v1/embeddings", {
      method: "POST",
      body: JSON.stringify({ model: "openai/text-embedding-3-small", input: "hello" }),
    }));

    expect(mocks.saveRequestUsage).not.toHaveBeenCalled();
  });

  it("files a refused image generation", async () => {
    mocks.accounts.push(ACCOUNT);
    mocks.getModelInfo.mockResolvedValue({ provider: "codex", model: "gpt-5.6-sol-image" });
    mocks.handleImageGenerationCore.mockResolvedValue({ success: false, status: 402, error: "out of credit" });

    await handleImageGeneration(new Request("http://localhost/v1/images/generations", {
      method: "POST",
      body: JSON.stringify({ model: "codex/gpt-5.6-sol-image", prompt: "draw a cat" }),
    }));

    expect(usageRows()).toEqual([expect.objectContaining({
      provider: "codex", model: "gpt-5.6-sol-image", connectionId: "connection-a", status: "FAILED 402",
    })]);
  });

  it("files a local noAuth image server that gave no status", async () => {
    mocks.getModelInfo.mockResolvedValue({ provider: "sdwebui", model: "anything-v5" });
    mocks.handleImageGenerationCore.mockResolvedValue({ success: false, error: "connection refused" });

    await handleImageGeneration(new Request("http://localhost/v1/images/generations", {
      method: "POST",
      body: JSON.stringify({ model: "sdwebui/anything-v5", prompt: "draw a cat" }),
    }));

    // No credential on this branch, and a statusless refusal is still a 502 the
    // operator has to be able to see.
    expect(usageRows()).toEqual([expect.objectContaining({
      provider: "sdwebui", model: "anything-v5", connectionId: undefined, status: "FAILED 502",
    })]);
  });

  it("files a refused systemone decision", async () => {
    mocks.accounts.push(ACCOUNT);
    mocks.getModelInfo.mockResolvedValue({ provider: "opencode", model: "muse-spark-1.3-contributor-free" });
    mocks.handleSystemoneCore.mockResolvedValue({ success: false, status: 451, error: "endpoint unavailable", response: Response.json({ error: "gone" }, { status: 451 }) });

    await handleSystemone(new Request("http://localhost/v1/systemone", {
      method: "POST",
      body: JSON.stringify({ model: "opencode/muse-spark-1.3-contributor-free", state: {}, questions: { q: "?" } }),
    }));

    expect(usageRows()).toEqual([expect.objectContaining({
      provider: "opencode", model: "muse-spark-1.3-contributor-free", status: "FAILED 451",
    })]);
  });

  it("leaves a successful turn a single row, spelled like every other success", async () => {
    mocks.accounts.push(ACCOUNT);
    mocks.getModelInfo.mockResolvedValue({ provider: "openai", model: "text-embedding-3-small" });
    mocks.handleEmbeddingsCore.mockResolvedValue({
      success: true,
      usage: { prompt_tokens: 12, total_tokens: 12 },
      response: Response.json({ data: [] }),
    });

    await handleEmbeddings(new Request("http://localhost/v1/embeddings", {
      method: "POST",
      body: JSON.stringify({ model: "openai/text-embedding-3-small", input: "hello" }),
    }));

    expect(usageRows()).toEqual([expect.objectContaining({ status: "ok" })]);
  });
});

/**
 * A turn that dies before any token arrives — free-tier gate, region block, dead
 * upstream — used to be dropped by saveUsageStats' empty-usage filter, so nothing
 * recorded it: the failure exits only wrote to a request log that no longer exists,
 * and saveRequestDetail returns early when observability is off. usageHistory is the
 * only always-on surface, and both the recent-logs line and the Usage panel's dot
 * read it.
 *
 * Verified live 2026-10-15 against opencode 2.0.29 on port 20127: a RegionError 403
 * wrote no row at all, while the successful turns next to it wrote theirs.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
}));

const { saveUsageStats, saveFailureUsage } = await import("open-sse/handlers/chatCore/requestDetail.js");
const { saveRequestUsage } = await import("@/lib/usageDb.js");

const lastRow = () => saveRequestUsage.mock.calls.at(-1)?.[0];

describe("failure rows in usageHistory", () => {
  it("files a failure that spent no tokens", () => {
    saveRequestUsage.mockClear();
    saveFailureUsage({
      provider: "opencode", model: "muse-spark-1.3-contributor-free",
      connectionId: "conn-1", apiKey: "sk-test", endpoint: "/v1/chat/completions", status: 403,
    });
    const row = lastRow();
    expect(row.status).toBe("FAILED 403");
    expect(row.tokens).toEqual({ prompt_tokens: 0, completion_tokens: 0 });
    expect(row.provider).toBe("opencode");
    expect(row.model).toBe("muse-spark-1.3-contributor-free");
    expect(row.connectionId).toBe("conn-1");
    expect(row.apiKey).toBe("sk-test");
    expect(row.endpoint).toBe("/v1/chat/completions");
  });

  it("still drops an empty turn nobody called a failure", () => {
    saveRequestUsage.mockClear();
    saveUsageStats({ provider: "opencode", model: "m", tokens: null });
    saveUsageStats({ provider: "opencode", model: "m", tokens: undefined });
    saveUsageStats({ provider: "opencode", model: "m", tokens: { prompt_tokens: 0, completion_tokens: 0 } });
    // An array is not a usage object; canonicalizeUsage refuses it and the
    // fallback must not blow up on it either.
    saveUsageStats({ provider: "opencode", model: "m", tokens: [] });
    expect(saveRequestUsage).not.toHaveBeenCalled();
  });

  it("keeps billing the tokens a failed turn did spend", () => {
    saveRequestUsage.mockClear();
    saveUsageStats({
      provider: "opencode", model: "m", silent: true,
      tokens: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 },
      status: "FAILED 500",
    });
    const row = lastRow();
    expect(row.status).toBe("FAILED 500");
    expect(row.tokens.prompt_tokens).toBe(100);
    expect(row.tokens.completion_tokens).toBe(5);
  });

  it("reads the Anthropic token names on the failure path too", () => {
    saveRequestUsage.mockClear();
    saveUsageStats({ provider: "claude", model: "m", silent: true, tokens: { input_tokens: 7, output_tokens: 3 }, status: "FAILED 503" });
    expect(lastRow().tokens).toMatchObject({ prompt_tokens: 7, completion_tokens: 3 });
  });

  it("says nothing on the console for a silent failure", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    saveRequestUsage.mockClear();
    saveFailureUsage({ provider: "opencode", model: "m", status: 403 });
    expect(saveRequestUsage).toHaveBeenCalledTimes(1);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("does not file a client hang-up as a provider failure", () => {
    // 499 is our own marker for "the client left"; the streaming path files those as
    // aborts, so the non-streaming exits must not paint the panel red for them.
    saveRequestUsage.mockClear();
    saveFailureUsage({ provider: "opencode", model: "m", status: 499 });
    saveFailureUsage({ provider: "opencode", model: "m", status: "499" });
    expect(saveRequestUsage).not.toHaveBeenCalled();
  });

  it("falls back to unknown provider/model instead of throwing", () => {
    saveRequestUsage.mockClear();
    saveFailureUsage({ status: 502 });
    expect(lastRow()).toMatchObject({ provider: "unknown", model: "unknown", status: "FAILED 502" });
  });
});

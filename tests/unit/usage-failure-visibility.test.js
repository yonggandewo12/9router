/**
 * Reader side of the same hole: getUsageStats and getActiveRequests both dropped any
 * row with zero tokens, so even once a failure was filed the Usage panel's recent list
 * hid it and the red/green dot never had a red row to show.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
let db;

beforeEach(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-failure-rows-"));
  process.env.DATA_DIR = tempDir;
  // driver.js parks the adapter on global so it survives a Next.js dev hot-reload,
  // which also means vi.resetModules() alone leaves the previous test's DB file open.
  delete global._dbAdapter;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
});

afterEach(() => {
  delete process.env.DATA_DIR;
});

const save = (model, tokens, status) =>
  db.saveRequestUsage({ provider: "opencode", model, connectionId: "conn-1", tokens, status });

describe("zero-token failure rows reach the surfaces that are read", () => {
  beforeEach(async () => {
    await save("gated-model", { prompt_tokens: 0, completion_tokens: 0 }, "FAILED 403");
    await save("quiet-model", { prompt_tokens: 0, completion_tokens: 0 }, "ok");
    await save("working-model", { prompt_tokens: 6650, completion_tokens: 3 }, "ok");
  });

  it("lists the failure in getUsageStats recentRequests, and not the empty success", async () => {
    const stats = await db.getUsageStats("24h");
    const models = stats.recentRequests.map((r) => r.model);
    expect(models).toContain("gated-model");
    expect(models).toContain("working-model");
    expect(models).not.toContain("quiet-model");
    expect(stats.recentRequests.find((r) => r.model === "gated-model").status).toBe("FAILED 403");
  });

  it("lists the failure in getActiveRequests recentRequests too", async () => {
    const { recentRequests } = await db.getActiveRequests();
    const models = recentRequests.map((r) => r.model);
    expect(models).toContain("gated-model");
    expect(models).not.toContain("quiet-model");
  });

  it("prints the status in the recent-logs line the dashboard shows", async () => {
    const logs = await db.getRecentLogs(50);
    const gated = logs.find((l) => l.includes("gated-model"));
    expect(gated).toBeTruthy();
    expect(gated).toContain("FAILED 403");
    // RequestLogger.js flags a row by `status.includes("FAILED")`.
    expect(logs.find((l) => l.includes("working-model"))).toContain("| ok");
  });

  it("counts the failure as a request but charges nothing for it", async () => {
    const stats = await db.getUsageStats("24h");
    expect(stats.totalRequests).toBe(3);
    expect(stats.totalPromptTokens).toBe(6650);
    expect(stats.totalCompletionTokens).toBe(3);
    expect(stats.totalCost).toBe(0);
  });
});

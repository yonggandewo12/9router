// The observability gate decides whether request details (the PREP/TTFT ruler
// scripts/efficiency-baseline.mjs reads) are recorded at all. getSettings()
// merges DEFAULT_SETTINGS, so the raw row is the only place an explicit UI
// choice can be told apart from "never set" — which is what lets
// OBSERVABILITY_ENABLED turn the ruler on without touching the dashboard.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
const originalObsEnv = process.env.OBSERVABILITY_ENABLED;
let tempDir;
let db;
let adapter;
let repo;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-obs-gate-"));
  process.env.DATA_DIR = tempDir;
  delete process.env.OBSERVABILITY_ENABLED;
  delete process.env.ENABLE_REQUEST_LOGS;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
  // Flush on the first record so a case does not wait out the 5s interval.
  await db.updateSettings({ observabilityBatchSize: 1 });
  const { getAdapter } = await import("@/lib/db/driver.js");
  adapter = await getAdapter();
  repo = await import("@/lib/db/repos/requestDetailsRepo.js");
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  if (originalObsEnv === undefined) delete process.env.OBSERVABILITY_ENABLED;
  else process.env.OBSERVABILITY_ENABLED = originalObsEnv;
});

// uiFlag undefined = the key is absent from the stored row (never set in the UI).
function setRawFlag(uiFlag) {
  const row = adapter.get(`SELECT data FROM settings WHERE id = 1`);
  const raw = row ? JSON.parse(row.data) : {};
  if (uiFlag === undefined) delete raw.enableObservability;
  else raw.enableObservability = uiFlag;
  adapter.run(`UPDATE settings SET data = ? WHERE id = 1`, [JSON.stringify(raw)]);
}

async function rowsRecorded({ uiFlag, envFlag }) {
  setRawFlag(uiFlag);
  if (envFlag === undefined) delete process.env.OBSERVABILITY_ENABLED;
  else process.env.OBSERVABILITY_ENABLED = envFlag;
  repo.__test__.resetConfigCache();
  adapter.run(`DELETE FROM requestDetails`);

  await db.saveRequestDetail({ provider: "openai", model: "gpt-x", status: "ok" });
  await new Promise((r) => setTimeout(r, 200));
  return adapter.get(`SELECT COUNT(*) as c FROM requestDetails`).c;
}

describe("observability gate", () => {
  it("stays off by default (no UI choice, no env)", async () => {
    expect(await rowsRecorded({})).toBe(0);
  });

  it("OBSERVABILITY_ENABLED=true turns it on when the UI never set the flag", async () => {
    expect(await rowsRecorded({ envFlag: "true" })).toBe(1);
  });

  it("an explicit UI off beats the env", async () => {
    expect(await rowsRecorded({ uiFlag: false, envFlag: "true" })).toBe(0);
  });

  it("an explicit UI on needs no env", async () => {
    expect(await rowsRecorded({ uiFlag: true })).toBe(1);
  });

  it("falsy env values keep it off", async () => {
    expect(await rowsRecorded({ envFlag: "0" })).toBe(0);
    expect(await rowsRecorded({ envFlag: "false" })).toBe(0);
  });
});

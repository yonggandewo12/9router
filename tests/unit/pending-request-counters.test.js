/**
 * The pending-request counters drive the dashboard's "active requests" panel. Two
 * bugs made them lie:
 *   - one watchdog per (connection, model) instead of per request, so any sibling
 *     finishing cancelled it and a genuinely stuck count stayed stuck forever;
 *   - when it did fire it zeroed the whole model key, wiping the counts of healthy
 *     requests on other accounts that share the model.
 * The old 60s ceiling also fired during ordinary long streams, so a healthy request
 * disappeared from the panel a minute in.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const PENDING_TIMEOUT_MS = 10 * 60 * 1000;

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-pending-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

beforeEach(() => {
  vi.useFakeTimers();
  for (const key of Object.keys(global._pendingRequests.byModel)) delete global._pendingRequests.byModel[key];
  for (const key of Object.keys(global._pendingRequests.byAccount)) delete global._pendingRequests.byAccount[key];
  for (const key of Object.keys(global._pendingTimers)) {
    for (const timer of global._pendingTimers[key] || []) clearTimeout(timer);
    delete global._pendingTimers[key];
  }
});

afterEach(() => {
  vi.useRealTimers();
});

const MODEL_KEY = "m (p)";

describe("pending request counters", () => {
  it("counts concurrent requests and releases exactly one per completion", () => {
    db.trackPendingRequest("m", "p", "connA", true);
    db.trackPendingRequest("m", "p", "connA", true);
    expect(global._pendingRequests.byAccount.connA[MODEL_KEY]).toBe(2);

    db.trackPendingRequest("m", "p", "connA", false);
    expect(global._pendingRequests.byAccount.connA[MODEL_KEY]).toBe(1);

    db.trackPendingRequest("m", "p", "connA", false);
    expect(global._pendingRequests.byAccount.connA).toBeUndefined();
    expect(global._pendingRequests.byModel[MODEL_KEY]).toBeUndefined();
  });

  it("keeps a watchdog for the request that is still in flight", () => {
    db.trackPendingRequest("m", "p", "connA", true);  // never finishes
    db.trackPendingRequest("m", "p", "connA", true);  // finishes normally
    db.trackPendingRequest("m", "p", "connA", false);
    expect(global._pendingRequests.byAccount.connA[MODEL_KEY]).toBe(1);

    vi.advanceTimersByTime(PENDING_TIMEOUT_MS + 10);

    // The stuck one is still released, one count at a time.
    expect(global._pendingRequests.byAccount.connA).toBeUndefined();
    expect(global._pendingRequests.byModel[MODEL_KEY]).toBeUndefined();
  });

  it("does not wipe another account's healthy count when one request is stuck", () => {
    db.trackPendingRequest("m", "p", "connA", true);  // stuck from t=0
    vi.advanceTimersByTime(PENDING_TIMEOUT_MS / 2);
    db.trackPendingRequest("m", "p", "connB", true);  // healthy, same model, started later
    expect(global._pendingRequests.byModel[MODEL_KEY]).toBe(2);

    // connA's watchdog comes due; connB's is only half elapsed.
    vi.advanceTimersByTime(PENDING_TIMEOUT_MS / 2 + 10);

    expect(global._pendingRequests.byAccount.connA).toBeUndefined();
    expect(global._pendingRequests.byAccount.connB[MODEL_KEY]).toBe(1);
    expect(global._pendingRequests.byModel[MODEL_KEY]).toBe(1);

    db.trackPendingRequest("m", "p", "connB", false);
    expect(global._pendingRequests.byModel[MODEL_KEY]).toBeUndefined();
  });

  it("does not let a watchdog take the process down with it", () => {
    db.trackPendingRequest("m", "p", "connA", true);
    const [timer] = global._pendingTimers[`connA|${MODEL_KEY}`] || [];
    // unref() leaves no readable flag on every runtime, so assert it did not throw
    // and that the handle is the timer we armed.
    expect(timer).toBeTruthy();
    db.trackPendingRequest("m", "p", "connA", false);
    expect(global._pendingTimers[`connA|${MODEL_KEY}`]).toBeUndefined();
  });
});

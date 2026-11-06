// The refresh tri-state contract: truthy = new credentials, null = this attempt
// failed (retry), false = nothing can be refreshed (stop, do not sleep).
//
// Before this contract existed, every cookie-session lane answered null and
// refreshWithRetry slept 1s + 2s before returning the client its 401 — and the
// "All 3 retry attempts failed" line blamed a transient failure for what is
// really an expired paste.
import { describe, expect, it, vi } from "vitest";

import { refreshWithRetry } from "../../open-sse/services/tokenRefresh.js";
import { BaseExecutor } from "../../open-sse/executors/base.js";
import { DefaultExecutor } from "../../open-sse/executors/default.js";
import { MiaoshouExecutor } from "../../open-sse/executors/miaoshou.js";
import { JoyagentExecutor } from "../../open-sse/executors/joyagent.js";

describe("refreshWithRetry", () => {
  it("stops on the `false` sentinel without sleeping or retrying", async () => {
    const refreshFn = vi.fn(async () => false);
    const log = { warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const t0 = Date.now();

    expect(await refreshWithRetry(refreshFn, 3, log)).toBeNull();

    expect(refreshFn).toHaveBeenCalledTimes(1);
    expect(Date.now() - t0).toBeLessThan(500);
    // No misleading "all attempts failed" line for a credential that never could refresh.
    expect(log.error).not.toHaveBeenCalled();
  });

  it("still retries a null (transient) failure", async () => {
    const refreshFn = vi.fn(async () => null);
    const log = { warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

    expect(await refreshWithRetry(refreshFn, 2, log)).toBeNull();
    expect(refreshFn).toHaveBeenCalledTimes(2);
    expect(log.error).toHaveBeenCalledTimes(1);
  });

  it("returns the first truthy result and never wraps it", async () => {
    const creds = { accessToken: "fresh" };
    expect(await refreshWithRetry(async () => creds, 3, null)).toBe(creds);
  });

  it("treats a throwing refresh as a failed attempt, not as `false`", async () => {
    const refreshFn = vi.fn(async () => {
      throw new Error("network down");
    });
    const log = { warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    expect(await refreshWithRetry(refreshFn, 2, log)).toBeNull();
    expect(refreshFn).toHaveBeenCalledTimes(2);
  });
});

describe("executor refresh capability", () => {
  it("BaseExecutor answers `false` (nothing wired)", async () => {
    expect(await new BaseExecutor("x", {}).refreshCredentials({})).toBe(false);
  });

  it("a cookie credential with no refreshToken is not refreshable", async () => {
    // joyagent stores the pasted jar in apiKey; there is no refresh material.
    const executor = new JoyagentExecutor();
    expect(await executor.refreshCredentials({ apiKey: "thor=abc; ptKey=jca_x" })).toBe(false);
  });

  it("a refreshToken with no wired refresher is a config gap, not a retry", async () => {
    const executor = new DefaultExecutor("joyagent");
    expect(await executor.refreshCredentials({ refreshToken: "rt" })).toBe(false);
  });

  it("妙手 inherits the base answer after dropping its no-op override", async () => {
    // It used to return null, which read as "transient failure" and cost 3s on
    // every dead Passport token.
    const executor = new MiaoshouExecutor();
    expect(await executor.refreshCredentials({ apiKey: "X-Passport-Token=dead" })).toBe(false);
  });
});

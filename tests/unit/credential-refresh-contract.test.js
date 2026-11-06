// The refresh tri-state contract: truthy = new credentials, null = this attempt
// failed (retry), false = nothing can be refreshed (stop, do not sleep).
//
// Before this contract existed, every cookie-session lane answered null and
// refreshWithRetry slept 1s + 2s before returning the client its 401 — and the
// "All 3 retry attempts failed" line blamed a transient failure for what is
// really an expired paste.
import { describe, expect, it, vi, beforeEach } from "vitest";

// The refresh POSTs below must never reach the network.
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(async () =>
    new Response(JSON.stringify({ code: 0, data: { accessToken: "new-access", refreshToken: "new-refresh", expiresIn: 5184000 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  ),
}));

import { refreshWithRetry } from "../../open-sse/services/tokenRefresh.js";
import { BaseExecutor } from "../../open-sse/executors/base.js";
import { DefaultExecutor } from "../../open-sse/executors/default.js";
import { MiaoshouExecutor } from "../../open-sse/executors/miaoshou.js";
import { JoyagentExecutor } from "../../open-sse/executors/joyagent.js";
import { CodeBuddyExecutor } from "../../open-sse/executors/codebuddy-cn.js";
import { CodeBuddyIntlExecutor } from "../../open-sse/executors/codebuddy-intl.js";
import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";

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

describe("codebuddy reactive refresh", () => {
  // The gap this pins: CodeBuddyExecutor inherits DefaultExecutor, whose
  // refresher table knows neither CodeBuddy host, so a 401 answered "cannot
  // refresh" and the request died — even though the working refresh (with its
  // de-dup lock) already existed in services/tokenRefresh/providers.js and the
  // proactive path was using it happily.
  beforeEach(() => vi.clearAllMocks());

  it("mints a new token through the shared implementation", async () => {
    const out = await new CodeBuddyExecutor().refreshCredentials({ refreshToken: "old-cn" }, null);
    expect(out).toMatchObject({ accessToken: "new-access", refreshToken: "new-refresh", expiresIn: 5184000 });
  });

  it("does the same for the intl gateway, on its own host", async () => {
    const out = await new CodeBuddyIntlExecutor().refreshCredentials({ refreshToken: "old-intl" }, null);
    expect(out?.accessToken).toBe("new-access");
    const [url] = proxyAwareFetch.mock.calls[0];
    expect(url).toContain("codebuddy.ai");
  });

  it("carries the connection proxy onto the refresh POST", async () => {
    const proxyOptions = {
      connectionProxyEnabled: true,
      connectionProxyUrl: "http://127.0.0.1:8080",
      connectionNoProxy: "",
      vercelRelayUrl: "",
    };
    await new CodeBuddyExecutor().refreshCredentials({ refreshToken: "old-proxy" }, null, proxyOptions);
    expect(proxyAwareFetch.mock.calls[0][2]).toEqual(proxyOptions);
  });

  it("answers `false` rather than retrying when there is nothing to refresh", async () => {
    expect(await new CodeBuddyExecutor().refreshCredentials({ accessToken: "only" }, null)).toBe(false);
    expect(await new CodeBuddyIntlExecutor().refreshCredentials({ accessToken: "only" }, null)).toBe(false);
    expect(proxyAwareFetch).not.toHaveBeenCalled();
  });

  it("survives the retry loop: a 401 now costs one refresh attempt, not three sleeps", async () => {
    const executor = new CodeBuddyExecutor();
    const t0 = Date.now();
    const creds = { accessToken: "a", refreshToken: "" };
    const out = await refreshWithRetry(() => executor.refreshCredentials(creds, null), 3, null);
    expect(out).toBeNull();
    expect(Date.now() - t0).toBeLessThan(500);
  });
});

/**
 * dedupRefresh keys by the OLD refresh token. A rotating/single-use refresh token is
 * never presented again, so an entry that only retired on the next lookup of its own
 * key was really a permanent map entry — one per refresh for the life of the process,
 * each holding the freshly minted access + refresh tokens in memory.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { dedupRefresh } = await import("../../open-sse/services/tokenRefresh/dedup.js");

const TTL_MS = 10_000;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("token refresh dedup", () => {
  it("shares one in-flight refresh across concurrent failures", async () => {
    const fn = vi.fn(async () => ({ accessToken: "at-1" }));

    const [a, b] = await Promise.all([dedupRefresh("vendor-shared", "rt-old", fn), dedupRefresh("vendor-shared", "rt-old", fn)]);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
  });

  it("reuses a recent result, then forgets the minted credentials", async () => {
    const log = { info: vi.fn() };
    let n = 0;
    const fn = vi.fn(async () => ({ accessToken: `at-${++n}` }));

    await dedupRefresh("vendor-ttl", "rt-old", fn, log);
    const reused = await dedupRefresh("vendor-ttl", "rt-old", fn, log);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(reused.accessToken).toBe("at-1");
    expect(log.info.mock.calls.join("|")).toContain("Reusing recent refresh result");

    vi.advanceTimersByTime(TTL_MS + 1);

    const afterRetire = await dedupRefresh("vendor-ttl", "rt-old", fn, log);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(afterRetire.accessToken).toBe("at-2");
  });

  it("drops the entry when the refresh fails", async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error("upstream auth down"));
    await expect(dedupRefresh("vendor-fail", "rt-old", fn)).rejects.toThrow("upstream auth down");

    const retry = vi.fn(async () => ({ accessToken: "at-2" }));
    await dedupRefresh("vendor-fail", "rt-old", retry);
    expect(retry).toHaveBeenCalledTimes(1);
  });
});

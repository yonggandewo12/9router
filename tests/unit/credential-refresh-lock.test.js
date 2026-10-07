import { describe, expect, it, vi } from "vitest";

const { withCredentialRefreshLock } = await import("../../open-sse/services/oauthCredentialManager.js");

const cred = (connectionId) => ({ connectionId, refreshToken: "rt" });

describe("credential refresh lock", () => {
  it("shares one refresh between concurrent callers for the same account", async () => {
    const refreshFn = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 10));
      return { accessToken: "at-1" };
    });

    const results = await Promise.all([
      withCredentialRefreshLock("xai", cred("conn-a"), refreshFn),
      withCredentialRefreshLock("xai", cred("conn-a"), refreshFn),
      withCredentialRefreshLock("xai", cred("conn-a"), refreshFn),
    ]);

    expect(refreshFn).toHaveBeenCalledTimes(1);
    expect(results).toEqual([{ accessToken: "at-1" }, { accessToken: "at-1" }, { accessToken: "at-1" }]);
  });

  it("runs a nested same-key refresh instead of waiting on the lock it holds", async () => {
    // A provider executor takes the same lock inside its own refreshCredentials.
    // Returning the holder its own promise would deadlock the refresh, so the
    // nested call must execute directly.
    let innerCalls = 0;
    const outer = async () => {
      innerCalls++;
      await new Promise((r) => setTimeout(r, 5));
      return { accessToken: `at-${innerCalls}` };
    };

    const result = await Promise.race([
      withCredentialRefreshLock("codearts", cred("conn-b"), () => withCredentialRefreshLock("codearts", cred("conn-b"), outer)),
      new Promise((_, reject) => setTimeout(() => reject(new Error("deadlocked")), 500)),
    ]);

    expect(innerCalls).toBe(1);
    expect(result).toEqual({ accessToken: "at-1" });
  });

  it("keeps separate accounts refreshing independently", async () => {
    const order = [];
    const make = (tag) => async () => {
      await new Promise((r) => setTimeout(r, 5));
      order.push(tag);
      return { accessToken: tag };
    };

    const [a, b] = await Promise.all([
      withCredentialRefreshLock("xai", cred("conn-c"), make("a")),
      withCredentialRefreshLock("xai", cred("conn-d"), make("b")),
    ]);

    expect(a.accessToken).toBe("a");
    expect(b.accessToken).toBe("b");
    expect(order.sort()).toEqual(["a", "b"]);
  });

  it("releases the lock when a refresh throws so the next caller retries", async () => {
    const failing = vi.fn(async () => { throw new Error("provider 500"); });
    await expect(withCredentialRefreshLock("kiro", cred("conn-e"), failing)).rejects.toThrow("provider 500");

    const succeeding = vi.fn(async () => ({ accessToken: "at-2" }));
    await expect(withCredentialRefreshLock("kiro", cred("conn-e"), succeeding)).resolves.toEqual({ accessToken: "at-2" });
    expect(succeeding).toHaveBeenCalledTimes(1);
  });
});

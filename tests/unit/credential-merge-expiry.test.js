// A refresh that rotates the access token but carries no expiry hint must not
// inherit the previous token's (usually past) expiresAt: shouldRefreshCredentials
// would then fire on every request forever — a proactive refresh storm. With no
// known expiry we clear it and let the reactive 401 path handle the real boundary.
import { describe, it, expect } from "vitest";
import { mergeRefreshedCredentials, shouldRefreshCredentials } from "../../open-sse/services/oauthCredentialManager.js";

describe("mergeRefreshedCredentials expiry handling", () => {
  const now = Date.parse("2026-11-07T00:00:00Z");
  const current = {
    accessToken: "old",
    refreshToken: "rt",
    expiresAt: new Date(now - 3600_000).toISOString(),
  };

  it("clears a stale expiresAt when a new access token arrives with no expiry hint", () => {
    const next = mergeRefreshedCredentials("qoder-cn", current, { accessToken: "new", refreshToken: "rt2" }, now);
    expect(next.accessToken).toBe("new");
    expect(next.expiresAt).toBeNull();
    expect(next.expiresIn).toBeNull();
    expect(shouldRefreshCredentials("qoder-cn", { ...current, ...next }, now)).toBe(false);
  });

  it("stamps a fresh expiry when expiresIn is provided", () => {
    const next = mergeRefreshedCredentials("qoder-cn", current, { accessToken: "new", expiresIn: 3600 }, now);
    expect(next.expiresAt).toBe(new Date(now + 3600_000).toISOString());
    expect(shouldRefreshCredentials("qoder-cn", { ...current, ...next }, now)).toBe(false);
  });

  it("honors an explicit expiresAt from the refresh result", () => {
    const iso = new Date(now + 7200_000).toISOString();
    const next = mergeRefreshedCredentials("qoder-cn", current, { accessToken: "new", expiresAt: iso }, now);
    expect(next.expiresAt).toBe(iso);
  });

  it("does not clear expiry when no new access token is issued", () => {
    const next = mergeRefreshedCredentials("qoder-cn", current, { refreshToken: "rt2" }, now);
    expect(next.expiresAt).toBeUndefined();
  });
});
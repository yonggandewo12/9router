// Route-level tests for cookie validation of the web providers added upstream
// (chatgpt-web, muse-web, …). The media branch used to accept ANY value for
// image-only web providers because they declare no *Config probe, so a dead
// session validated as healthy. These drive the real POST handler.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  hasWebIdentityProbe: vi.fn(),
  fetchWebIdentity: vi.fn(),
}));

vi.mock("open-sse/services/webIdentity.js", () => ({
  hasWebIdentityProbe: mocks.hasWebIdentityProbe,
  fetchWebIdentity: mocks.fetchWebIdentity,
}));

const { POST } = await import("../../src/app/api/providers/validate/route.js");

function call(provider, apiKey) {
  return POST(
    new Request("http://localhost/api/providers/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider, apiKey }),
    })
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.hasWebIdentityProbe.mockImplementation((p) => p === "chatgpt-web" || p === "muse-web");
});

describe("web-cookie validation", () => {
  it("does not let the media best-effort branch accept an image-only web provider", async () => {
    mocks.fetchWebIdentity.mockResolvedValue({ status: "invalid", error: "Missing session cookie" });
    const res = await call("chatgpt-web", "bogus=1");
    const json = await res.json();

    // Without the guard the provider's serviceKinds=["image"] reaches
    // probeMediaProvider's "no probe config → accept" path and this is true/null.
    expect(mocks.fetchWebIdentity).toHaveBeenCalledWith("chatgpt-web", "bogus=1");
    expect(json).toEqual({ valid: false, error: "Missing session cookie" });
  });

  it("keeps an inconclusive probe valid but says why", async () => {
    mocks.fetchWebIdentity.mockResolvedValue({ status: "unknown", error: "fetch failed" });
    const json = await (await call("muse-web", "bogus=1")).json();

    expect(json.valid).toBe(true);
    expect(json.error).toBe("Could not verify the session: fetch failed");
  });

  it("reports a proven-live session as valid without an error", async () => {
    mocks.fetchWebIdentity.mockResolvedValue({ status: "valid", email: "a@b.c" });
    const json = await (await call("chatgpt-web", "good")).json();
    expect(json).toEqual({ valid: true, error: null });
  });
});

// The proxy is applied when the login browser launches, so a window that is
// already open cannot pick one up. Re-clicking "Login via Browser" with a proxy
// typed in used to return the running session silently — the user then waits on
// a sign-in page that can never load. These pin the guard.
import { describe, expect, it, vi } from "vitest";

vi.mock("../../open-sse/services/lazyRuntime.js", () => ({
  // Never settles: keeps the session in "running" for the assertions below.
  loadRuntimeDep: () => new Promise(() => {}),
}));

const { startWebLogin } = await import("../../open-sse/services/webLogin.js");

describe("startWebLogin proxy mismatch", () => {
  it("keeps the running session when the proxy matches", async () => {
    const first = await startWebLogin("chatgpt-web", "default", { proxyUrl: "http://127.0.0.1:7890" });
    expect(first.status).toBe("running");
    expect(first.proxyUrl).toBe("http://127.0.0.1:7890");

    const again = await startWebLogin("chatgpt-web", "default", { proxyUrl: "http://127.0.0.1:7890" });
    expect(again).toBe(first);
  });

  it("refuses to pretend a different proxy took effect", async () => {
    await startWebLogin("gemini-web", "p2", { proxyUrl: "" });
    await expect(startWebLogin("gemini-web", "p2", { proxyUrl: "http://127.0.0.1:7890" }))
      .rejects.toThrow(/already open without a proxy/);
  });

  it("reports the reverse case too", async () => {
    await startWebLogin("grok-web", "p3", { proxyUrl: "http://127.0.0.1:7890" });
    await expect(startWebLogin("grok-web", "p3", { proxyUrl: "" }))
      .rejects.toThrow(/already open with a different proxy/);
  });
});

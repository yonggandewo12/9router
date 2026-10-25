// A web-cookie login window has to reach the sign-in page BEFORE any connection
// exists, so the proxy is supplied with the login request and applied at browser
// launch; chat then reuses it from the saved connection.
import { beforeAll, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  startWebLogin: vi.fn(async (provider, profile, options) => ({
    providerId: provider,
    profile,
    status: "running",
    proxyUrl: options?.proxyUrl || "",
    noProxy: options?.noProxy || "",
  })),
}));

vi.mock("../../open-sse/services/lazyRuntime.js", () => ({
  loadRuntimeDep: async () => {
    throw new Error("playwright not installed in tests");
  },
}));

vi.mock("../../open-sse/services/webLogin.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, startWebLogin: mocks.startWebLogin };
});

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: async () => [],
  updateProviderConnection: async () => null,
  createProviderConnection: async () => ({ id: "c1" }),
  deleteProviderConnection: async () => true,
}));

const { buildContextProxy } = await import("../../open-sse/services/webLogin.js");
const { POST } = await import("../../src/app/api/providers/web-login/route.js");

function post(body) {
  return POST(
    new Request("http://localhost/api/providers/web-login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}

describe("login-window proxy", () => {
  it("maps a proxy URL (and optional bypass) onto Playwright's context proxy", () => {
    expect(buildContextProxy("", "")).toBeNull();
    expect(buildContextProxy("  ", "")).toBeNull();
    expect(buildContextProxy("http://127.0.0.1:7890", "")).toEqual({ server: "http://127.0.0.1:7890" });
    expect(buildContextProxy("socks5://127.0.0.1:1080", "localhost,127.0.0.1")).toEqual({
      server: "socks5://127.0.0.1:1080",
      bypass: "localhost,127.0.0.1",
    });
  });

  it("rejects a proxy that is not an http(s)/socks URL", async () => {
    const res = await post({ provider: "chatgpt-web", proxyUrl: "127.0.0.1:7890" });
    expect(res.status).toBe(400);
    expect(mocks.startWebLogin).not.toHaveBeenCalled();
  });

  it("forwards the proxy to the login session", async () => {
    const res = await post({ provider: "chatgpt-web", proxyUrl: "http://127.0.0.1:7890", noProxy: "localhost" });
    expect(res.status).toBe(202);
    expect(mocks.startWebLogin).toHaveBeenCalledWith("chatgpt-web", "default", {
      proxyUrl: "http://127.0.0.1:7890",
      noProxy: "localhost",
    });
  });
});

describe("identity probe uses the login proxy", () => {
  it("forwards the connection proxy into the probe request", async () => {
    const calls = [];
    const net = { handler: async (url, options, proxyOptions) => { calls.push({ url: String(url), proxyOptions }); return new Response(JSON.stringify({ user: { email: "a@b.c" } }), { status: 200 }); } };
    vi.doMock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: net.handler }));
    vi.resetModules();
    const { fetchWebIdentity } = await import("../../open-sse/services/webIdentity.js");
    const proxyOptions = { connectionProxyEnabled: true, connectionProxyUrl: "http://127.0.0.1:7890" };
    const result = await fetchWebIdentity("chatgpt-web", "session=1", { proxyOptions });
    expect(result.status).toBe("valid");
    expect(calls[0].url).toContain("/api/auth/session");
    expect(calls[0].proxyOptions).toEqual(proxyOptions);
    vi.doUnmock("../../open-sse/utils/proxyFetch.js");
  });
});

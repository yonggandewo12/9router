// The direct agent is the transport for every no-proxy upstream call, and the
// ProxyAgent for every proxied one, so two things have to hold: a request burst
// shares ONE dispatcher per target (not one per request, which would defeat
// pooling), and whatever we build carries the long idle-socket policy — a bare
// `new Agent()` silently reverts to undici's 4s default, which is shorter than
// the gap between two turns of an agent session.
//
// undici is mocked here to count constructions and read back the options; real
// socket behaviour is pinned by upstream-keepalive.test.js.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const PROXY_ENV_VARS = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"];
let built;

vi.mock("undici", () => {
  class Agent {
    constructor(options) { built.push({ kind: "Agent", options }); }
    close() {}
  }
  class ProxyAgent {
    constructor(options) { built.push({ kind: "ProxyAgent", options }); }
    close() {}
  }
  return { Agent, ProxyAgent };
});

async function loadProxyFetch() {
  built = [];
  vi.resetModules();
  // proxyFetch captures globalThis.fetch at import time, so the stub must exist first.
  vi.stubGlobal("fetch", vi.fn(async () => new Response("ok")));
  const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");
  return proxyAwareFetch;
}

const post = (fetchImpl, url) => fetchImpl(url, { method: "POST", body: "{}" });

describe("shared direct agent", () => {
  beforeEach(() => { for (const name of PROXY_ENV_VARS) vi.stubEnv(name, ""); });
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

  it("shares one agent across a concurrent burst to different origins", async () => {
    const fetchImpl = await loadProxyFetch();
    await Promise.all([1, 2, 3, 4, 5].map((i) => post(fetchImpl, `https://prov${i}.example.com/v1/chat`)));

    expect(built.map((b) => b.kind)).toEqual(["Agent"]);
    expect(built[0].options.keepAliveTimeout).toBeGreaterThan(4000);
  });

  it("keeps using that agent instead of building one per request", async () => {
    const fetchImpl = await loadProxyFetch();
    await post(fetchImpl, "https://prov-a.example.com/v1/chat");
    await Promise.all([
      post(fetchImpl, "https://prov-a.example.com/v1/chat"),
      post(fetchImpl, "https://prov-b.example.com/v1/chat"),
    ]);

    expect(built).toHaveLength(1);
  });

  it("gives a configured proxy the same idle-socket policy", async () => {
    vi.stubEnv("HTTPS_PROXY", "http://proxy.test:3128");
    const fetchImpl = await loadProxyFetch();
    await Promise.all([1, 2, 3].map((i) => post(fetchImpl, `https://prov${i}.example.com/v1/chat`)));

    expect(built.map((b) => b.kind)).toEqual(["ProxyAgent"]);
    expect(built[0].options.keepAliveTimeout).toBeGreaterThan(4000);
    expect(built[0].options.uri).toBe("http://proxy.test:3128");
  });
});

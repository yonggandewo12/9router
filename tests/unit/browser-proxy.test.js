// Web-cookie browser flows share one pool, so the proxy must be applied per
// CONTEXT: a provider that needs a proxy must not drag every sibling context
// through it, and a proxied request must not reuse a direct context.
import { describe, expect, it } from "vitest";

import { playwrightProxyFromOptions } from "../../open-sse/services/browserPool.js";
import { cleanRoomContextKey } from "../../open-sse/executors/chatgpt-web/adapter.js";

describe("playwrightProxyFromOptions", () => {
  it("returns null when no proxy is configured", () => {
    expect(playwrightProxyFromOptions(null)).toBeNull();
    expect(playwrightProxyFromOptions({})).toBeNull();
    expect(playwrightProxyFromOptions({ connectionProxyEnabled: true })).toBeNull();
    expect(playwrightProxyFromOptions({ connectionProxyUrl: "   " })).toBeNull();
  });

  it("maps the connection proxy and bypass list", () => {
    expect(playwrightProxyFromOptions({ connectionProxyEnabled: true, connectionProxyUrl: "http://127.0.0.1:7890" }))
      .toEqual({ server: "http://127.0.0.1:7890" });
    expect(
      playwrightProxyFromOptions({
        connectionProxyEnabled: true,
        connectionProxyUrl: "socks5://127.0.0.1:1080",
        connectionNoProxy: "localhost,127.0.0.1",
      })
    ).toEqual({ server: "socks5://127.0.0.1:1080", bypass: "localhost,127.0.0.1" });
  });

  it("accepts a URL alone and lets an explicit disable win", () => {
    expect(playwrightProxyFromOptions({ url: "http://proxy:8080" })).toEqual({ server: "http://proxy:8080" });
    expect(playwrightProxyFromOptions({ enabled: true, url: "http://proxy:8080" })).toEqual({ server: "http://proxy:8080" });
    expect(playwrightProxyFromOptions({ connectionProxyEnabled: false, connectionProxyUrl: "http://proxy:8080" }))
      .toBeNull();
  });

  it("refuses a relay-only proxy under strictProxy instead of going direct", () => {
    // Relay pools proxy by rewriting the URL — a browser context cannot do that.
    // Strict means "never leave the host IP", so silence is the bug, not the throw.
    expect(() => playwrightProxyFromOptions({
      vercelRelayUrl: "https://relay.example.com",
      strictProxy: true,
    })).toThrow(/relay pool/);

    // Best-effort (non-strict) keeps the old behaviour: direct, no throw.
    expect(playwrightProxyFromOptions({
      vercelRelayUrl: "https://relay.example.com",
      strictProxy: false,
    })).toBeNull();
    // A relay plus a real proxy URL still uses the real proxy.
    expect(playwrightProxyFromOptions({
      connectionProxyEnabled: true,
      connectionProxyUrl: "http://127.0.0.1:7890",
      vercelRelayUrl: "https://relay.example.com",
      strictProxy: true,
    })).toEqual({ server: "http://127.0.0.1:7890" });
  });
});

describe("cleanRoomContextKey", () => {
  const base = { connectionId: "conn-1", storageState: { cookies: [] } };

  it("separates direct, proxied and differently-bypassed sessions", () => {
    const direct = cleanRoomContextKey({ ...base, proxy: null });
    const proxied = cleanRoomContextKey({ ...base, proxy: { server: "http://p:1" } });
    const otherBypass = cleanRoomContextKey({ ...base, proxy: { server: "http://p:1", bypass: "localhost" } });

    expect(direct).not.toBe(proxied);
    expect(proxied).not.toBe(otherBypass);
    expect(cleanRoomContextKey({ ...base, proxy: { server: "http://p:1" } })).toBe(proxied);
  });

  it("keys by credential, so a refreshed cookie cannot reuse a stale context", () => {
    const a = cleanRoomContextKey({ ...base, storageState: { cookies: [{ name: "session-token", value: "a" }] } });
    const b = cleanRoomContextKey({ ...base, storageState: { cookies: [{ name: "session-token", value: "b" }] } });
    expect(a).not.toBe(b);
  });
});

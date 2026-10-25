// Web-cookie browser flows share one pool, so the proxy must be applied per
// CONTEXT: a provider that needs a proxy must not drag every sibling context
// through it, and a proxied request must not reuse a direct context.
import { describe, expect, it } from "vitest";

import { playwrightProxyFromOptions } from "../../open-sse/services/browserPool.js";

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
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import zcodeOauthProvider from "../../src/lib/oauth/providers/zcode.js";
import { getProvider } from "../../src/lib/oauth/providers";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("zcode OAuth (Start Plan JWT)", () => {
  let calls;

  beforeEach(() => {
    calls = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init = {}) => {
        calls.push({ url: String(url), init });
        const href = String(url);
        if (href === "https://zcode.z.ai/api/v1/oauth/cli/init") {
          return jsonResponse({
            code: 0,
            data: {
              authorize_url: "https://chat.z.ai/api/oauth/authorize?x=1",
              flow_id: "flow-1",
              poll_interval_sec: 2,
              expires_at: Math.floor(Date.now() / 1000) + 300,
            },
          });
        }
        if (href === "https://zcode.z.ai/api/v1/oauth/cli/poll/flow-1") {
          return jsonResponse({
            code: 0,
            data: {
              status: "ready",
              token: "header.payload.signature",
              user: { email: "u@example.com", name: "U", user_id: "uid-1" },
            },
          });
        }
        throw new Error(`unexpected fetch: ${href}`);
      })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is registered as a flow", () => {
    expect(getProvider("zcode")).toBe(zcodeOauthProvider);
    expect(zcodeOauthProvider.flowType).toBe("device_code");
  });

  it("uses the poll token as the credential, not a minted API key", async () => {
    const device = await zcodeOauthProvider.requestDeviceCode(zcodeOauthProvider.config);
    expect(device.device_code).toBe("flow-1");
    expect(device._zcodePollToken).toMatch(/^[a-f0-9]{64}$/);

    const polled = await zcodeOauthProvider.pollToken(
      zcodeOauthProvider.config,
      device.device_code,
      null,
      device
    );
    expect(polled.ok).toBe(true);
    expect(polled.data.access_token).toBe("header.payload.signature");

    const mapped = zcodeOauthProvider.mapTokens(polled.data);
    expect(mapped.accessToken).toBe("header.payload.signature");
    expect(mapped.refreshToken).toBeNull();
    expect(mapped.providerSpecificData.zcodeJwtToken).toBe("header.payload.signature");
    // No business-login / api-key minting hop for this provider.
    expect(calls).toHaveLength(2);
  });

  it("reports pending and missing-token states", async () => {
    await zcodeOauthProvider.requestDeviceCode(zcodeOauthProvider.config);

    const noPollToken = await zcodeOauthProvider.pollToken(
      zcodeOauthProvider.config,
      "flow-1",
      null,
      {}
    );
    expect(noPollToken.data.error).toBe("access_denied");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ code: 0, data: { status: "pending" } }))
    );
    const pending = await zcodeOauthProvider.pollToken(
      zcodeOauthProvider.config,
      "flow-1",
      null,
      { _zcodePollToken: "a".repeat(64) }
    );
    expect(pending.data.error).toBe("authorization_pending");
  });

  it("accepts string success codes and ms-epoch deadlines from upstream drift", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          code: "200",
          data: {
            authorize_url: "https://chat.z.ai/api/oauth/authorize?x=1",
            flow_id: "flow-ms",
            poll_interval_sec: 2,
            expires_at: Date.now() + 300 * 1000, // ms, not s
          },
        })
      )
    );
    const device = await zcodeOauthProvider.requestDeviceCode(zcodeOauthProvider.config);
    expect(device.expires_in).toBeLessThanOrEqual(300);
    expect(device.expires_in).toBeGreaterThan(0);
  });
});

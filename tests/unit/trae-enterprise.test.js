/**
 * Trae Enterprise (console.enterprise.trae.cn) wiring.
 *
 * The two Trae sites speak the same device flow with different dialects:
 *   consumer   Result.* envelope, flat `?refreshToken=…&loginHost=…` callback,
 *              epoch-seconds expiry, marscode/US-East identity
 *   enterprise Data.* envelope, `?userJwt={…}` callback, epoch-**ms** expiry,
 *              tenant (cn-beijing / tob_online / saas / member) identity
 * These pin the dialect translation plus the SSRF allowlist, because both sites
 * share one factory and a silent mix-up shows up only as a broken chat.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

const ENT_HOST = "https://console.enterprise.trae.cn";

// proxyFetch captures globalThis.fetch at import time, so a fetch stub can never
// reach proxyAwareFetch (the catalog helper). Mock the module and route it through
// the same rule table; see unit/zed-live-models.test.js for the same pattern.
const proxied = vi.hoisted(() => ({ routes: {}, calls: [] }));
vi.mock("open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: async (url) => {
    proxied.calls.push(String(url));
    const hit = Object.entries(proxied.routes).find(([re]) => new RegExp(re).test(String(url)));
    if (!hit) throw new Error(`unexpected proxyAwareFetch: ${url}`);
    return hit[1](String(url));
  },
}));

function jsonResponse(body) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

// Routes stubbed fetch calls by URL so the tests can assert which host was hit.
function stubRoutes(routes) {
  const calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url, opts) => {
    calls.push({ url, opts });
    const hit = Object.entries(routes).find(([re]) => new RegExp(re).test(url));
    if (!hit) throw new Error(`unexpected fetch: ${url}`);
    return hit[1](url, opts);
  }));
  return calls;
}

async function runDeviceFlow(providerMod, callback, routes) {
  const { default: provider } = await import(providerMod);
  stubRoutes(routes);
  const tokens = await provider.exchangeToken(provider.config, callback);
  const extra = await provider.postExchange(tokens);
  return { tokens, conn: provider.mapTokens(tokens, extra) };
}

afterEach(() => vi.unstubAllGlobals());

describe("trae-enterprise device flow", () => {
  const userJwt = JSON.stringify({
    RefreshToken: "ENT-REFRESH",
    RefreshExpireAt: Date.now() + 30 * 864e5,
    Token: "ENT-PRE-CALLBACK-JWT",
  });
  const callback =
    `http://127.0.0.1:50000/callback?scope=saas&host=http://169.254.169.254` +
    `&consoleHost=${encodeURIComponent(ENT_HOST)}&isRedirect=true&loginTraceID=x&userJwt=${encodeURIComponent(userJwt)}`;

  const routes = {
    "oauth/ExchangeToken": () => jsonResponse({
      Data: {
        Token: "ENT-CLOUD-IDE-JWT",
        RefreshToken: "ENT-REFRESH-2",
        TokenExpireAt: Date.now() + 3 * 864e5, // epoch MILLISECONDS
      },
    }),
    "trae/GetUserInfo": () => jsonResponse({
      Data: {
        UserInfo: {
          Email: "me@corp.cn",
          Name: "Corp User",
          UserID: "9001",
          TenantID: 415063296,
          AIRegion: "US", // hostile to the tenant's real region — must be ignored
          Region: "US-East",
          Scope: "marscode-us",
        },
      },
    }),
  };

  it("reads the Data.* envelope and converts the ms expiry", async () => {
    const { conn } = await runDeviceFlow("@/lib/oauth/providers/trae-enterprise.js", callback, routes);
    expect(conn.accessToken).toBe("ENT-CLOUD-IDE-JWT");
    expect(conn.refreshToken).toBe("ENT-REFRESH-2");
    expect(conn.email).toBe("me@corp.cn");
    // 3 days, not ~57 years: the ms-vs-s mix-up stored a never-expiring token.
    expect(conn.expiresIn).toBeGreaterThan(3 * 86400 - 120);
    expect(conn.expiresIn).toBeLessThanOrEqual(3 * 86400);
  });

  it("pins the tenant identity that the remote-agent API accepts", async () => {
    const { conn } = await runDeviceFlow("@/lib/oauth/providers/trae-enterprise.js", callback, routes);
    const psd = conn.providerSpecificData;
    expect(psd).toMatchObject({
      tenant: "tob_online",
      scope: "saas",
      region: "cn-beijing",
      aiRegion: "cn-beijing",
      userIdentity: "member",
      appVersion: "3.5.54",
      userUniqueId: "",
    });
    // GetUserInfo's numeric TenantID is informational only — it is not a tenant slug.
    expect(String(psd.tenantId)).toBe("415063296");
    expect(psd.tenant).not.toBe("415063296");
  });

  it("never sends the callback-supplied host (SSRF allowlist)", async () => {
    const calls = await runDeviceFlow("@/lib/oauth/providers/trae-enterprise.js", callback, routes)
      .then((r) => r && globalThis.fetch.mock.calls);
    expect(calls.length).toBeGreaterThan(0);
    for (const [url] of calls) {
      expect(url.startsWith(`${ENT_HOST}/cloudide/api/v3/trae/`)).toBe(true);
    }
    expect(calls.some(([url]) => url.includes("169.254.169.254"))).toBe(false);
  });

  it("rejects a callback without a refresh token", async () => {
    const { default: provider } = await import("@/lib/oauth/providers/trae-enterprise.js");
    stubRoutes({ ".*": () => jsonResponse({}) });
    await expect(
      provider.exchangeToken(provider.config, "http://127.0.0.1:1/callback?scope=saas&host=x"),
    ).rejects.toThrow(/refreshToken/);
  });
});

describe("consumer trae stays byte-equivalent", () => {
  const callback = "http://127.0.0.1:50000/callback?isRedirect=true&refreshToken=OLD-RT&loginHost=api.marscode.com";
  const expiresSec = Math.floor(Date.now() / 1000) + 7 * 86400;

  it("keeps Result.*, loginHost-derived scope and epoch-second expiry", async () => {
    const { conn } = await runDeviceFlow("@/lib/oauth/providers/trae.js", callback, {
      "oauth/ExchangeToken": () => jsonResponse({
        Result: { AccessToken: "OLD-JWT", RefreshToken: "OLD-RT-2", ExpiresAt: expiresSec },
      }),
      "trae/GetUserInfo": () => jsonResponse({
        Result: {
          NonPlainTextEmail: "a@b.c",
          ScreenName: "Old",
          AIRegion: "SG",
          Region: "Asia_Southeast_1",
          Scope: "marscode", // an OAuth scope string must NOT become common_params.scope
          TenantID: 12345,
        },
      }),
    });
    expect(conn.accessToken).toBe("OLD-JWT");
    expect(conn.expiresIn).toBeGreaterThan(7 * 86400 - 120);
    expect(conn.providerSpecificData).toMatchObject({
      tenant: "marscode",
      aiRegion: "SG",
      region: "Asia_Southeast_1",
      scope: "marscode-sg",
      userRegion: "SG",
      userIdentity: "Free",
    });
  });
});

describe("trae-enterprise chat wiring", () => {
  it("registry + oauth config agree on the enterprise host", async () => {
    const { PROVIDERS, PROVIDER_OAUTH } = await import("open-sse/config/providers.js");
    expect(PROVIDERS["trae-enterprise"].baseUrl).toBe(`${ENT_HOST}/api/remote/v1`);
    expect(PROVIDER_OAUTH["trae-enterprise"].exchangeTokenUrl).toBe(`${ENT_HOST}/cloudide/api/v3/trae/oauth/ExchangeToken`);
    expect(PROVIDER_OAUTH["trae-enterprise"].apiOrigins).toEqual([ENT_HOST]);
  });

  it("uses the code lane and tenant identity defaults on the wire", async () => {
    const { default: TraeExecutor } = await import("open-sse/executors/trae.js");
    const ex = new TraeExecutor("trae-enterprise");
    // No `work` lane upstream: it must degrade to code/auto, not 504.
    expect(ex.resolveMode("work")).toEqual({ mode: "code", strategy: "auto", modelName: "" });
    expect(ex.resolveMode("glm-5.1")).toEqual({ mode: "code", strategy: "manual", modelName: "glm-5.1" });
    const cp = JSON.parse(ex.commonParams({}, "code", null, ""));
    expect(cp).toMatchObject({
      app_version: "3.5.54",
      user_identity: "member",
      scope: "saas",
      tenant: "tob_online",
      region: "cn-beijing",
      aiRegion: "cn-beijing",
    });
  });

  it("declares the SOLO wire's real limits (no vision, no tool calls)", async () => {
    const { getCapabilitiesForModel } = await import("open-sse/providers/capabilities.js");
    const caps = getCapabilitiesForModel("trae-enterprise", "glm-5v-turbo");
    expect(caps.vision).toBe(false);
    expect(caps.tools).toBe(false);
    expect(caps.reasoning).toBe(true);
  });

  it("refreshes through ExchangeToken and keeps an ms-safe expiry", async () => {
    const { refreshTraeToken } = await import("open-sse/services/tokenRefresh/providers.js");
    const calls = stubRoutes({
      "oauth/ExchangeToken": () => jsonResponse({
        Data: { Token: "JWT-2", RefreshToken: "RT-2", TokenExpireAt: Date.now() + 14 * 864e5 },
      }),
    });
    const out = await refreshTraeToken("RT-1", {}, console, "trae-enterprise");
    expect(out).toMatchObject({ accessToken: "JWT-2", refreshToken: "RT-2" });
    expect(out.expiresIn).toBeGreaterThan(14 * 86400 - 120);
    expect(out.expiresIn).toBeLessThanOrEqual(14 * 86400);
    expect(JSON.parse(calls[0].opts.body)).toMatchObject({ ClientID: "ono9krqynydwx5", RefreshToken: "RT-1", UserID: "" });
  });

  it("targets the tenant catalog, and degrades to the static list without a token", async () => {
    const { traeEnterpriseConfig, resolveTraeEnterpriseModels } = await import("open-sse/shared/trae/enterprise.js");
    expect(traeEnterpriseConfig().modelsUrl).toBe(`${ENT_HOST}/api/remote/v1/models`);
    // null (not an empty list) is what makes callers keep the registry catalog.
    expect(await resolveTraeEnterpriseModels({})).toBeNull();
  });

  it("caches the tenant catalog, and forceRefresh bypasses the cache", async () => {
    const { resolveTraeEnterpriseModels } = await import("open-sse/shared/trae/enterprise.js");
    const ok = () => new Response(JSON.stringify({
      code: 0,
      data: { list: [{ function: "chat", models: [{ name: "glm-5.1", display_name: "GLM 5.1", max_input_tokens: "200000" }] }] },
    }), { status: 200, headers: { "Content-Type": "application/json" } });
    proxied.routes = { "remote/v1/models": ok };
    proxied.calls = [];

    const first = await resolveTraeEnterpriseModels({ accessToken: "ENT-JWT-ABCDEFGH0123456789" });
    expect(first.models.map((m) => m.id)).toEqual(["auto", "glm-5.1"]);
    // max_input_tokens arrives as a string from the tenant API.
    expect(first.models[1]).toMatchObject({ name: "GLM 5.1", contextLength: 200000 });

    await resolveTraeEnterpriseModels({ accessToken: "ENT-JWT-ABCDEFGH0123456789" });
    expect(proxied.calls).toHaveLength(1);

    await resolveTraeEnterpriseModels({ accessToken: "ENT-JWT-ABCDEFGH0123456789" }, { forceRefresh: true });
    expect(proxied.calls).toHaveLength(2);

    // A failed fetch must not poison the cache (a cold token would otherwise
    // stay empty for the whole TTL).
    const fresh = "OTHER-JWT-ABCDEFGH9876543210";
    proxied.routes = { "remote/v1/models": () => new Response("{}", { status: 401 }) };
    expect(await resolveTraeEnterpriseModels({ accessToken: fresh })).toBeNull();
    proxied.routes = { "remote/v1/models": ok };
    const recovered = await resolveTraeEnterpriseModels({ accessToken: fresh });
    expect(recovered?.models?.length).toBe(2);
  });
});

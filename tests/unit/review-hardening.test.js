/**
 * Guards for the holes the post-merge deep review closed (upstream v0.5.123).
 *
 * These live in their own file rather than inside upstream's test files, so the
 * next upstream merge cannot drop them, and so reverting any fix below turns a
 * test red instead of silently re-opening the hole.
 *
 * Covered:
 *  - a region taken from unschema'd providerSpecificData cannot steer a host that
 *    receives credentials (catalog + IDC token refresh);
 *  - a fresh-socket retry behind a proxy really gets a new connection;
 *  - the TLS fallback warning does not echo the URL (Gemini lanes carry the key
 *    in the query);
 *  - the capability windows/thinking levels the review restored;
 *  - oauth auto-import routes staying behind the loopback-only list, and the CLI token
 *    being compared rather than merely present.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// What getConsistentMachineId(CLI_TOKEN_SALT) yields on the machine under test; the
// guard compares against this, so only this exact value may pass.
const REAL_CLI_TOKEN = "machine-derived-token";

// ─── Kiro: region must not be able to move the bearer-token host ────────────

describe("Kiro catalog host is pinned to a validated region", () => {
  beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); });
  afterEach(() => { vi.unstubAllGlobals(); vi.doUnmock("undici"); });

  async function catalogUrlFor(profileArn) {
    const { resolveKiroModels, clearKiroModelCache } = await import("../../open-sse/services/kiroModels.js");
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ models: [] }), text: async () => "" });
    vi.stubGlobal("fetch", fetchMock);
    clearKiroModelCache();
    await resolveKiroModels(
      { accessToken: "tok", providerSpecificData: { profileArn } },
      { forceRefresh: true, log: { debug() {}, info() {}, warn() {}, error() {} } }
    );
    expect(fetchMock).toHaveBeenCalled();
    return new URL(fetchMock.mock.calls[0][0]);
  }

  it("keeps us-east-1 when the ARN region carries a fragment (would retarget the host)", async () => {
    // "…:x.attacker.tld/#:…" → without validation the request goes to q.x.attacker.tld
    // with `Authorization: Bearer <token>` attached.
    const url = await catalogUrlFor("arn:aws:codewhisperer:x.attacker.tld/#:1:profile/A");
    expect(url.hostname).toBe("q.us-east-1.amazonaws.com");
  });

  it("keeps us-east-1 when the ARN region carries a path", async () => {
    const url = await catalogUrlFor("arn:aws:codewhisperer:x.attacker.tld/evil:1:profile/A");
    expect(url.hostname).toBe("q.us-east-1.amazonaws.com");
  });

  it("still regionalizes a real region", async () => {
    const url = await catalogUrlFor("arn:aws:codewhisperer:eu-central-1:123456789012:profile/A");
    expect(url.hostname).toBe("q.eu-central-1.amazonaws.com");
  });
});

describe("Kiro IDC token refresh host is pinned to a validated region", () => {
  beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); });
  afterEach(() => { vi.doUnmock("undici"); });

  async function idcEndpointFor(region) {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: "new-at", expires_in: 3600 }),
    });
    vi.doMock("undici", async () => {
      const actual = await vi.importActual("undici");
      return { ...actual, fetch: fetchMock };
    });
    const { refreshKiroToken } = await import("../../open-sse/services/tokenRefresh.js");
    await refreshKiroToken("old-rt", {
      authMethod: "idc",
      clientId: "cid",
      clientSecret: "csecret",
      region,
    }, { info() {}, warn() {}, error() {} });
    expect(fetchMock).toHaveBeenCalled();
    return fetchMock.mock.calls.find(([u]) => String(u).includes("/token"))?.[0];
  }

  it("falls back to us-east-1 for a region that could move the host", async () => {
    // This endpoint carries the client secret and the refresh token in its body.
    expect(await idcEndpointFor("x.attacker.tld/#")).toBe("https://oidc.us-east-1.amazonaws.com/token");
  });

  it("still honors a real region", async () => {
    expect(await idcEndpointFor("eu-central-1")).toBe("https://oidc.eu-central-1.amazonaws.com/token");
  });
});

// ─── Transport: the fresh-socket retry must really be fresh behind a proxy ──

describe("proxy retries get their own fresh dispatcher", () => {
  beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); });
  afterEach(() => { vi.doUnmock("undici"); });

  it("builds a separate no-keep-alive ProxyAgent for forceFreshSocket", async () => {
    const built = [];
    vi.doMock("undici", async () => {
      const actual = await vi.importActual("undici");
      return {
        ...actual,
        ProxyAgent: function SpyProxyAgent(opts) {
          built.push(opts);
          const agent = new actual.ProxyAgent(opts);
          agent.close = async () => {};
          return agent;
        },
        fetch: vi.fn(async () => new Response("ok", { status: 200 })),
      };
    });

    const mod = await import("../../open-sse/utils/proxyFetch.js");
    mod.resetDirectDispatchersForTests();

    const proxyOptions = { connectionProxyEnabled: true, connectionProxyUrl: "http://127.0.0.1:8080" };
    await mod.proxyAwareFetch("https://example.com/a", { method: "POST", body: "{}" }, proxyOptions);
    await mod.proxyAwareFetch("https://example.com/b", { method: "POST", body: "{}" }, { ...proxyOptions, forceFreshSocket: true });

    expect(built.length).toBe(2);
    const [pooled, fresh] = built;
    // The retry agent must not inherit the 60s reuse window: that pooled socket is
    // the very connection the retry is escaping.
    expect(fresh.keepAliveTimeout).toBe(1);
    expect(fresh.keepAliveMaxTimeout).toBe(1);
    expect(pooled.keepAliveTimeout).toBeGreaterThan(1000);
  });
});

// ─── Transport: the TLS fallback warning must not echo the URL ─────────────

describe("TLS fallback warning redacts the target", () => {
  beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); });
  afterEach(() => { vi.doUnmock("undici"); vi.unstubAllGlobals(); });

  it("logs only the host, never the api_key carried in the query", async () => {
    let first = true;
    const fetchMock = vi.fn(async () => {
      if (first) {
        first = false;
        const err = new Error("fetch failed");
        err.cause = { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" };
        throw err;
      }
      return new Response("ok", { status: 200 });
    });
    vi.doMock("undici", async () => {
      const actual = await vi.importActual("undici");
      return { ...actual, fetch: fetchMock };
    });

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { proxyAwareFetch, resetDirectDispatchersForTests } = await import("../../open-sse/utils/proxyFetch.js");
    resetDirectDispatchersForTests();

    await proxyAwareFetch("https://generativelanguage.googleapis.com/v1beta/models?api_key=SUPERSECRET-KEY", { method: "GET" });

    const logged = warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toContain("TLS cert verification failed");
    expect(logged).not.toContain("SUPERSECRET-KEY");
    expect(logged).toContain("generativelanguage.googleapis.com");
  });
});

// ─── Capabilities: the windows and thinking levels the review restored ─────

describe("capability windows the review restored", () => {
  it("Codex GPT 6.2 does not inherit the generic 1.05M pattern", async () => {
    const { getCapabilitiesForModel } = await import("../../open-sse/providers/capabilities.js");
    for (const id of ["gpt-6.2-sol", "gpt-6.2-astra"]) {
      expect(getCapabilitiesForModel("codex", id).contextWindow).toBe(272000);
    }
    expect(getCapabilitiesForModel("codex", "gpt-6.2-sol[1m]").contextWindow).toBe(872000);
  });

  it("the Alibaba Token Plan `auto` lanes keep reasoning and their real window", async () => {
    const { getCapabilitiesForModel } = await import("../../open-sse/providers/capabilities.js");
    for (const provider of ["qwencloud", "alitp-intl"]) {
      const caps = getCapabilitiesForModel(provider, "auto");
      expect(caps.reasoning).toBe(true);
      expect(caps.contextWindow).toBe(1000000);
    }
  });

  it("SenseNova CN flagship matches the CN catalog, and intl offers only served levels", async () => {
    const { getCapabilitiesForModel } = await import("../../open-sse/providers/capabilities.js");
    const { getThinkingLevels } = await import("../../open-sse/providers/thinkingLevels.js");
    const cn = getCapabilitiesForModel("sensenova", "sensenova-6.8-flash");
    expect(cn.reasoning).toBe(true);
    expect(cn.contextWindow).toBe(1000000);
    // The intl upstream rejects minimal/xhigh — the picker must not offer them.
    const levels = getThinkingLevels("sensenova-intl", "sensenova-6.8-flash");
    expect(levels).not.toContain("minimal");
    expect(levels).not.toContain("xhigh");
    expect(levels).toContain("max");
  });

  it("the codex table carries gpt-6.1-sol exactly once", () => {
    const src = readFileSync(fileURLToPath(new URL("../../open-sse/providers/capabilities.js", import.meta.url)), "utf8");
    expect((src.match(/"gpt-6\.1-sol":/g) || []).length).toBe(1);
  });
});

// ─── Boundary: routes that read host credentials must stay loopback-only ────

describe("host-credential import boundary", () => {
  function sourceOf(rel) {
    return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
  }

  function localOnlyPaths() {
    const block = sourceOf("../../src/dashboardGuard.js").match(/const LOCAL_ONLY_PATHS = \[([\s\S]*?)\];/)[1];
    return [...block.matchAll(/"(\/api\/[^"]+)"/g)].map((m) => m[1]);
  }

  function autoImportRoutes() {
    const base = fileURLToPath(new URL("../../src/app/api/oauth/", import.meta.url));
    return readdirSync(base)
      .filter((p) => existsSync(join(base, p, "auto-import", "route.js")))
      .map((p) => `/api/oauth/${p}/auto-import`)
      .sort();
  }

  it("lists every oauth auto-import route, including ones a merge adds later", () => {
    // Each of these reads a credential file/keychain from the host and returns the live
    // secret in the body, so the daemon's default 0.0.0.0 bind would expose it to any LAN
    // peer in the documented requireLogin=false mode.
    const listed = localOnlyPaths();
    const routes = autoImportRoutes();
    expect(routes.length).toBeGreaterThanOrEqual(6);
    for (const route of routes) expect(listed).toContain(route);
  });

  it("rejects a forged x-9r-cli-token instead of trusting its presence", async () => {
    vi.resetModules();
    vi.doMock("next/server", () => ({ NextResponse: { json: () => null, next: () => null } }));
    vi.doMock("@/lib/localDb", () => ({ getSettings: async () => null, validateApiKey: async () => false }));
    vi.doMock("@/lib/auth/dashboardSession", () => ({ verifyDashboardAuthToken: async () => false }));
    vi.doMock("@/lib/auth/trustedPeer", () => ({ hasTrustedPeerHeaders: () => false }));
    vi.doMock("@/shared/utils/machineId", () => ({ getConsistentMachineId: async () => REAL_CLI_TOKEN }));

    const { hasValidCliToken } = await import("../../src/dashboardGuard.js");
    const requestWith = (value) => ({ headers: { get: () => value } });

    expect(await hasValidCliToken(requestWith(REAL_CLI_TOKEN))).toBe(true);
    expect(await hasValidCliToken(requestWith("attacker-guess"))).toBe(false);
    expect(await hasValidCliToken(requestWith(null))).toBe(false);
  });

  it("the database export route proves the token, not its presence", () => {
    const src = sourceOf("../../src/app/api/settings/database/route.js");
    expect(src).not.toContain("x-9r-cli-token");
    expect(src).toContain("hasValidCliToken(request)");
  });
});

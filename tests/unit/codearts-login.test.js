// CodeArts browser login: the PKCE authorize URL, the DPoP-bound token exchange
// (and its secret-callback variant), and the AK/SK refresh. All outbound calls
// go through proxyAwareFetch, so that is the seam under test here.
import { describe, it, expect, vi, beforeEach } from "vitest";
import crypto from "node:crypto";

import { createDpopKeyPair } from "open-sse/shared/codearts/auth.js";

const calls = [];

function mockFetch(handler) {
  vi.doMock("open-sse/utils/proxyFetch.js", () => ({
    proxyAwareFetch: async (url, options = {}) => {
      const record = {
        url,
        method: options.method || "GET",
        headers: Object.fromEntries(new Headers(options.headers || {}).entries()),
        body: typeof options.body === "string" ? options.body : null,
      };
      calls.push(record);
      return handler(record, calls.length);
    },
    default: async () => { throw new Error("default export must not be used"); },
  }));
}

function jsonResponse(payload, status = 200) {
  return { ok: status < 400, status, async text() { return JSON.stringify(payload); } };
}

const STS_TOKENS = {
  credentials: {
    access_key_id: "AK",
    secret_access_key: "SK",
    security_token: "ST",
    expiration: new Date(Date.now() + 3600_000).toISOString(),
  },
  refresh_token: "REFRESH-JWT",
};

const CALLBACK_URL = "http://127.0.0.1:45123/oauth/callback";

async function loadLogin() {
  const providers = await import("@/lib/oauth/providers.js");
  return providers;
}

beforeEach(() => {
  calls.length = 0;
  vi.resetModules();
});

describe("CodeArts authorize URL", () => {
  it("carries the CLI's parameter set and a matching PKCE pair", async () => {
    mockFetch(async () => jsonResponse({}));
    const { generateAuthData } = await loadLogin();
    const authData = await generateAuthData("codearts", CALLBACK_URL);

    expect(authData.callbackPath).toBe("/oauth/callback");
    expect(authData.codeVerifier).toHaveLength(128);
    expect(authData.codeChallenge).toHaveLength(43);
    expect(authData.ticketId).toMatch(/^[0-9a-f]{64}$/);

    const url = new URL(authData.authUrl);
    expect(`${url.origin}${url.pathname}`).toBe("https://codearts.huaweicloud.com/portal/authorize");
    expect(url.searchParams.get("client_id")).toBe("CodeArts_Tui");
    expect(url.searchParams.get("port")).toBe("45123");
    expect(url.searchParams.get("code_challenge_method")).toBe("SHA-256");
    expect(url.searchParams.get("ticket_id")).toBe(authData.ticketId);
    // The verifier handed to the callback proxy must be the one challenged here.
    expect(url.searchParams.get("code_challenge")).toBe(
      crypto.createHash("sha256").update(authData.codeVerifier).digest("base64url")
    );
  });
});

describe("CodeArts token exchange", () => {
  it("posts the PKCE grant with a DPoP proof and stores the signable credentials", async () => {
    mockFetch(async (call) => {
      if (call.url.endsWith("/v1/oauth2/tokens")) return jsonResponse(STS_TOKENS);
      return jsonResponse({ user_id: "u1", domain_id: "d1", user_name: "Dev", display_name: "Dev" });
    });
    const { generateAuthData, exchangeTokens } = await loadLogin();
    const authData = await generateAuthData("codearts", CALLBACK_URL);
    calls.length = 0;

    const tokens = await exchangeTokens(
      "codearts",
      "/oauth/callback?code=abc123",
      authData.redirectUri,
      authData.codeVerifier,
      authData.state,
      { ticketId: authData.ticketId },
    );

    const exchange = calls.find((c) => c.url.endsWith("/v1/oauth2/tokens"));
    expect(exchange.method).toBe("POST");
    expect(exchange.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(Object.fromEntries(new URLSearchParams(exchange.body))).toEqual({
      client_id: "CodeArts_Tui",
      code: "abc123",
      code_verifier: authData.codeVerifier,
      grant_type: "authorization_code",
      redirect_uri: CALLBACK_URL,
    });
    // Only the first two segments are JSON; the third is the raw ECDSA signature.
    const [dpopHeader, dpopPayload] = exchange.headers.dpop.split(".").slice(0, 2)
      .map((part) => JSON.parse(Buffer.from(part, "base64url").toString()));
    expect(dpopHeader).toMatchObject({ alg: "ES256", typ: "dpop+jwt" });
    expect(dpopPayload).toMatchObject({ htm: "POST", htu: "https://sts.cn-north-4.myhuaweicloud.com/v1/oauth2/tokens" });

    // Identity lookup is signed with the fresh AK/SK.
    const whoami = calls.find((c) => c.url.endsWith("/snap-manager/v1/current/user"));
    expect(whoami.headers.authorization).toMatch(/^SDK-HMAC-SHA256 Access=AK, /);

    expect(tokens.accessToken).toBe("ST");
    expect(tokens.refreshToken).toBe("REFRESH-JWT");
    expect(tokens.expiresIn).toBeGreaterThan(3000);
    expect(tokens.email).toBe("Dev");
    expect(JSON.parse(tokens.providerSpecificData.accountId)).toMatchObject({ user_id: "u1", domain_id: "d1" });
    // Refresh replays the DPoP proof, so the private half has to survive.
    expect(tokens.providerSpecificData.dpopKeyPair.privateKeyJwk.kty).toBe("EC");
    expect(tokens.providerSpecificData).toMatchObject({ authMethod: "oauth", accessKeyId: "AK", secretAccessKey: "SK" });
  });

  it("resolves a secret-style callback through the login ticket", async () => {
    mockFetch(async (call, index) => {
      if (call.url.includes("/v1/login/ticket")) {
        // The CLI polls once per second and the first attempt can still be pending.
        return index === 2 ? jsonResponse({}) : jsonResponse({ credential: { access: "AK", secret: "SK", securitytoken: "ST", expires_at: new Date(Date.now() + 3600_000).toISOString() } });
      }
      if (call.url.endsWith("/v1/oauth2/tokens")) throw new Error("PKCE exchange must not run for a secret callback");
      return jsonResponse({ user_id: "u1" });
    });
    const { exchangeTokens } = await loadLogin();
    const tokens = await exchangeTokens(
      "codearts",
      "/oauth/callback?secret=ticketsecret&redirect=https%3A%2F%2Fexample.invalid",
      CALLBACK_URL,
      "v".repeat(128),
      "state-1",
      { ticketId: "t".repeat(64) },
    );

    const ticket = calls.find((c) => c.url.includes("/v1/login/ticket"));
    expect(ticket.method).toBe("GET");
    expect(ticket.url).toContain("ticket_id=" + "t".repeat(64));
    expect(ticket.url).toContain("secret=ticketsecret");
    expect(tokens.providerSpecificData.accessKeyId).toBe("AK");
    expect(tokens.refreshToken).toBe(null);
  });

  it("surfaces an STS rejection instead of creating a broken connection", async () => {
    mockFetch(async () => jsonResponse({ error_description: "invalid code_verifier" }, 400));
    const { exchangeTokens } = await loadLogin();
    await expect(exchangeTokens("codearts", "/oauth/callback?code=x", CALLBACK_URL, "v".repeat(128), "s"))
      .rejects.toThrow("invalid code_verifier");
  });
});

describe("CodeArts AK/SK refresh", () => {
  // A proof is signed with the key that the exchange used, so the fixture has
  // to carry a real P-256 pair — a stub JWK fails at createPrivateKey().
  const dpopKeyPair = createDpopKeyPair();
  const stored = {
    accessToken: "ST",
    refreshToken: "REFRESH-JWT",
    providerSpecificData: {
      accessKeyId: "AK",
      secretAccessKey: "SK",
      securityToken: "ST",
      accountId: JSON.stringify({ user_id: "u1" }),
      dpopKeyPair,
    },
  };

  it("re-mints with the stored DPoP key and account header", async () => {
    vi.resetModules();
    mockFetch(async () => jsonResponse({ ...STS_TOKENS, refresh_token: undefined, credentials: { ...STS_TOKENS.credentials, access_key_id: "AK2", expiration: new Date(Date.now() + 7200_000).toISOString() } }));
    const { refreshCodeartsFromCredentials: refresh } = await import("open-sse/shared/codearts/auth.js");

    const patch = await refresh(stored);
    const call = calls.find((c) => c.url.endsWith("/v1/oauth2/tokens"));
    expect(call.headers["x-agent-user-account"]).toBe(stored.providerSpecificData.accountId);
    expect(Object.fromEntries(new URLSearchParams(call.body))).toEqual({
      client_id: "CodeArts_Tui",
      refresh_token: "REFRESH-JWT",
      grant_type: "refresh_token",
    });
    expect(patch.providerSpecificData.accessKeyId).toBe("AK2");
    // STS omits the refresh token on rotation; the presented one must be kept.
    expect(patch.refreshToken).toBe("REFRESH-JWT");
    expect(patch.providerSpecificData.accountId).toBe(stored.providerSpecificData.accountId);
  });

  it("reports a revoked grant as invalid_grant and a network fault as retryable", async () => {
    vi.resetModules();
    mockFetch(async () => jsonResponse({ error: "invalid_grant" }, 401));
    const { refreshCodeartsFromCredentials: refresh } = await import("open-sse/shared/codearts/auth.js");
    expect(await refresh(stored)).toMatchObject({ error: "invalid_grant" });

    vi.resetModules();
    mockFetch(async () => { throw new Error("ECONNRESET"); });
    const { refreshCodeartsFromCredentials: refreshDown } = await import("open-sse/shared/codearts/auth.js");
    expect(await refreshDown(stored)).toBe(null);
  });
});

/**
 * Qoder CN catalog + credential lifecycle regressions.
 *
 * Covers the three bugs behind the "active badge on a dead token" incident:
 *   - the catalog is scene-grouped; app-only models (free QoDuck / lmodel)
 *     vanished when only body.chat was parsed
 *   - an expired login surfaced as a request-scoped 400 ("model_config not
 *     yet known"), which never locks the account nor triggers a refresh
 *   - device tokens now renew via openapi deviceToken/refresh (rotating RT)
 * plus the badge's expiresAt override.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(),
}));

import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import {
  resolveQoderModels,
  routableQoderModels,
  clearQoderCatalog,
  QoderAuthError,
} from "../../open-sse/services/qoderModels.js";
import { refreshQoderDeviceToken, parseQoderExpiryMs } from "../../open-sse/shared/qoder/refresh.js";
import { QoderExecutor } from "../../open-sse/executors/qoder.js";
import {
  isConnectionTokenExpired,
  getEffectiveStatus,
  getStatusVariant,
} from "../../src/shared/utils/connectionStatus.js";

let seq = 0;
function creds(overrides = {}) {
  seq += 1;
  return {
    provider: "qoder-cn",
    accessToken: "dt-test-token",
    refreshToken: `drt-test-${seq}`,
    displayName: "Test User",
    providerSpecificData: { userId: `user-${seq}`, machineId: "machine-1" },
    ...overrides,
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  proxyAwareFetch.mockReset();
  clearQoderCatalog();
});

describe("scene-union catalog parsing", () => {
  it("surfaces app-only models (QoDuck) alongside chat models", async () => {
    proxyAwareFetch.mockResolvedValue(jsonResponse({
      chat: [{ key: "auto", display_name: "Auto", enable: true, max_input_tokens: 200000 }],
      app: [{ key: "lmodel", display_name: "QoDuck", enable: true, is_free: true, is_reasoning: true, max_input_tokens: 180000 }],
    }));
    const catalog = await resolveQoderModels(creds());
    expect(catalog.models.map((m) => m.id).sort()).toEqual(["auto", "lmodel"]);
    expect(catalog.rawConfigs.get("lmodel")).toMatchObject({ is_free: true, display_name: "QoDuck" });
    const qoduck = catalog.models.find((m) => m.id === "lmodel");
    expect(qoduck).toMatchObject({ name: "QoDuck", contextLength: 180000, isReasoning: true });
  });

  it("lets the chat scene win metadata ties", async () => {
    proxyAwareFetch.mockResolvedValue(jsonResponse({
      app: [{ key: "x", display_name: "AppX", max_input_tokens: 999 }],
      chat: [{ key: "x", display_name: "ChatX", max_input_tokens: 100 }],
    }));
    const catalog = await resolveQoderModels(creds());
    expect(catalog.models).toHaveLength(1);
    expect(catalog.models[0]).toMatchObject({ id: "x", name: "ChatX", contextLength: 100 });
  });

  it("keeps enable:false entries routable but hidden", async () => {
    proxyAwareFetch.mockResolvedValue(jsonResponse({
      chat: [{ key: "hid", display_name: "Hidden", enable: false }],
    }));
    const catalog = await resolveQoderModels(creds());
    expect(catalog.models).toHaveLength(0);
    expect(routableQoderModels(catalog)).toContainEqual({ id: "hid", name: "Hidden", hidden: true });
  });

  it("returns null when no scene arrays are present", async () => {
    proxyAwareFetch.mockResolvedValue(jsonResponse({ foo: "bar" }));
    expect(await resolveQoderModels(creds())).toBeNull();
  });
});

describe("catalog auth failures", () => {
  it.each([401, 403])("throws QoderAuthError on HTTP %i (expired login)", async (status) => {
    proxyAwareFetch.mockResolvedValue(jsonResponse({ code: "105", message: "Login expired" }, status));
    await expect(resolveQoderModels(creds())).rejects.toThrow(QoderAuthError);
  });

  it("stays silent (null) on server errors", async () => {
    proxyAwareFetch.mockResolvedValue(jsonResponse({}, 500));
    expect(await resolveQoderModels(creds())).toBeNull();
  });
});

describe("executor error mapping", () => {
  const executeWith = (credentials, model, listResponse) => {
    proxyAwareFetch.mockImplementation(async (url) => {
      if (String(url).includes("/model/list")) return listResponse;
      throw new Error(`unexpected fetch: ${url}`);
    });
    return new QoderExecutor("qoder-cn").execute({
      model,
      body: { messages: [{ role: "user", content: "hi" }], max_tokens: 8 },
      stream: false,
      credentials,
    });
  };

  it("maps an expired stored token to 401, not the request-scoped 400", async () => {
    const c = creds({ expiresAt: new Date(Date.now() - 60_000).toISOString() });
    const result = await executeWith(c, "dfmodel", jsonResponse({}, 500));
    expect(result.response.status).toBe(401);
    expect(await result.response.json()).toMatchObject({
      error: { message: expect.stringContaining("expired") },
    });
  });

  it("maps an upstream catalog 403 to 401 even with a future expiresAt", async () => {
    const c = creds({ expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    const result = await executeWith(c, "dfmodel", jsonResponse({ code: "105" }, 403));
    expect(result.response.status).toBe(401);
  });

  it("keeps genuinely unknown models a 400", async () => {
    const c = creds({ expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    const result = await executeWith(c, "not-a-model", jsonResponse({ chat: [{ key: "auto" }] }));
    expect(result.response.status).toBe(400);
    expect(await result.response.json()).toMatchObject({
      error: { message: expect.stringContaining("model_config") },
    });
  });

  it("needsRefresh follows expiresAt (base behavior restored)", () => {
    const executor = new QoderExecutor("qoder-cn");
    expect(executor.needsRefresh({ expiresAt: new Date(Date.now() - 1000).toISOString() })).toBe(true);
    expect(executor.needsRefresh({ expiresAt: new Date(Date.now() + 3_600_000).toISOString() })).toBe(false);
  });
});

describe("parseQoderExpiryMs", () => {
  it("accepts epoch seconds, epoch ms, numeric strings and RFC3339", () => {
    expect(parseQoderExpiryMs(1_794_011_557)).toBe(1_794_011_557_000);
    expect(parseQoderExpiryMs(1_794_011_557_000)).toBe(1_794_011_557_000);
    expect(parseQoderExpiryMs("1794011557")).toBe(1_794_011_557_000);
    expect(parseQoderExpiryMs("2026-12-07T00:29:15.700Z")).toBe(Date.parse("2026-12-07T00:29:15.700Z"));
  });

  it("returns null for missing or unparseable hints", () => {
    expect(parseQoderExpiryMs(undefined)).toBeNull();
    expect(parseQoderExpiryMs("")).toBeNull();
    expect(parseQoderExpiryMs("not-a-date")).toBeNull();
  });
});

describe("deviceToken/refresh", () => {
  it("posts the rotating refresh contract and maps the response", async () => {
    proxyAwareFetch.mockResolvedValue(jsonResponse({
      device_token: "dt-new",
      refresh_token: "drt-new",
      expires_at: "2026-12-07T00:00:00Z",
      refresh_token_expires_at: 1_894_011_557,
    }));
    const c = creds();
    const result = await refreshQoderDeviceToken(c, { region: "cn" });
    expect(result).toMatchObject({
      accessToken: "dt-new",
      refreshToken: "drt-new",
      expiresAt: "2026-12-07T00:00:00.000Z",
      providerSpecificData: { refreshTokenExpiresAt: new Date(1_894_011_557_000).toISOString() },
    });
    const [url, init] = proxyAwareFetch.mock.calls[0];
    expect(url).toBe("https://openapi.qoder.com.cn/api/v1/deviceToken/refresh");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ refresh_token: c.refreshToken, machine_id: "machine-1" });
    expect(init.headers.Authorization).toBeUndefined();
  });

  it("omits machine_id when unknown or absent", async () => {
    proxyAwareFetch.mockResolvedValue(jsonResponse({ device_token: "dt-new" }));
    await refreshQoderDeviceToken(creds({ providerSpecificData: { userId: "u", machineId: "unknown" } }), { region: "cn" });
    const body = JSON.parse(proxyAwareFetch.mock.calls[0][1].body);
    expect(body.machine_id).toBeUndefined();
  });

  it.each([
    ["missing refresh token", creds({ refreshToken: undefined })],
    ["PAT lane", creds({ apiKey: "pt-secret", accessToken: undefined })],
    ["job-token lane", creds({ accessToken: "jt-secret" })],
  ])("returns false for the %s", async (_label, c) => {
    expect(await refreshQoderDeviceToken(c, { region: "cn" })).toBe(false);
    expect(proxyAwareFetch).not.toHaveBeenCalled();
  });

  it("classifies a dead refresh token as invalid_grant (no retry)", async () => {
    proxyAwareFetch.mockResolvedValue(jsonResponse({ message: "invalid refresh token" }, 401));
    expect(await refreshQoderDeviceToken(creds(), { region: "cn" })).toEqual({ error: "invalid_grant" });
  });

  it("returns null on transient failures and malformed success bodies", async () => {
    proxyAwareFetch.mockResolvedValue(jsonResponse({}, 502));
    expect(await refreshQoderDeviceToken(creds(), { region: "cn" })).toBeNull();
    proxyAwareFetch.mockResolvedValue(jsonResponse({ nope: true }));
    expect(await refreshQoderDeviceToken(creds(), { region: "cn" })).toBeNull();
  });

  it("coalesces concurrent refreshes of the same rotating token", async () => {
    proxyAwareFetch.mockResolvedValue(jsonResponse({ device_token: "dt-new", refresh_token: "drt-new" }));
    const c = creds();
    const [a, b] = await Promise.all([
      refreshQoderDeviceToken(c, { region: "cn" }),
      refreshQoderDeviceToken(c, { region: "cn" }),
    ]);
    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
  });

  it("routes intl credentials to the intl openapi host", async () => {
    proxyAwareFetch.mockResolvedValue(jsonResponse({ device_token: "dt-new" }));
    await refreshQoderDeviceToken(creds({ provider: "qoder" }), {});
    expect(proxyAwareFetch.mock.calls[0][0]).toBe("https://openapi.qoder.sh/api/v1/deviceToken/refresh");
  });
});

describe("connection badge expiry", () => {
  it("detects past expiresAt only", () => {
    expect(isConnectionTokenExpired({ expiresAt: new Date(Date.now() - 1000).toISOString() })).toBe(true);
    expect(isConnectionTokenExpired({ expiresAt: new Date(Date.now() + 60_000).toISOString() })).toBe(false);
    expect(isConnectionTokenExpired({})).toBe(false);
    expect(isConnectionTokenExpired({ expiresAt: "garbage" })).toBe(false);
  });

  it("overrides a stale active status with expired", () => {
    const conn = { testStatus: "active" };
    expect(getEffectiveStatus(conn, { isTokenExpired: true })).toBe("expired");
    expect(getStatusVariant(true, "expired")).toBe("error");
  });

  it("keeps richer error states and the cooldown revert", () => {
    expect(getEffectiveStatus({ testStatus: "error" }, { isTokenExpired: true })).toBe("error");
    expect(getEffectiveStatus({ testStatus: "unavailable" }, { isCooldown: true })).toBe("unavailable");
    expect(getEffectiveStatus({ testStatus: "unavailable" }, { isCooldown: false })).toBe("active");
    expect(getEffectiveStatus({ testStatus: "active" }, {})).toBe("active");
  });
});
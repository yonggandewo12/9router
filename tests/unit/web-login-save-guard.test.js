// A login that "succeeded" but carried no credential used to be persisted as a
// normal active connection. The account fallback loop then kept picking it and
// every chat turn failed 401 "storage state is invalid" — a garbage row that
// looks healthy. These pin the guard and the happy path around it.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const state = vi.hoisted(() => ({
  session: null,
  identity: { status: "unknown", error: "probe timed out", email: "" },
  connections: [],
}));

vi.mock("@/models", () => ({
  getProviderConnections: vi.fn(async () => state.connections),
  createProviderConnection: vi.fn(async (data) => ({ id: "new-conn", ...data })),
  updateProviderConnection: vi.fn(async (id, data) => ({ id, ...data })),
  deleteProviderConnection: vi.fn(async () => true),
}));

vi.mock("@/shared/constants/providers", () => ({
  AI_PROVIDERS: { "chatgpt-web": { name: "ChatGPT Web" } },
}));

vi.mock("../../open-sse/services/webLogin.js", () => ({
  startWebLogin: vi.fn(),
  getWebLoginStatus: () => state.session,
  cancelWebLogin: vi.fn(),
  listWebLoginProfiles: () => ["default"],
}));

vi.mock("../../open-sse/services/webIdentity.js", () => ({
  fetchWebIdentity: vi.fn(async () => state.identity),
  hasWebIdentityProbe: () => true,
}));

const { GET } = await import("../../src/app/api/providers/web-login/route.js");
const { createProviderConnection, updateProviderConnection } = await import("@/models");

function get() {
  return GET(new NextRequest("http://localhost/api/providers/web-login?provider=chatgpt-web"));
}

beforeEach(() => {
  vi.clearAllMocks();
  state.identity = { status: "unknown", error: "probe timed out", email: "" };
  state.connections = [];
  state.session = {
    providerId: "chatgpt-web",
    profile: "default",
    status: "success",
    credential: "",
    proxyUrl: "",
    noProxy: "",
    savedConnectionId: null,
  };
});

describe("web-login save guard", () => {
  it("refuses to persist a connection that carries no credential", async () => {
    const body = await (await get()).json();

    expect(body.status).toBe("error");
    expect(body.error).toMatch(/without a credential/);
    expect(createProviderConnection).not.toHaveBeenCalled();
    expect(updateProviderConnection).not.toHaveBeenCalled();
    expect(state.session.savedConnectionId).toBeNull();
  });

  it("still saves when the identity probe was inconclusive but a cookie exists", async () => {
    // A probe timeout must not block a login the browser just performed.
    state.session.credential = "__Secure-next-auth.session-token=captured";
    const body = await (await get()).json();

    expect(body.status).toBe("success");
    expect(createProviderConnection).toHaveBeenCalledTimes(1);
    const saved = createProviderConnection.mock.calls[0][0];
    expect(saved.apiKey).toBe("__Secure-next-auth.session-token=captured");
    expect(saved.providerSpecificData.authMethod).toBe("web-login");
    expect(state.session.credential).toBeUndefined();
  });
});

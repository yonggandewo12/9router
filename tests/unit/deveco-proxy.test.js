// DevEco Code loopback callback proxy — the only path that turns a HUAWEI ID
// browser login into a stored connection. The portal redirects to
// http://127.0.0.1:<port>/?tempToken=…&siteId=1&code=<loginState>, so the
// listener must bind that ephemeral port, reject a foreign Origin, refuse a
// wrong `code`, and only then exchange + persist.
import { describe, it, expect, vi, afterEach } from "vitest";

const exchanged = [];

vi.mock("@/lib/oauth/providers.js", () => ({
  exchangeTokens: vi.fn(async (provider, code, redirectUri, _verifier, state) => {
    exchanged.push({ provider, code, redirectUri, state });
    // Mirror the real provider.exchangeToken: siteId must be the CN value "1".
    const siteId = new URLSearchParams(String(code).split("?")[1] || "").get("siteId");
    if (siteId && siteId !== "1") throw new Error("DevEco: unsupported account region");
    return {
      accessToken: "OPAQ",
      refreshToken: "J.W.T",
      expiresIn: 1800,
      providerSpecificData: { jwtToken: "J.W.T", authMethod: "oauth" },
    };
  }),
}));

vi.mock("@/models", () => ({
  createProviderConnection: vi.fn(async (data) => ({ id: "conn-1", ...data })),
}));

const {
  startDevecoProxy,
  stopDevecoProxy,
  registerDevecoSession,
  getDevecoSessionStatus,
  clearDevecoSession,
} = await import("@/lib/oauth/utils/server.js");

const realFetch = globalThis.fetch;
const CALLBACK_PATH = "/callback";

async function hit(port, query, headers) {
  const res = await realFetch(`http://127.0.0.1:${port}${CALLBACK_PATH}${query}`, { headers, redirect: "manual" });
  return { status: res.status, location: res.headers.get("location"), body: await res.text() };
}

// The real portal completes the loopback with a form POST — fields in the body.
async function hitForm(port, form, headers) {
  const res = await realFetch(`http://127.0.0.1:${port}${CALLBACK_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(form).toString(),
    redirect: "manual",
  });
  return { status: res.status, location: res.headers.get("location"), body: await res.text() };
}

afterEach(() => {
  stopDevecoProxy();
  clearDevecoSession();
  exchanged.length = 0;
});

describe("DevEco callback proxy", () => {
  it("binds 127.0.0.1 on an ephemeral port and reports the root callback URL", async () => {
    const started = await startDevecoProxy();
    expect(started.success).toBe(true);
    expect(started.callbackUrl).toBe(`http://127.0.0.1:${started.port}/callback`);
  });

  it("keeps the session pending on stray and cross-origin requests", async () => {
    const { port } = await startDevecoProxy();
    registerDevecoSession({ state: "state-1" });

    expect((await hit(port, "")).status).toBe(200);
    const csrf = await hit(port, "?tempToken=T&siteId=1&code=state-1", { Origin: "https://evil.example" });
    expect(csrf.status).toBe(403);
    expect(exchanged).toHaveLength(0);
    expect(getDevecoSessionStatus("state-1").status).toBe("pending");
  });

  it("refuses a callback whose echoed code is not the pending loginState", async () => {
    const { port } = await startDevecoProxy();
    registerDevecoSession({ state: "state-1" });
    const r = await hit(port, "?tempToken=T&siteId=1&code=attacker");
    expect(r.status).toBe(200);
    expect(r.body).toMatch(/mismatch/i);
    expect(exchanged).toHaveLength(0);
  });

  it("exchanges the real callback with the session state and persists the connection", async () => {
    const { port } = await startDevecoProxy();
    registerDevecoSession({ state: "state-1" });

    const r = await hit(port, `?tempToken=TEMPV&siteId=1&code=${"state-1"}`);
    // The CLI lands the browser back on the portal's loginSuccess page.
    expect(r.status).toBe(302);
    expect(r.location).toBe("https://cn.devecostudio.huawei.com/console/DevEcoCode/loginSuccess");

    expect(exchanged).toHaveLength(1);
    expect(exchanged[0].provider).toBe("deveco");
    expect(exchanged[0].code).toContain("tempToken=TEMPV");
    expect(exchanged[0].state).toBe("state-1");
    expect(exchanged[0].redirectUri).toBe(`http://127.0.0.1:${port}/callback`);

    const session = getDevecoSessionStatus("state-1");
    expect(session.status).toBe("done");
    expect(session.connectionId).toBe("conn-1");
  });

  it("rejects a non-CN siteId before exchanging", async () => {
    const { port } = await startDevecoProxy();
    registerDevecoSession({ state: "state-1" });
    const r = await hit(port, "?tempToken=T&siteId=2&code=state-1");
    // exchangeToken raises → the browser is bounced to loginFailed, no connection.
    expect(r.status).toBe(302);
    expect(r.location).toContain("loginFailed");
    expect(getDevecoSessionStatus("state-1").status).toBe("error");
  });

  it("accepts the real portal shape: POST with the login fields in the form body", async () => {
    const { port } = await startDevecoProxy();
    registerDevecoSession({ state: "state-post" });

    const r = await hitForm(port, { code: "state-post", tempToken: "TEMPBODY", siteId: "1" });
    expect(r.status).toBe(302);
    expect(r.location).toContain("loginSuccess");
    expect(exchanged).toHaveLength(1);
    expect(exchanged[0].code).toContain("tempToken=TEMPBODY");
    expect(exchanged[0].state).toBe("state-post");
  });

  it("rejects a POST body whose echoed code is not the pending state", async () => {
    const { port } = await startDevecoProxy();
    registerDevecoSession({ state: "state-post" });
    const r = await hitForm(port, { code: "attacker", tempToken: "T", siteId: "1" });
    expect(r.body).toMatch(/mismatch/i);
    expect(exchanged).toHaveLength(0);
  });

  it("accepts the portal's own cross-site Origin (huawei.com) — the real login shape", async () => {
    const { port } = await startDevecoProxy();
    registerDevecoSession({ state: "state-origin" });
    const r = await hitForm(port, { code: "state-origin", tempToken: "TEMPORIGIN", siteId: "1" }, { Origin: "https://cn.devecostudio.huawei.com" });
    expect(r.status).toBe(302);
    expect(r.location).toContain("loginSuccess");
    expect(exchanged).toHaveLength(1);
  });

  it("refuses a login body with no echoed code (state binding is mandatory)", async () => {
    const { port } = await startDevecoProxy();
    registerDevecoSession({ state: "state-origin" });
    const r = await hitForm(port, { tempToken: "T", siteId: "1" });
    expect(r.body).toMatch(/mismatch/i);
    expect(exchanged).toHaveLength(0);
  });

  it("reports a done session once the listener is gone (modal poll)", async () => {
    const { port } = await startDevecoProxy();
    registerDevecoSession({ state: "state-1" });
    await hit(port, "?tempToken=T&siteId=1&code=state-1");
    stopDevecoProxy();
    expect(getDevecoSessionStatus("state-1").status).toBe("done");
    clearDevecoSession("state-1");
    expect(getDevecoSessionStatus("state-1")).toBeNull();
  });
});

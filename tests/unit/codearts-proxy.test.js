// The CodeArts loopback callback proxy is the only path that turns a browser
// login into a stored connection, so pin its contract against a real HTTP
// listener: stray/cross-origin requests must not consume the session, the real
// callback must exchange with the session's own verifier + ticket_id, and the
// finished record must survive long enough for the modal to poll it.
import { describe, it, expect, vi, afterEach } from "vitest";

const exchanged = [];

vi.mock("@/lib/oauth/providers.js", () => ({
  exchangeTokens: vi.fn(async (provider, code, redirectUri, codeVerifier, state, meta) => {
    exchanged.push({ provider, code, redirectUri, codeVerifier, state, meta });
    return { accessToken: "ST", refreshToken: "RT", expiresIn: 3600, email: "dev@example.com" };
  }),
}));

vi.mock("@/models", () => ({
  createProviderConnection: vi.fn(async (data) => ({ id: "conn-1", ...data })),
}));

const {
  startCodeartsProxy,
  stopCodeartsProxy,
  registerCodeartsSession,
  getCodeartsSessionStatus,
  clearCodeartsSession,
} = await import("@/lib/oauth/utils/server.js");

const realFetch = globalThis.fetch;
const CALLBACK_PATH = "/oauth/callback";

async function hit(port, query, headers) {
  const res = await realFetch(`http://127.0.0.1:${port}${CALLBACK_PATH}${query}`, {
    headers,
    redirect: "manual",
  });
  return { status: res.status, location: res.headers.get("location"), body: await res.text() };
}

afterEach(() => {
  stopCodeartsProxy();
  clearCodeartsSession();
  exchanged.length = 0;
});

describe("CodeArts callback proxy", () => {
  it("binds 127.0.0.1 and reports the portal's fixed callback path", async () => {
    const started = await startCodeartsProxy();
    expect(started.success).toBe(true);
    expect(started.callbackUrl).toBe(`http://127.0.0.1:${started.port}${CALLBACK_PATH}`);
  });

  it("keeps a pending session on a stray request and on a foreign Origin", async () => {
    const { port } = await startCodeartsProxy();
    registerCodeartsSession({ state: "state-1", codeVerifier: "v".repeat(128), ticketId: "t".repeat(64) });

    expect((await hit(port, "")).status).toBe(200);
    // A page on another host must not be able to spend our single-use code.
    const csrf = await hit(port, "?code=attacker", { Origin: "https://evil.example" });
    expect(csrf.status).toBe(403);
    expect(exchanged).toHaveLength(0);

    const session = getCodeartsSessionStatus("state-1");
    expect(session.status).toBe("pending");
    // The same listener still owns the port, so the genuine redirect can land.
    expect((await startCodeartsProxy()).port).toBe(port);
  });

  it("exchanges with the session's verifier and ticket, then reports done to the poller", async () => {
    const { port } = await startCodeartsProxy();
    registerCodeartsSession({ state: "state-2", codeVerifier: "v".repeat(128), ticketId: "t".repeat(64) });

    const res = await hit(port, "?code=abc123&state=ignored");
    // The portal owns the browser, so send it back to its own login page and
    // never follow the callback's `redirect` param.
    expect(res.status).toBe(307);
    expect(res.location).toMatch(/^https:\/\/codearts\.huaweicloud\.com\/portal\/login\?login_succeed=true/);

    expect(exchanged).toHaveLength(1);
    const call = exchanged[0];
    expect(call.provider).toBe("codearts");
    expect(call.code).toBe(`${CALLBACK_PATH}?code=abc123&state=ignored`);
    expect(call.redirectUri).toBe(`http://127.0.0.1:${port}${CALLBACK_PATH}`);
    expect(call.codeVerifier).toBe("v".repeat(128));
    expect(call.state).toBe("state-2");
    expect(call.meta).toEqual({ ticketId: "t".repeat(64) });

    const session = getCodeartsSessionStatus("state-2");
    expect(session).toMatchObject({ status: "done", connectionId: "conn-1", email: "dev@example.com" });
    // The poll response feeds the modal — it must never carry login material.
    expect(JSON.stringify(session)).not.toContain("v".repeat(8));
    expect(JSON.stringify(session)).not.toContain("t".repeat(8));
  });

  it("surfaces a failed exchange to the poller without killing the listener", async () => {
    const { port } = await startCodeartsProxy();
    registerCodeartsSession({ state: "state-3", codeVerifier: "v".repeat(128) });
    const { exchangeTokens } = await import("@/lib/oauth/providers.js");
    exchangeTokens.mockRejectedValueOnce(new Error("invalid code_verifier"));

    const res = await hit(port, "?code=spent");
    expect(res.status).toBe(307);
    expect(res.location).toContain("login_succeed=false");
    expect(getCodeartsSessionStatus("state-3")).toMatchObject({ status: "error", error: "invalid code_verifier" });

    // The listener is deliberately still up (an older popup may land late), so a
    // second callback must be answered from the record instead of re-exchanging.
    exchanged.length = 0;
    expect((await hit(port, "?code=spent-again")).location).toContain("login_succeed=false");
    expect(exchanged).toHaveLength(0);

    // "Try again" re-registers on the very same port.
    expect((await startCodeartsProxy()).port).toBe(port);
  });

  it("answers only the pending state, and only with public fields", async () => {
    await startCodeartsProxy();
    registerCodeartsSession({ state: "state-4", codeVerifier: "v".repeat(128), ticketId: "t".repeat(64) });
    expect(Object.keys(getCodeartsSessionStatus("state-4")).sort())
      .toEqual(["connectionId", "email", "error", "state", "status"]);
    // A second login replaces the singleton, so an abandoned modal cannot poll it.
    registerCodeartsSession({ state: "state-5", codeVerifier: "w".repeat(128) });
    expect(getCodeartsSessionStatus("state-4")).toBe(null);
  });
});

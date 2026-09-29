// DevEco Code (华为) — the MaaS gateway speaks OpenAI shapes but breaks two
// generic assumptions: auth failures come back as HTTP 200 with a JSON error
// body (never 401), and the mandatory Chat-Id is conversation-stable. These
// tests pin the executor's repairs plus the auth/refresh credential chain.
import { describe, it, expect, vi } from "vitest";
import crypto from "node:crypto";

import { PROVIDERS, PROVIDER_MODELS, PROVIDER_OAUTH } from "open-sse/providers/index.js";
import { getExecutor } from "open-sse/executors/index.js";
import {
  buildAuthorizeUrl,
  checkJwtToken,
  exchangeTempToken,
  refreshDevecoFromCredentials,
  toDevecoCredentialPatch,
  DEVECO_TOKEN_TTL_MS,
} from "open-sse/shared/deveco/auth.js";
import { __internal__ } from "open-sse/executors/deveco.js";

const { chatIdFor, parseAuthRejection, bareModel, sniffStreamHead, couldOverflow } = __internal__;

describe("DevEco provider wiring", () => {
  it("is registered with the MaaS chat endpoint", () => {
    expect(PROVIDERS.deveco.baseUrl).toBe(
      "https://cn.devecostudio.huawei.com/sse/codeGenie/maas/v2/chat/completions"
    );
    expect(PROVIDER_MODELS.dv.map((m) => m.id)).toEqual([
      "GLM-5.1",
      "GLM-5.3",
      "Qwen3_VL_235B_A22B_Instruct",
    ]);
    expect(PROVIDER_OAUTH.deveco.appId).toBe("1008");
    expect(PROVIDER_OAUTH.deveco.baseUrl).toBe("https://cn.devecostudio.huawei.com");
  });

  it("routes the dedicated executor (dv canonicalizes to deveco first)", async () => {
    const { resolveProviderAlias } = await import("open-sse/services/model.js");
    expect(getExecutor("deveco").constructor.name).toBe("DevEcoExecutor");
    expect(resolveProviderAlias("dv")).toBe("deveco");
    expect(getExecutor(resolveProviderAlias("dv")).constructor.name).toBe("DevEcoExecutor");
  });
});

describe("DevEco executor headers", () => {
  const ex = getExecutor("deveco");

  it("carries Bearer + lang + 32-hex Chat-Id and streams", () => {
    const creds = { accessToken: "OPAQ123", providerSpecificData: {} };
    const h = ex.buildHeaders(creds, true);
    expect(h.Authorization).toBe("Bearer OPAQ123");
    expect(h.lang).toBe("en");
    expect(h.Accept).toBe("text/event-stream");
    expect(h["Chat-Id"]).toMatch(/^[0-9a-f]{32}$/);
  });

  it("drops Accept for non-stream", () => {
    const h = ex.buildHeaders({ accessToken: "T", providerSpecificData: {} }, false);
    expect(h.Accept).toBeUndefined();
  });
});

describe("DevEco Chat-Id conversation stability", () => {
  it("is stable per session, distinct across sessions", () => {
    const a = chatIdFor("ses_abc");
    expect(a).toBe(chatIdFor("ses_abc"));
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(chatIdFor("ses_xyz")).not.toBe(a);
  });

  it("execute() pins the session's Chat-Id into the wire headers", async () => {
    const ex = getExecutor("deveco");
    let wireChatId = null;
    vi.spyOn(Object.getPrototypeOf(Object.getPrototypeOf(ex)), "execute").mockImplementation(async (args) => {
      wireChatId = args.credentials[Symbol.for("deveco.chatId")];
      return { response: new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } }) };
    });
    await ex.execute({ providerSessionId: "conv-1", model: "deveco/GLM-5.1", messages: [], credentials: {} });
    expect(wireChatId).toBe(chatIdFor("conv-1"));
    const h = ex.buildHeaders({ accessToken: "T", [Symbol.for("deveco.chatId")]: wireChatId }, true);
    expect(h["Chat-Id"]).toBe(chatIdFor("conv-1"));
    vi.restoreAllMocks();
  });
});

describe("DevEco 200-with-error-body repair (refresh chain)", () => {
  it("classifies the live errorCode:4016 invalid-token body", () => {
    const body = '{"errorCode":4016,"errorMsg":"invalid accessToken.","session":{},"id":"x"}';
    const j = parseAuthRejection(body);
    expect(j?.errorCode).toBe(4016);
  });

  it("leaves genuine non-auth JSON alone", () => {
    expect(parseAuthRejection('{"errorCode":5099,"errorMsg":"model not found"}')).toBeNull();
    expect(parseAuthRejection("data: [DONE]")).toBeNull();
    expect(parseAuthRejection('{"id":"chatcmpl-1","choices":[]}')).toBeNull();
  });

  it("rebuilds the auth refusal as 401 so chatCore refreshes", async () => {
    const ex = getExecutor("deveco");
    vi.spyOn(ex, "transformRequest").mockImplementation((m, b) => b);
    vi.spyOn(ex, "buildHeaders").mockReturnValue({});
    const original = ex.getBaseUrl?.bind(ex);
    void original;
    // Super-stub the upstream: DefaultExecutor.execute is replaced with one
    // returning the gateway's exact live 200+errorCode:4016 payload.
    vi.spyOn(Object.getPrototypeOf(Object.getPrototypeOf(ex)), "execute").mockResolvedValue({
      response: new Response('{"errorCode":4016,"errorMsg":"invalid accessToken."}', {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    });
    const result = await ex.execute({ providerSessionId: "s", model: "deveco/GLM-5.1", messages: [], credentials: {} });
    expect(result.response.status).toBe(401);
    const body = await result.response.json();
    expect(body.error.type).toBe("authentication_error");
    vi.restoreAllMocks();
  });

  it("does NOT touch a real streaming 200", async () => {
    const ex = getExecutor("deveco");
    const sse = "data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\ndata: [DONE]\n\n";
    vi.spyOn(Object.getPrototypeOf(Object.getPrototypeOf(ex)), "execute").mockResolvedValue({
      response: new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
    });
    const result = await ex.execute({ providerSessionId: "s", model: "deveco/GLM-5.1", messages: [], credentials: {} });
    expect(result.response.status).toBe(200);
    expect(result.response.headers.get("content-type")).toContain("event-stream");
    vi.restoreAllMocks();
  });
});

describe("DevEco request transform", () => {
  const ex = getExecutor("deveco");

  it("strips provider prefix and defaults max_tokens", () => {
    const out = ex.transformRequest("deveco/GLM-5.1", { model: "deveco/GLM-5.1", messages: [] }, true, {});
    expect(out.model).toBe("GLM-5.1");
    expect(out.max_tokens).toBe(32000);
  });

  it("keeps a client-set max_tokens", () => {
    const out = ex.transformRequest("deveco/GLM-5.1", { model: "GLM-5.1", messages: [], max_tokens: 1000 }, true, {});
    expect(out.max_tokens).toBe(1000);
  });

  it("defaults max_tokens per the model's declared ceiling (Qwen3_VL: 8192)", () => {
    const out = ex.transformRequest("deveco/Qwen3_VL_235B_A22B_Instruct", { model: "Qwen3_VL_235B_A22B_Instruct", messages: [] }, true, {});
    expect(out.max_tokens).toBe(8192);
  });

  it("drops tool_choice when no tools are declared (fake-overload guard)", () => {
    const out = ex.transformRequest("deveco/GLM-5.1", { model: "GLM-5.1", messages: [], tool_choice: "required" }, true, {});
    expect(out.tool_choice).toBeUndefined();
    const withTools = ex.transformRequest(
      "deveco/GLM-5.1",
      { model: "GLM-5.1", messages: [], tool_choice: "auto", tools: [{ type: "function", function: { name: "f" } }] },
      true,
      {}
    );
    expect(withTools.tool_choice).toBe("auto");
  });

  it("bareModel tolerates no-prefix ids", () => {
    expect(bareModel("GLM-5.3")).toBe("GLM-5.3");
    expect(bareModel("dv/GLM-5.3")).toBe("GLM-5.3");
  });
});

describe("DevEco overflow gate (couldOverflow)", () => {
  // Qwen3_VL window 32768 → threshold 147456 bytes.
  const ARGS = { model: "deveco/Qwen3_VL_235B_A22B_Instruct" };
  const over = 147456;

  it("ASCII body over the window in chars → overflow decided without a byte scan", () => {
    expect(couldOverflow({ bodyStr: "x".repeat(over + 1) }, ARGS, over)).toBe(true);
  });

  it("small body (≤ threshold/3 chars) → fits, no byte scan", () => {
    expect(couldOverflow({ bodyStr: "x".repeat(over / 3) }, ARGS, over)).toBe(false);
  });

  it("CJK middle band: chars under window but bytes over → measured, overflow=true", () => {
    // 50000 chars ≤ 147456, ×3 = 150000 > 147456 → exact scan; 3 bytes/char → 150000 > threshold.
    expect(couldOverflow({ bodyStr: "字".repeat(50000) }, ARGS, over)).toBe(true);
  });

  it("huge base64 image is excluded (a few hundred KB base64 is ~1k tokens, not overflow)", () => {
    const body = `{"messages":[{"content":"data:image/png;base64,${"A".repeat(600000)}"}]}`;
    expect(couldOverflow({ bodyStr: body }, ARGS, over)).toBe(false);
  });

  it("text around a base64 blob still counts: over-window text + image → overflow", () => {
    const body = `{"messages":[{"content":"${"x".repeat(200000)} data:image/png;base64,${"A".repeat(1000)}"}]}`;
    expect(couldOverflow({ bodyStr: body }, ARGS, over)).toBe(true);
  });

  it("falls back to re-serializing transformedBody when bodyStr is absent", () => {
    expect(couldOverflow({ transformedBody: { pad: "x".repeat(over + 1) } }, ARGS, over)).toBe(true);
    expect(couldOverflow({}, { ...ARGS, body: { pad: "x".repeat(over + 1) } }, over)).toBe(true);
  });

  it("execute() passes normal-sized traffic straight through (response identity, no 3s sniff)", async () => {
    const ex = getExecutor("deveco");
    const sse = new Response("data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
    vi.spyOn(Object.getPrototypeOf(Object.getPrototypeOf(ex)), "execute").mockResolvedValue({
      response: sse, bodyStr: '{"model":"Qwen3_VL_235B_A22B_Instruct","messages":[{"content":"hi"}]}',
    });
    const r = await ex.execute({ providerSessionId: "g1", model: "deveco/Qwen3_VL_235B_A22B_Instruct", messages: [], credentials: {} });
    expect(r.response).toBe(sse);
    vi.restoreAllMocks();
  });
});

describe("DevEco context-overflow relabelling (Claude Code compaction trigger)", () => {
  const ex = getExecutor("deveco");
  const bigBody = (n) => ({ model: "deveco/GLM-5.1", messages: [{ role: "user", content: "x".repeat(n) }], stream: true });
  const REFUSE = "id: 0\ndata: \n\nid: 1\nevent: error\ndata: {\"error\":{\"message\":\"Built-in model service is currently overloaded. Please retry later or set up a custom model.\",\"type\":\"ModelServiceError\",\"code\":\"403\"}}\n\n";
  const REAL = "data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\ndata: [DONE]\n\n";
  // transformedBody is what actually goes on the wire — mirror the caller's body
  // so the size gate sees the same bytes production would send.
  const mockUpstream = (body, wireBytes) => vi.spyOn(Object.getPrototypeOf(Object.getPrototypeOf(ex)), "execute").mockResolvedValue({
    response: new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
    transformedBody: { model: "GLM-5.1", pad: "x".repeat(wireBytes ?? 1200000) },
  });

  it("over-window request + refusal → 400 whose message contains \"prompt is too long\"", async () => {
    mockUpstream(REFUSE);
    const r = await ex.execute({ providerSessionId: "ovf-1", model: "deveco/GLM-5.1", body: bigBody(1200000), stream: true, credentials: {} });
    expect(r.response.status).toBe(400);
    const j = await r.response.json();
    expect(j.error.message).toContain("prompt is too long");
    expect(j.error.message).toContain("170000");
    expect(j.error.type).toBe("invalid_request_error");
    vi.restoreAllMocks();
  });

  it("under-window request is never sniffed (stream identity + zero added latency)", async () => {
    mockUpstream(REAL, 1000);
    const r = await ex.execute({ providerSessionId: "und-1", model: "deveco/GLM-5.1", body: bigBody(1000), stream: true, credentials: {} });
    expect(r.response.status).toBe(200);
    expect(await r.response.text()).toBe(REAL);
    vi.restoreAllMocks();
  });

  it("over-window but genuinely generating → bytes replay intact, no relabel", async () => {
    mockUpstream(REAL);
    const r = await ex.execute({ providerSessionId: "ovf-2", model: "deveco/GLM-5.1", body: bigBody(1200000), stream: true, credentials: {} });
    expect(r.response.status).toBe(200);
    expect(await r.response.text()).toBe(REAL);
    vi.restoreAllMocks();
  });

  it("over-window with a refusal that is NOT the overload message stays retryable", async () => {
    mockUpstream("data: {\"error\":{\"message\":\"upstream busy\",\"code\":\"503\"}}\n\n");
    const r = await ex.execute({ providerSessionId: "ovf-3", model: "deveco/GLM-5.1", body: bigBody(1200000), stream: true, credentials: {} });
    expect(r.response.status).toBe(200);
    expect(await r.response.text()).toContain("upstream busy");
    vi.restoreAllMocks();
  });

  it("unknown model window disables relabelling rather than guessing", async () => {
    mockUpstream(REFUSE);
    const r = await ex.execute({ providerSessionId: "ovf-4", model: "deveco/NOT-A-MODEL", body: bigBody(1200000), stream: true, credentials: {} });
    expect(r.response.status).toBe(200);
    vi.restoreAllMocks();
  });
});

describe("DevEco stream-head sniffing", () => {
  it("loses no bytes when the sniff times out with a read still pending", async () => {
    let push, finish;
    const enc = new TextEncoder();
    const stream = new ReadableStream({
      start(c) { push = (s) => c.enqueue(enc.encode(s)); finish = () => c.close(); },
    });
    const res = new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    const { head, replayed, timedOut } = await sniffStreamHead(res, 30);
    expect(timedOut).toBe(true);
    expect(head).toBe("");

    // The first chunk lands AFTER the sniff window — it was delivered to the
    // read that lost the race, so replay must await that promise, not a fresh
    // read (the old shape dropped this chunk silently).
    const body = replayed.text();
    push("data: A\n\n");
    await new Promise((r) => setTimeout(r, 10));
    push("data: B\n\n");
    finish();
    expect(await body).toBe("data: A\n\ndata: B\n\n");
  });

  it("keeps reading frames until the refusal signature appears", async () => {
    let push, finish;
    const enc = new TextEncoder();
    const stream = new ReadableStream({
      start(c) { push = (s) => c.enqueue(enc.encode(s)); finish = () => c.close(); },
    });
    const res = new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    const sniff = sniffStreamHead(res, 1000);
    setTimeout(() => {
      push("id: 0\ndata: \n\n");
      setTimeout(() => {
        push('id: 1\nevent: error\ndata: {"error":{"message":"Built-in model service is currently overloaded."}}\n\n');
        finish();
      }, 5);
    }, 5);
    const { head, timedOut } = await sniff;
    expect(timedOut).toBe(false);
    expect(head).toContain("currently overloaded");
  });
});

describe("DevEco auth chain", () => {
  it("authorize URL carries loopback port + appid + state code", () => {
    const url = buildAuthorizeUrl(54321, "state123");
    expect(url).toBe("https://cn.devecostudio.huawei.com/console/DevEcoIDE/apply?port=54321&appid=1008&code=state123");
  });

  it("temptoken check reads the RAW-TEXT jwtToken body (CLI: o.data.trim())", async () => {
    const fetchMock = vi.fn(async () => new Response(" eyJhbGci.eyJ1c2VyIjoxfQ.sig ", { status: 200 }));
    const mod = await import("open-sse/utils/proxyFetch.js");
    vi.spyOn(mod, "proxyAwareFetch").mockImplementation(fetchMock);
    const jwt = await exchangeTempToken("TEMP&extra=1");
    expect(jwt).toBe("eyJhbGci.eyJ1c2VyIjoxfQ.sig");
    const [url, init, proxyOptions] = fetchMock.mock.calls[0];
    expect(url).toContain("/authrouter/auth/api/temptoken/check");
    expect(new URL(url).searchParams.get("tempToken")).toBe("TEMP");
    expect(new URL(url).searchParams.get("appid")).toBe("1008");
    expect(init.method).toBe("GET");
    expect(proxyOptions).toBeNull();
    vi.restoreAllMocks();
  });

  it("temptoken check rejects a non-JWT body instead of handing back garbage", async () => {
    const mod = await import("open-sse/utils/proxyFetch.js");
    vi.spyOn(mod, "proxyAwareFetch").mockImplementation(async () => new Response("login expired", { status: 200 }));
    await expect(exchangeTempToken("T")).rejects.toThrow(/JWT form/);
    vi.restoreAllMocks();
  });

  it("jwtToken check returns credentials from the live userInfo shape", async () => {
    const payload = {
      status: true,
      userInfo: { accessToken: "OPAQ", refreshToken: "", userId: "u1", name: "dev", nationalCode: "CN", realName: true },
    };
    const mod = await import("open-sse/utils/proxyFetch.js");
    vi.spyOn(mod, "proxyAwareFetch").mockImplementation(async () => new Response(JSON.stringify(payload), { status: 200 }));
    const creds = await checkJwtToken("a.b.c");
    expect(creds).toMatchObject({ accessToken: "OPAQ", userId: "u1", isRealName: true, countryCode: "CN" });
    // header contract: jwtToken + refresh flag ride on headers, live-verified.
    const [, init] = mod.proxyAwareFetch.mock.calls[0];
    expect(init.headers.jwtToken).toBe("a.b.c");
    expect(init.headers.refresh).toBe("false");
    vi.restoreAllMocks();
  });

  it("status:false (expired/invalid jwt) yields null → caller re-logins", async () => {
    const mod = await import("open-sse/utils/proxyFetch.js");
    vi.spyOn(mod, "proxyAwareFetch").mockImplementation(async () =>
      new Response(JSON.stringify({ status: false, userInfo: { accessToken: null } }), { status: 200 }));
    expect(await checkJwtToken("dead.jwt")).toBeNull();
    vi.restoreAllMocks();
  });

  it("refresh rotates the access token from the stored jwtToken", async () => {
    const mod = await import("open-sse/utils/proxyFetch.js");
    const fresh = { status: true, userInfo: { accessToken: "NEW", userId: "u1", nationalCode: "CN", realName: "true" } };
    vi.spyOn(mod, "proxyAwareFetch").mockImplementation(async () => new Response(JSON.stringify(fresh), { status: 200 }));
    const stored = { accessToken: "OLD", refreshToken: "OLDJWT", providerSpecificData: { jwtToken: "OLDJWT" } };
    const patch = await refreshDevecoFromCredentials(stored);
    expect(patch.accessToken).toBe("NEW");
    expect(patch.providerSpecificData.jwtToken).toBe("OLDJWT");
    // floor((expiresAt - now)/1000) straddles the second boundary — tolerate the
    // one-second slop instead of flaking on a millisecond tick.
    expect(patch.expiresIn).toBeGreaterThanOrEqual(Math.floor(DEVECO_TOKEN_TTL_MS / 1000) - 1);
    expect(patch.expiresIn).toBeLessThanOrEqual(Math.floor(DEVECO_TOKEN_TTL_MS / 1000));
    const [, init] = mod.proxyAwareFetch.mock.calls[0];
    expect(init.headers.refresh).toBe("true");
    expect(init.headers.jwtToken).toBe("OLDJWT");
    vi.restoreAllMocks();
  });

  it("missing jwtToken short-circuits as invalid_grant without a network call", async () => {
    const patch = await refreshDevecoFromCredentials({ accessToken: "X", providerSpecificData: {} });
    expect(patch.error).toBe("invalid_grant");
  });

  it("credential patch keeps both token slots the executor/refresh read", () => {
    const patch = toDevecoCredentialPatch({
      accessToken: "OP", jwtToken: "J.W.T", expiresAt: Date.now() + 60000, userId: "u", userName: "n",
    });
    expect(patch.accessToken).toBe("OP");
    expect(patch.providerSpecificData.jwtToken).toBe("J.W.T");
    expect(patch.expiresIn).toBeGreaterThanOrEqual(60);
  });
});

describe("DevEco credential persistence", () => {
  it("jwtToken survives into providerSpecificData for later refresh", () => {
    const patch = toDevecoCredentialPatch({
      accessToken: "A", refreshToken: "R", jwtToken: "JWT", expiresAt: Date.now() + 100000,
      countryCode: "CN", isRealName: true,
    });
    expect(patch.refreshToken).toBe("JWT");
    expect(patch.providerSpecificData).toMatchObject({ jwtToken: "JWT", authMethod: "oauth" });
    const key = crypto.createHash("sha256").update(JSON.stringify(Object.keys(patch.providerSpecificData).sort())).digest("hex");
    expect(key).toBeTruthy();
  });
});

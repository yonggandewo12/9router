// 华为云码道 (CodeArts): every snap-access call is signed with Huawei's
// SDK-HMAC-SHA256 over the temporary AK/SK minted by the DPoP login, so the
// wiring has to hold together without a bearer token anywhere.
import { describe, it, expect, vi, beforeEach } from "vitest";
import crypto from "node:crypto";
import http from "node:http";

import { PROVIDERS, PROVIDER_MODELS, PROVIDER_OAUTH } from "open-sse/providers/index.js";
import { getCapabilitiesForModel } from "open-sse/providers/capabilities.js";
import { clearLiveCapabilities } from "open-sse/providers/liveCapabilities.js";
import { getThinkingLevels } from "open-sse/providers/thinkingLevels.js";
import { getExecutor } from "open-sse/executors/index.js";
import { stripUnsupportedParams, stripsThinkingParams } from "open-sse/translator/concerns/paramSupport.js";
import { canonicalUri, canonicalQuery, formatSdkDate, signHuaweiRequest, uriEncode } from "open-sse/shared/codearts/signer.js";
import { capRetryDelayMs, isSessionCapExceeded, isEntitlementExhausted, isModelQueued, queueRetryDelayMs, sendUntilAdmitted, sleep } from "open-sse/shared/codearts/sessionCap.js";
import { mapCodeartsModel, resolveCodeartsModels, codeartsKeys } from "open-sse/shared/codearts/api.js";
import { parseSSEToOpenAIResponse } from "open-sse/handlers/chatCore/sseToJsonHandler.js";
import {
  buildAuthorizeUrl,
  buildDpopProof,
  createDpopKeyPair,
  credentialsFromStore,
  normalizeTokenResponse,
  refreshCodeartsFromCredentials,
  toCodeartsCredentialPatch,
} from "open-sse/shared/codearts/auth.js";

// Only refreshCodeartsFromCredentials is doubled (its real path is a live STS
// POST); it delegates to the real implementation by default so the crypto
// tests below keep working, and individual tests stub one call at a time.
vi.mock("open-sse/shared/codearts/auth.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    refreshCodeartsFromCredentials: vi.fn((...args) => actual.refreshCodeartsFromCredentials(...args)),
  };
});

const URL_INFERENCE = "https://snap-access.cn-north-4.myhuaweicloud.com/api/v2/chat/completions";
const FIXED_DATE = new Date(Date.UTC(2026, 8, 20, 1, 2, 3));

describe("codearts registry wiring", () => {
  it("registers the provider, alias and oauth entry", () => {
    expect(PROVIDERS.codearts.baseUrl).toBe(`${URL_INFERENCE}`);
    expect(PROVIDERS.codearts.format).toBe("openai");
    expect(PROVIDER_MODELS.ca).toBeDefined();
    expect(PROVIDER_OAUTH.codearts.refreshLeadMs).toBe(600000);
  });

  it("declares no bearer/apiKey auth descriptor — the executor signs instead", () => {
    expect(PROVIDERS.codearts.auth).toBeUndefined();
  });

  it("gives every static model a reasoning + output ceiling", () => {
    for (const model of PROVIDER_MODELS.ca) {
      const caps = getCapabilitiesForModel("codearts", model.id);
      expect(caps.maxOutput).toBeGreaterThan(0);
      expect(caps.contextWindow).toBeGreaterThan(0);
    }
  });

  it("static ids are InferHub ROUTE keys, not the display model_name", () => {
    // The gateway 404s "model is not registered" for the pretty names
    // ("OpenPangu-2.0-Pro"); only model_id values route (live-proven 2026-09-22).
    expect(PROVIDER_MODELS.ca.map((m) => m.id)).toEqual([
      "GLM-5.2", "glm-5.2-sft-harmony", "openpangu-2.0-pro", "openpangu-2.0-flash",
    ]);
  });

  it("resolves CodeartsExecutor", () => {
    expect(getExecutor("codearts").constructor.name).toBe("CodeartsExecutor");
  });
});

describe("Huawei request signing", () => {
  it("uriEncode keeps only RFC 3986 unreserved characters", () => {
    expect(uriEncode("aB0-._~ /:%")).toBe("aB0-._~%20%2F%3A%25");
  });

  it("canonical URI always carries the trailing slash the gateway signs", () => {
    expect(canonicalUri("/api/v2/chat/completions")).toBe("/api/v2/chat/completions/");
    expect(canonicalUri("")).toBe("/");
  });

  it("canonical query is key-sorted and value-encoded", () => {
    expect(canonicalQuery([["b", "2"], ["a", "1"], ["a", "0"]])).toBe("a=0&a=1&b=2");
    // Uppercase sorts before lowercase: the gateway compares code points, and a
    // locale-aware sort would reorder this pair (and vary with the ICU build).
    expect(canonicalQuery([["a", "2"], ["B", "1"], ["multi", ["y", "x"]]])).toBe("B=1&a=2&multi=x&multi=y");
  });

  it("formatSdkDate is UTC YYYYMMDDTHHmmssZ", () => {
    expect(formatSdkDate(FIXED_DATE)).toBe("20260920T010203Z");
  });

  it("builds a deterministic Authorization header with x-security-token", () => {
    const a = signHuaweiRequest({
      accessKeyId: "AK", secretAccessKey: "SK", securityToken: "ST",
      method: "post", url: `${URL_INFERENCE}?x=1`, body: '{"model":"GLM-5.2"}',
      headers: { "Content-Type": "application/json" }, date: FIXED_DATE,
    });
    const b = signHuaweiRequest({
      accessKeyId: "AK", secretAccessKey: "SK", securityToken: "ST",
      method: "POST", url: `${URL_INFERENCE}?x=1`, body: '{"model":"GLM-5.2"}',
      headers: { "content-type": "application/json" }, date: FIXED_DATE,
    });

    expect(a.Authorization).toBe(b.Authorization);
    expect(a.Authorization).toMatch(/^SDK-HMAC-SHA256 Access=AK, SignedHeaders=[a-z0-9;-]+, Signature=[0-9a-f]{64}$/);
    expect(a["x-sdk-date"]).toBe("20260920T010203Z");
    expect(a["x-security-token"]).toBe("ST");
    expect(a.host).toBe("snap-access.cn-north-4.myhuaweicloud.com");
    // Every signed name must be a header we actually send, in sorted order.
    const declared = a.Authorization.match(/SignedHeaders=([^,]+),/)[1].split(";");
    expect(declared).toEqual([...declared].sort());
    for (const name of declared) expect(a[name]).toBeDefined();
    expect(declared).toContain("x-security-token");
  });

  it("changing any single signed input changes the signature", () => {
    const base = {
      accessKeyId: "AK", secretAccessKey: "SK", securityToken: "ST",
      method: "POST", url: URL_INFERENCE, body: "{}", date: FIXED_DATE,
    };
    const signature = (patch) => signHuaweiRequest({ ...base, ...patch }).Authorization.split("Signature=")[1];
    const original = signature({});
    expect(signature({ body: '{"a":1}' })).not.toBe(original);
    expect(signature({ securityToken: "OTHER" })).not.toBe(original);
    expect(signature({ date: new Date(FIXED_DATE.getTime() + 1000) })).not.toBe(original);
    expect(signature({ url: `${URL_INFERENCE}?a=1` })).not.toBe(original);
  });

  it("rejects credentials that are missing the SK", () => {
    expect(() => signHuaweiRequest({ accessKeyId: "AK", secretAccessKey: "", method: "POST", url: URL_INFERENCE })).toThrow(/accessKeyId/);
  });
});

describe("CodeartsExecutor request shape", () => {
  const exec = getExecutor("codearts");
  const credentials = {
    accessToken: "ST",
    providerSpecificData: { accessKeyId: "AK", secretAccessKey: "SK", securityToken: "ST" },
  };

  // Records what actually left the process, so a test can assert on the wire
  // bytes instead of only on the object buildHeaders returned.
  async function startEchoServer() {
    const seen = [];
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        seen.push(req.headers);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("{}");
      });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return {
      url: `http://127.0.0.1:${server.address().port}/api/v2/chat/completions`,
      seen,
      close: () => new Promise((resolve) => server.close(resolve)),
    };
  }

  it("injects tool_stream, a default max_tokens and the flattened user_prompt", () => {
    const out = exec.transformRequest("codearts/GLM-5.2", {
      messages: [{ role: "user", content: [{ type: "text", text: "hi " }, { type: "text", text: "there\r\n" }] }],
    }, true, credentials);
    expect(out.model).toBe("GLM-5.2");
    expect(out.tool_stream).toBe(true);
    // The default is the model's own published ceiling, not the CLI's 32000: a
    // 32000 default silently truncated long agent outputs at half the room the
    // model has, and billing counts generated tokens rather than the ceiling.
    expect(out.max_tokens).toBe(getCapabilitiesForModel("codearts", "GLM-5.2").maxOutput);
    expect(out.user_prompt).toBe("hi there  ");
  });

  it("defaults an unpublished id to the capability floor, not to 32000", () => {
    const out = exec.transformRequest("brand-new-model", { messages: [] }, false, credentials);
    expect(out.max_tokens).toBe(getCapabilitiesForModel("codearts", "brand-new-model").maxOutput);
    expect(out.max_tokens).toBeGreaterThan(32000);
  });

  it("leaves a caller-supplied output limit alone", () => {
    const out = exec.transformRequest("GLM-5.2", { messages: [], max_tokens: 1234 }, false, credentials);
    expect(out.max_tokens).toBe(1234);
    expect(out.user_prompt).toBeUndefined();
  });

  it("signs the exact bytes of the body it is handed", () => {
    const body = { model: "GLM-5.2", messages: [{ role: "user", content: "x" }] };
    const headers = exec.buildHeaders(credentials, true, URL_INFERENCE, "GLM-5.2", body);
    expect(headers.Authorization).toBeDefined();
    expect(headers.accept).toBe("text/event-stream");
    expect(headers["x-ot-client-type"]).toBe("CLI");
    // Non-stream requests must not claim to accept SSE.
    const plain = exec.buildHeaders(credentials, false, URL_INFERENCE, "GLM-5.2", body);
    expect(plain.accept).toBeUndefined();

    // Recompute the signature over the same inputs and compare.
    const replayed = signHuaweiRequest({
      accessKeyId: "AK", secretAccessKey: "SK", securityToken: "ST",
      method: "POST", url: URL_INFERENCE, body: JSON.stringify(body),
      headers: Object.fromEntries(Object.entries(headers).filter(([k]) => k.toLowerCase() !== "authorization")),
      date: new Date(headers["x-sdk-date"].replace(/^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z$/, "$1-$2-$3T$4:$5:$6Z")),
    });
    expect(replayed.Authorization).toBe(headers.Authorization);
  });

  it("sends exactly the headers it signed — the transport rewrites none of them", async () => {
    // The gateway recomputes the signature over the declared SignedHeaders, so a
    // fetch layer that dropped or rewrote one of them (`host` is the tempting
    // one) would come back as an unexplainable 403.
    const echo = await startEchoServer();
    try {
      const body = { model: "GLM-5.2", messages: [{ role: "user", content: "hi" }] };
      const headers = exec.buildHeaders(credentials, true, echo.url, "GLM-5.2", body);
      await fetch(echo.url, { method: "POST", headers, body: JSON.stringify(body) });
      const wire = echo.seen[0];

      const signed = headers.Authorization.match(/SignedHeaders=([^,]+)/)[1].split(";");
      expect(signed.length).toBeGreaterThan(8);
      expect(Object.fromEntries(signed.map((n) => [n, wire[n]])))
        .toEqual(Object.fromEntries(signed.map((n) => [n, headers[n]])));
    } finally {
      await echo.close();
    }
  });

  it("reuses one session id per conversation — the gateway counts those", async () => {
    // "并发会话数已达上限(3个)" (HTTP 400 TM.00001041): the snap gateway keys its
    // concurrent-session quota on user-session-id, and the CLI's own traffic
    // reuses one ses_… id across a whole conversation. A fresh id per request
    // means every turn of every chat opens a new counted session.
    const echo = await startEchoServer();
    // runtimeTransport is the only hook buildUrl honours, which keeps execute()
    // on the loopback server instead of the real gateway.
    const local = { ...credentials, runtimeTransport: { baseUrl: echo.url } };
    const turn = (session) => exec.execute({
      model: "GLM-5.2",
      body: { model: "GLM-5.2", messages: [{ role: "user", content: "hi" }] },
      stream: true,
      credentials: local,
      providerSessionId: session,
    });
    try {
      await turn("claude:11111111-1111-1111-1111-111111111111");
      await turn("claude:11111111-1111-1111-1111-111111111111");
      await turn("claude:22222222-2222-2222-2222-222222222222");
      await turn(null);
      const [a, b, c, d] = echo.seen;

      expect(a["user-session-id"]).toMatch(/^ses_[0-9a-f]{26}$/);
      expect(b["user-session-id"]).toBe(a["user-session-id"]);
      expect(c["user-session-id"]).not.toBe(a["user-session-id"]);
      // The CLI carries the same value in both session headers on a primary run.
      expect(a["x-ot-session-id"]).toBe(a["user-session-id"]);
      expect(a["x-ot-parent-session-id"]).toBe("");
      // ...while the tracing ids stay per call, so a stream is never reused.
      expect(b["x-ot-trace-id"]).not.toBe(a["x-ot-trace-id"]);
      expect(b["x-ot-span-id"]).not.toBe(a["x-ot-span-id"]);
      // Requests outside a conversation (probes) share the CLI's silent bucket
      // rather than opening a session of their own.
      expect(d["user-session-id"]).toBe("ses_silent");
    } finally {
      await echo.close();
    }
  });

  it("strips client thinking knobs and clamps output to the model ceiling", () => {
    const body = { thinking: { type: "enabled" }, reasoning_effort: "high", max_tokens: 999999 };
    stripUnsupportedParams("codearts", "GLM-5.2", body);
    expect(body.thinking).toBeUndefined();
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.max_tokens).toBeGreaterThan(0);
    expect(body.max_tokens).toBeLessThanOrEqual(getCapabilitiesForModel("codearts", "GLM-5.2").maxOutput);
  });

  it("reports no thinking control for a lane that deletes every thinking param", () => {
    // The picker and the request log consult this. Without it the lane can claim
    // a level it never sends: providerThinking.codearts was {mode:"high"},
    // chatCore injected reasoning_effort, the log printed THINK:high, and this
    // rule deleted the field before the body was signed.
    expect(stripsThinkingParams("codearts", "GLM-5.2")).toBe(true);
    expect(stripsThinkingParams("codearts", "speed")).toBe(true);
    // A provider that takes thinking keeps its levels.
    expect(stripsThinkingParams("claude", "claude-opus-5-5")).toBe(false);
    // So does one whose strip rule covers only some params.
    expect(stripsThinkingParams("github", "gpt-5.4")).toBe(false);
    // An empty provider must not match every provider-scoped rule at once.
    expect(stripsThinkingParams("", "GLM-5.2")).toBe(false);
  });

  it("leaves the provider page with no thinking level to offer", () => {
    // Mirrors `providerThinkingLevels` in the provider page: that dropdown
    // renders only when the union is non-empty, so an empty union here is what
    // hides it — and `resolveThinkingSuffix`, which builds the "(high)" copied
    // model name, bails on the same predicate.
    const ids = [...PROVIDER_MODELS.ca.map((m) => m.id), "speed", "glm-5.3", "kimi-k3", "deepseek-v4.1-flash"];
    const levels = new Set();
    for (const id of ids) {
      if (stripsThinkingParams("codearts", id)) continue;
      const lv = getThinkingLevels("codearts", id);
      if (lv) lv.forEach((l) => { if (l !== "none") levels.add(l); });
    }
    expect(levels.size).toBe(0);
    // The ids do carry levels when the predicate is not consulted, so the
    // emptiness comes from the strip rule rather than a broken level lookup.
    expect(getThinkingLevels("codearts", "GLM-5.2")).toContain("high");
  });
});

describe("CodeArts gateway refusals (session cap + model queue)", () => {
  const exec = getExecutor("codearts");
  const credentials = {
    accessToken: "ST",
    providerSpecificData: { accessKeyId: "AK", secretAccessKey: "SK", securityToken: "ST" },
  };
  // Verbatim shape of what the gateway answers when all 3 sessions are taken.
  const CAP_BODY = '{"error":{"message":"[400]: {\\"error_code\\":\\"TM.00001041\\",\\"error_msg\\":\\"并发会话数已达上限(3个)，请关闭部分会话后重试。\\"}","type":"invalid_request_error","code":"bad_request"}}';

  // One server plays the whole snap gateway: it answers chat requests and
  // records every path hit, so a test can prove the queue API stays untouched.
  async function startGateway({ chat }) {
    const chats = [];
    const paths = [];
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        paths.push(req.url);
        const request = { headers: req.headers, body: Buffer.concat(chunks).toString() };
        const answer = chat(chats.length, request);
        chats.push(request);
        res.writeHead(answer.status, { "Content-Type": "application/json", ...(answer.headers || {}) });
        res.end(answer.body);
      });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return {
      chats,
      paths,
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      close: () => new Promise((resolve) => server.close(resolve)),
    };
  }

  const OK_BODY = '{"choices":[{"message":{"role":"assistant","content":"ok"}}]}';
  const call = (baseUrl) => exec.execute({
    model: "codearts/GLM-5.2",
    body: { model: "GLM-5.2", messages: [{ role: "user", content: "hi" }] },
    stream: true,
    credentials: { ...credentials, runtimeTransport: { baseUrl: `${baseUrl}/api/v2/chat/completions` } },
    providerSessionId: "claude:11111111-1111-1111-1111-111111111111",
  });

  it("recognises the rejection only in the nested error string", () => {
    expect(isSessionCapExceeded(CAP_BODY)).toBe(true);
    expect(isSessionCapExceeded('{"error":{"message":"max_tokens is too large"}}')).toBe(false);
    expect(isSessionCapExceeded(undefined)).toBe(false);
  });

  it("resends the chat until the gateway frees a slot, on the same session id", async () => {
    const gw = await startGateway({
      chat: (n) => (n === 0
        ? { status: 400, body: CAP_BODY }
        : { status: 200, body: OK_BODY }),
    });
    try {
      const result = await call(gw.baseUrl);
      expect(result.response.status).toBe(200);
      expect(await result.response.json()).toMatchObject({ choices: [{}] });

      expect(gw.chats.length).toBe(2);
      // The resend is the same conversation, not a fresh session.
      expect(gw.chats[1].headers["user-session-id"]).toBe(gw.chats[0].headers["user-session-id"]);
      // The queue API is never consulted: it answers "working" for any task_id,
      // so it reports nothing about capacity, and every GET it receives
      // registers a row that only a DELETE clears.
      expect(gw.paths).toEqual(["/api/v2/chat/completions", "/api/v2/chat/completions"]);
    } finally {
      await gw.close();
    }
  });

  it("leaves an unrelated 400 alone", async () => {
    const gw = await startGateway({ chat: () => ({ status: 400, body: '{"error":{"message":"boom"}}' }) });
    try {
      const result = await call(gw.baseUrl);
      expect(result.response.status).toBe(400);
      expect(await result.response.text()).toBe('{"error":{"message":"boom"}}');
      expect(gw.chats.length).toBe(1);
    } finally {
      await gw.close();
    }
  });

  it("resends a queued turn after the gateway's own Retry-After", async () => {
    // 429 + `queue-status: queued` is how the gateway says "the model is busy"
    // for every enable_queue model; the CLI waits and re-POSTs, so the client
    // must not see a bare 429 the way it would with a straight passthrough.
    const gw = await startGateway({
      chat: (n) => (n === 0
        ? { status: 429, headers: { "queue-status": "Queued", "retry-after": "1" }, body: '{"error":{"message":"queued"}}' }
        : { status: 200, body: OK_BODY }),
    });
    try {
      const t0 = Date.now();
      const result = await call(gw.baseUrl);
      expect(result.response.status).toBe(200);
      expect(gw.chats.length).toBe(2);
      expect(Date.now() - t0).toBeGreaterThanOrEqual(1000);
      expect(gw.chats[1].headers["user-session-id"]).toBe(gw.chats[0].headers["user-session-id"]);
    } finally {
      await gw.close();
    }
  });

  it("passes through a 429 that is not a queue signal", async () => {
    const gw = await startGateway({ chat: () => ({ status: 429, body: '{"error":{"message":"rate limited"}}' }) });
    try {
      const result = await call(gw.baseUrl);
      expect(result.response.status).toBe(429);
      expect(await result.response.text()).toBe('{"error":{"message":"rate limited"}}');
      expect(gw.chats.length).toBe(1);
    } finally {
      await gw.close();
    }
  });

  // Live shape, measured 2026-11-07 on `ca/GLM-5.2`: the signature was accepted
  // and the gateway refused for lack of entitlement, naming the models the
  // account can still use.
  const ENTITLEMENT_BODY = '{"error_code":"TM.000010051","error_msg":"多模态功能或当前所选模型的使用权益已耗尽，可选择如下模型: [GLM-5.2-ArkTS-SPARK, OpenPangu-2.0-Pro, OpenPangu-2.0-Flash]。"}';

  it("recognises the entitlement refusal in the gateway body", () => {
    expect(isEntitlementExhausted(ENTITLEMENT_BODY)).toBe(true);
    expect(isEntitlementExhausted('{"error_msg":"signature do not match"}')).toBe(false);
    expect(isEntitlementExhausted(undefined)).toBe(false);
  });

  it("marks an entitlement 403 so a healthy token is not rotated for it", async () => {
    const gw = await startGateway({ chat: () => ({ status: 403, body: ENTITLEMENT_BODY }) });
    try {
      const result = await call(gw.baseUrl);
      expect(result.response.status).toBe(403);
      // chatCore refreshes on 401/403 unless the response carries this marker.
      // Rotating here would burn an STS round trip, invalidate the refresh token
      // the login handed us, and still be told the entitlement is gone.
      expect(result.response.headers.get("x-auth-refresh-skip")).toBe("1");
      expect(await result.response.json()).toMatchObject({ error_code: "TM.000010051" });
      // Not a refusal either: one chat, no resend window.
      expect(gw.chats.length).toBe(1);
    } finally {
      await gw.close();
    }
  });

  it("does not mark a 403 that really is an auth failure", async () => {
    const gw = await startGateway({ chat: () => ({ status: 403, body: '{"error_msg":"signature do not match"}' }) });
    try {
      const result = await call(gw.baseUrl);
      expect(result.response.status).toBe(403);
      expect(result.response.headers.get("x-auth-refresh-skip")).toBeNull();
      // The body was still drained and replayed, so chatCore can read it.
      expect(await result.response.text()).toContain("signature do not match");
    } finally {
      await gw.close();
    }
  });

  it("reads the queue headers case-insensitively and defaults the wait", () => {
    const headers = (entries) => ({ get: (k) => entries[String(k).toLowerCase()] ?? null });
    expect(isModelQueued({ headers: headers({ "queue-status": "QUEUED" }) })).toBe(true);
    expect(isModelQueued({ headers: headers({ "queue-status": "working" }) })).toBe(false);
    expect(isModelQueued({ headers: headers({}) })).toBe(false);
    expect(queueRetryDelayMs({ headers: headers({ "retry-after": "3" }) })).toBe(3000);
    expect(queueRetryDelayMs({ headers: headers({ "retry-after": "0" }) })).toBe(5000);
    expect(queueRetryDelayMs({ headers: headers({}) })).toBe(5000);
  });

  it("hands the rejection back once the wait window closes", async () => {
    let attempts = 0;
    const result = await sendUntilAdmitted({
      attempt: (round) => ({ retryInMs: round === 0 ? 5 : 100, result: `attempt ${++attempts}` }),
      model: "GLM-5.2",
      budgetMs: 30,
      nap: async () => {},
    });
    // One resend still fits in the window, the next would not — the client gets
    // the upstream rejection instead of an indefinitely held request.
    expect(result).toBe("attempt 2");
    expect(attempts).toBe(2);
  });

  it("stops waiting when the client goes away", async () => {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 10);
    await expect(sleep(5000, ctrl.signal)).rejects.toMatchObject({ name: "AbortError" });
    // Already aborted → no timer to wait out.
    await expect(sleep(5, ctrl.signal)).rejects.toMatchObject({ name: "AbortError" });
  });

  it("backs off between resends without stampeding", () => {
    expect(capRetryDelayMs(0)).toBeGreaterThanOrEqual(2000);
    expect(capRetryDelayMs(0)).toBeLessThan(2500);
    expect(capRetryDelayMs(5)).toBeLessThanOrEqual(10000);
    // Jitter keeps parallel conversations from retrying in lockstep.
    expect(new Set(Array.from({ length: 20 }, () => capRetryDelayMs(2))).size).toBeGreaterThan(1);
  });
});

describe("CodeArts non-streaming answer", () => {
  const exec = getExecutor("codearts");
  const credentials = {
    accessToken: "ST",
    providerSpecificData: { accessKeyId: "AK", secretAccessKey: "SK", securityToken: "ST" },
  };

  it("tells the gateway the client did not ask for a stream", () => {
    // The translator drops `stream` from an OpenAI-shaped body, and this gateway
    // reads an absent flag as "stream anyway": measured 2026-11-08, the same body
    // without `stream` answers text/event-stream, `stream:false` answers
    // application/json. The SSE answer arrives as ONE frame holding a complete
    // `choices[0].message`, which the delta-only reader turned into `content: ""`
    // — a 200 with no answer, usage and finish_reason intact.
    const out = exec.transformRequest("openpangu-2.0-flash", {
      model: "openpangu-2.0-flash", messages: [{ role: "user", content: "hi" }],
    }, false, credentials);
    expect(out.stream).toBe(false);

    // A streaming client is left exactly as it was — that path already worked.
    const streamed = exec.transformRequest("openpangu-2.0-flash", {
      model: "openpangu-2.0-flash", messages: [{ role: "user", content: "hi" }],
    }, true, credentials);
    expect(streamed.stream).toBeUndefined();
  });

  it("reads a complete-message frame, not only deltas", () => {
    const frame = 'data:{"id":"1","object":"chat.completion","created":1,"model":"openpangu-2.0-flash",'
      + '"choices":[{"index":0,"message":{"role":"assistant","content":"the haiku","reasoning_content":"thought"}}],'
      + '"usage":{"prompt_tokens":26,"completion_tokens":3,"total_tokens":29}}\n\ndata: [DONE]\n\n';
    const parsed = parseSSEToOpenAIResponse(frame, "openpangu-2.0-flash");
    expect(parsed.choices[0].message.content).toBe("the haiku");
    expect(parsed.choices[0].message.reasoning_content).toBe("thought");
    expect(parsed.usage.completion_tokens).toBe(3);

    // Deltas still take precedence when a lane really did stream.
    const deltas = 'data:{"choices":[{"index":0,"delta":{"content":"a"}}]}\n\n'
      + 'data:{"choices":[{"index":0,"delta":{"content":"b"},"finish_reason":"stop"}]}\n\n';
    expect(parseSSEToOpenAIResponse(deltas, "m").choices[0].message.content).toBe("ab");
  });
});

describe("CodeArts agent catalog", () => {
  const credentials = {
    accessToken: "ST",
    providerSpecificData: { accessKeyId: "AK", secretAccessKey: "SK", securityToken: "ST" },
  };

  it("routes on model_parameters.model_id and keeps model_name as display", () => {
    const mapped = mapCodeartsModel({
      model_name: "OpenPangu-2.0-Pro",
      model_parameters: { model_id: "openpangu-2.0-pro", context_window: 524288, max_tokens: 131072 },
    });
    expect(mapped).toMatchObject({ id: "openpangu-2.0-pro", name: "OpenPangu-2.0-Pro", contextLength: 524288, maxOutputTokens: 131072 });

    // Older payloads without model_parameters still resolve via model_name.
    expect(mapCodeartsModel({ model_name: "GLM-5.2" })).toMatchObject({ id: "GLM-5.2" });
    expect(mapCodeartsModel({})).toBeNull();
    expect(mapCodeartsModel({ model_name: "VL", model_parameters: { supports_images: true } }))
      .toMatchObject({ id: "VL", capabilities: { vision: true } });
  });

  // A signed GET the gateway either accepts or 400s — assert the exact wire
  // shape once on a loopback server instead of hitting Huawei per test run.
  async function startCatalogServer(payload, acceptAccessKeyId = null) {
    const seen = [];
    const server = http.createServer((req, res) => {
      seen.push(req.headers);
      if (acceptAccessKeyId && !String(req.headers.authorization || "").includes(`Access=${acceptAccessKeyId}`)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error_msg: "signature do not match" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return {
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      seen,
      close: () => new Promise((resolve) => server.close(resolve)),
    };
  }

  const CATALOG_PAYLOAD = {
    gpts: {
      models: [
        { model_name: "GLM-5.2", model_parameters: { model_id: "GLM-5.2", context_window: 202752, max_tokens: 131072 } },
        { model_name: "OpenPangu-2.0-Pro", model_parameters: { model_id: "openpangu-2.0-pro", context_window: 524288, max_tokens: 131072 } },
      ],
    },
  };

  it("publishes the catalog numbers to the routing layer, not only to the UI", async () => {
    // The defect this closes: `mapCodeartsModel` numbers reached the dashboard
    // while getCapabilitiesForModel kept guessing from the model name, so
    // `ca/deepseek-v4.1-flash` routed on a 384,000 output ceiling and `ca/speed`
    // on 200,000 context with reasoning:false — all three wrong against a table
    // that says 65,536 output, 1,048,576 context and thinking always on.
    const payload = {
      gpts: {
        models: [
          { model_name: "GLM-5.2", model_parameters: { model_id: "GLM-5.2", context_window: 202752, max_tokens: 65536, supports_images: false } },
          { model_name: "Speed", model_parameters: { model_id: "speed", context_window: 1048576, max_tokens: 65536, supports_images: false } },
        ],
      },
    };
    const srv = await startCatalogServer(payload);
    const creds = { providerSpecificData: { ...credentials.providerSpecificData, accessKeyId: `TESTAK-OVERLAY${Date.now()}` } };
    try {
      await resolveCodeartsModels(creds, { baseUrl: srv.baseUrl, forceRefresh: true });

      // A curated id keeps its window and gains the published output ceiling.
      expect(getCapabilitiesForModel("codearts", "GLM-5.2")).toMatchObject({ contextWindow: 202752, maxOutput: 65536 });
      // An id the static registry never carried routes on the catalog too.
      expect(getCapabilitiesForModel("codearts", "speed")).toMatchObject({ contextWindow: 1048576, maxOutput: 65536, reasoning: true });
      // supports_images:false is the gateway's own answer, so it is published
      // rather than left to the name heuristic.
      expect(getCapabilitiesForModel("codearts", "speed").vision).toBe(false);
    } finally {
      clearLiveCapabilities("codearts");
      await srv.close();
    }
  });

  it("leaves the static tables in charge when the catalog answers nothing", async () => {
    const srv = await startCatalogServer({ gpts: { models: [] } });
    const creds = { providerSpecificData: { ...credentials.providerSpecificData, accessKeyId: `TESTAK-EMPTY${Date.now()}` } };
    try {
      expect(await resolveCodeartsModels(creds, { baseUrl: srv.baseUrl, forceRefresh: true })).toBeNull();
      expect(getCapabilitiesForModel("codearts", "GLM-5.2").maxOutput).toBe(65536);
    } finally {
      await srv.close();
    }
  });

  it("fetches the catalog signed with the headers the gateway demands, and caches", async () => {
    const srv = await startCatalogServer(CATALOG_PAYLOAD);
    // accessKeyId-keyed cache: pick an id no other test could have seeded.
    const creds = { providerSpecificData: { ...credentials.providerSpecificData, accessKeyId: `TESTAK${Date.now()}` } };
    try {
      const first = await resolveCodeartsModels(creds, { baseUrl: srv.baseUrl, forceRefresh: true });
      expect(first.models.map((m) => m.id)).toEqual(["GLM-5.2", "openpangu-2.0-pro"]);

      const headers = srv.seen[0];
      expect(String(headers.authorization)).toMatch(/^SDK-HMAC-SHA256 Access=TESTAK/);
      expect(headers["x-security-token"]).toBe("ST");
      // Missing/misspelled X-Language makes the whole control plane 400
      // ("X-Language is validate failed") and silently degrades to static.
      expect(headers["x-language"]).toBe("zh-cn");
      expect(headers["agent-type"]).toBe("AgentCenter");

      // Second call rides the 10-minute cache instead of re-fetching.
      const cached = await resolveCodeartsModels(creds, { baseUrl: srv.baseUrl });
      expect(cached).toBe(first);
      expect(srv.seen.length).toBe(1);
    } finally {
      await srv.close();
    }
  });

  it("returns null (caller falls back to static) for an account with no catalog", async () => {
    const srv = await startCatalogServer({ gpts: {} });
    const creds = { providerSpecificData: { ...credentials.providerSpecificData, accessKeyId: `TESTAK${Date.now()}x` } };
    try {
      expect(await resolveCodeartsModels(creds, { baseUrl: srv.baseUrl, forceRefresh: true })).toBeNull();
    } finally {
      await srv.close();
    }
  });

  it("refuses to sign a request without the temporary AK/SK", () => {
    expect(() => codeartsKeys({ providerSpecificData: {} })).toThrow(/AK\/SK/);
  });

  // The stored AK/SK is a temporary STS credential that rotates hourly, and the
  // dashboard lists models long before any chat. Signing with a dead pair costs
  // a rejected round trip on EVERY /v1/models call and logs it forever, because
  // a connection that is only listed never reaches the executor's refresh.
  describe("catalog credential renewal", () => {
    beforeEach(() => vi.mocked(refreshCodeartsFromCredentials).mockClear());

    const oldAk = () => `TESTAKOLD${Date.now()}${Math.floor(Math.random() * 1e4)}`;
    const newAk = () => `TESTAKNEW${Date.now()}${Math.floor(Math.random() * 1e4)}`;
    const expiredCreds = (accessKeyId) => ({
      id: "conn-1",
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
      providerSpecificData: { accessKeyId, secretAccessKey: "SK", securityToken: "ST" },
    });
    const renewedPatch = (accessKeyId) => ({
      accessToken: "ST-new",
      expiresIn: 3600,
      providerSpecificData: { accessKeyId, secretAccessKey: "SK-new", securityToken: "ST-new" },
    });

    it("renews an expired AK/SK and signs the catalog with the new pair", async () => {
      const nextAk = newAk();
      const srv = await startCatalogServer(CATALOG_PAYLOAD, nextAk);
      const persisted = [];
      try {
        vi.mocked(refreshCodeartsFromCredentials).mockResolvedValueOnce(renewedPatch(nextAk));
        const result = await resolveCodeartsModels(expiredCreds(oldAk()), {
          baseUrl: srv.baseUrl,
          onCredentialsRefreshed: (patch) => { persisted.push(patch); },
        });

        expect(result.models.map((m) => m.id)).toEqual(["GLM-5.2", "openpangu-2.0-pro"]);
        // One request only, and it carried the RENEWED key — the dead pair was
        // never spent on a call that had to be rejected.
        expect(srv.seen).toHaveLength(1);
        expect(String(srv.seen[0].authorization)).toContain(`Access=${nextAk}`);
        expect(persisted).toHaveLength(1);
        expect(persisted[0].providerSpecificData.accessKeyId).toBe(nextAk);
        expect(persisted[0].existingProviderSpecificData.secretAccessKey).toBe("SK");
      } finally {
        await srv.close();
      }
    });

    it("reports no live catalog without spending a request when renewal is impossible", async () => {
      const deadAk = oldAk();
      const srv = await startCatalogServer(CATALOG_PAYLOAD, "never-used");
      try {
        vi.mocked(refreshCodeartsFromCredentials).mockResolvedValueOnce({ error: "invalid_grant", message: "CodeArts refresh token missing — reconnect the account" });
        expect(await resolveCodeartsModels(expiredCreds(deadAk), { baseUrl: srv.baseUrl })).toBeNull();
        expect(srv.seen).toHaveLength(0);

        // Backoff: the same dead grant must not be re-attempted (and re-logged)
        // on the next listing.
        expect(await resolveCodeartsModels(expiredCreds(deadAk), { baseUrl: srv.baseUrl })).toBeNull();
        expect(vi.mocked(refreshCodeartsFromCredentials)).toHaveBeenCalledTimes(1);
      } finally {
        await srv.close();
      }
    });

    it("renews once and replays when the gateway rejects the stored pair", async () => {
      const staleAk = oldAk();
      const nextAk = `TESTAK401${Date.now()}`;
      const srv = await startCatalogServer(CATALOG_PAYLOAD, nextAk);
      try {
        vi.mocked(refreshCodeartsFromCredentials).mockResolvedValueOnce(renewedPatch(nextAk));
        const creds = { id: "conn-2", expiresAt: new Date(Date.now() + 3600_000).toISOString(), providerSpecificData: { accessKeyId: staleAk, secretAccessKey: "SK", securityToken: "ST" } };
        const result = await resolveCodeartsModels(creds, { baseUrl: srv.baseUrl });

        expect(result.models).toHaveLength(2);
        expect(srv.seen).toHaveLength(2);
        expect(String(srv.seen[0].authorization)).toContain(`Access=${staleAk}`);
        expect(String(srv.seen[1].authorization)).toContain(`Access=${nextAk}`);

        // The replayed catalog is cached under the RENEWED key, so the next
        // listing (reading the persisted pair) does not fetch again.
        const renewed = { id: "conn-2", expiresAt: new Date(Date.now() + 3600_000).toISOString(), providerSpecificData: { accessKeyId: nextAk, secretAccessKey: "SK-new", securityToken: "ST-new" } };
        expect((await resolveCodeartsModels(renewed, { baseUrl: srv.baseUrl })).models).toHaveLength(2);
        expect(srv.seen).toHaveLength(2);
      } finally {
        await srv.close();
      }
    });
  });
});

describe("CodeArts login crypto", () => {
  it("authorize URL matches the CLI parameter spelling", () => {
    // Login derives the challenge from its verifier; mirror that here so the
    // URL assertion pins the portal's parameter names, not the derivation.
    const codeVerifier = "v".repeat(128);
    const url = new URL(buildAuthorizeUrl({
      redirectUri: "http://127.0.0.1:43123/oauth/callback",
      codeChallenge: crypto.createHash("sha256").update(codeVerifier).digest("base64url"),
      ticketId: "t".repeat(64),
    }));
    expect(url.origin + url.pathname).toBe("https://codearts.huaweicloud.com/portal/authorize");
    expect(url.searchParams.get("client_id")).toBe("CodeArts_Tui");
    expect(url.searchParams.get("port")).toBe("43123");
    expect(url.searchParams.get("code_challenge_method")).toBe("SHA-256");
    expect(url.searchParams.get("code_challenge")).toHaveLength(43);
    expect(url.searchParams.get("code_challenge")).not.toContain("=");
    expect(url.searchParams.get("ticket_id")).toHaveLength(64);
  });

  it("DPoP proof is an ES256 JWT bound to method + URL and verifies against its own key", () => {
    const keyPair = createDpopKeyPair();
    const proof = buildDpopProof(keyPair, "post", "https://sts.cn-north-4.myhuaweicloud.com/v1/oauth2/tokens", 1700000000);
    const [headerB64, payloadB64, sigB64] = proof.split(".");
    const header = JSON.parse(Buffer.from(headerB64, "base64url").toString());
    const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString());

    expect(header).toMatchObject({ alg: "ES256", typ: "dpop+jwt" });
    expect(header.jwk.x).toBe(keyPair.publicKeyJwk.x);
    expect(payload).toMatchObject({ htm: "POST", htu: "https://sts.cn-north-4.myhuaweicloud.com/v1/oauth2/tokens", iat: 1700000000 });
    expect(payload.jti).toHaveLength(32);

    const publicKey = crypto.createPublicKey({ key: keyPair.publicKeyJwk, format: "jwk" });
    expect(crypto.verify("sha256", Buffer.from(`${headerB64}.${payloadB64}`), { key: publicKey, dsaEncoding: "ieee-p1363" },
      Buffer.from(sigB64, "base64url"))).toBe(true);
  });

  it("refuses to sign without a key pair instead of sending a broken proof", () => {
    expect(() => buildDpopProof(null, "POST", "https://x")).toThrow(/DPoP key pair/);
  });

  it("normalizes the STS credential payload and round-trips through the store", () => {
    const keyPair = createDpopKeyPair();
    const creds = normalizeTokenResponse({
      credentials: {
        access_key_id: "AK", secret_access_key: "SK", security_token: "ST",
        expiration: "2026-09-20T10:00:00Z",
      },
      refresh_token: "RT",
    }, keyPair);
    expect(creds.expiresAt).toBe(Date.parse("2026-09-20T10:00:00Z"));

    const patch = toCodeartsCredentialPatch({ ...creds, accountId: "acct" });
    expect(patch.accessToken).toBe("ST");
    expect(patch.providerSpecificData).toMatchObject({ accessKeyId: "AK", secretAccessKey: "SK", securityToken: "ST", accountId: "acct", authMethod: "oauth" });
    expect(patch.expiresIn).toBeGreaterThanOrEqual(60);

    const back = credentialsFromStore({ accessToken: patch.accessToken, refreshToken: patch.refreshToken, providerSpecificData: patch.providerSpecificData });
    expect(back).toMatchObject({ accessKeyId: "AK", secretAccessKey: "SK", securityToken: "ST", refreshToken: "RT", accountId: "acct" });
    expect(back.dpopKeyPair.privateKeyJwk.crv).toBe("P-256");
  });

  it("treats a missing refresh token or DPoP key as a dead grant", async () => {
    expect(await refreshCodeartsFromCredentials({ providerSpecificData: { accessKeyId: "A", secretAccessKey: "B" } }))
      .toMatchObject({ error: "invalid_grant" });
    expect(await refreshCodeartsFromCredentials({ refreshToken: "RT", providerSpecificData: {} }))
      .toMatchObject({ error: "invalid_grant" });
  });
});

describe("CodeartsExecutor refresh (401 path)", () => {
  it("forwards the caller's proxyOptions and keeps the connection's providerSpecificData", async () => {
    const exec = getExecutor("codearts");
    const credentials = {
      connectionId: "conn-refresh-merge",
      refreshToken: "RT",
      providerSpecificData: {
        accessKeyId: "AK", secretAccessKey: "SK", securityToken: "ST",
        // Refresh never returns these — they must survive chatCore's
        // Object.assign(credentials, patch) for the rest of the request.
        connectionProxyEnabled: true,
        connectionProxyUrl: "http://127.0.0.1:7890",
        userId: "u-1",
      },
    };
    const proxyOptions = { connectionProxyEnabled: true, connectionProxyUrl: "http://127.0.0.1:7890" };
    vi.mocked(refreshCodeartsFromCredentials).mockResolvedValueOnce({
      accessToken: "ST2",
      refreshToken: "RT2",
      expiresIn: 3500,
      providerSpecificData: {
        authMethod: "oauth",
        accessKeyId: "AK2", secretAccessKey: "SK2", securityToken: "ST2",
        accountId: "{}", dpopKeyPair: { privateKeyJwk: {}, publicKeyJwk: {} },
        tokenExpiresAt: new Date(Date.now() + 3500_000).toISOString(),
      },
    });

    const patch = await exec.refreshCredentials(credentials, null, proxyOptions);

    expect(vi.mocked(refreshCodeartsFromCredentials)).toHaveBeenCalledWith(
      credentials,
      expect.objectContaining({ proxyOptions }),
    );
    expect(patch.providerSpecificData).toMatchObject({
      accessKeyId: "AK2", // refreshed values win
      connectionProxyEnabled: true, // connection fields survive the merge
      connectionProxyUrl: "http://127.0.0.1:7890",
      userId: "u-1",
    });
  });
});

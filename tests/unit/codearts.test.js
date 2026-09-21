// 华为云码道 (CodeArts): every snap-access call is signed with Huawei's
// SDK-HMAC-SHA256 over the temporary AK/SK minted by the DPoP login, so the
// wiring has to hold together without a bearer token anywhere.
import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import http from "node:http";

import { PROVIDERS, PROVIDER_MODELS, PROVIDER_OAUTH } from "open-sse/providers/index.js";
import { getCapabilitiesForModel } from "open-sse/providers/capabilities.js";
import { getExecutor } from "open-sse/executors/index.js";
import { stripUnsupportedParams } from "open-sse/translator/concerns/paramSupport.js";
import { canonicalUri, canonicalQuery, formatSdkDate, signHuaweiRequest, uriEncode } from "open-sse/shared/codearts/signer.js";
import { capRetryDelayMs, isSessionCapExceeded, sendUntilSessionSlot, sleep } from "open-sse/shared/codearts/sessionCap.js";
import {
  buildAuthorizeUrl,
  buildDpopProof,
  createDpopKeyPair,
  credentialsFromStore,
  normalizeTokenResponse,
  refreshCodeartsFromCredentials,
  toCodeartsCredentialPatch,
} from "open-sse/shared/codearts/auth.js";

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
    }
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
    expect(out.max_tokens).toBe(32000);
    expect(out.user_prompt).toBe("hi there  ");
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
});

describe("CodeArts concurrent-session cap", () => {
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
        res.writeHead(answer.status, { "Content-Type": "application/json" });
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

  it("hands the rejection back once the wait window closes", async () => {
    let attempts = 0;
    const result = await sendUntilSessionSlot({
      attempt: async () => ({ capped: true, result: `attempt ${++attempts}` }),
      model: "GLM-5.2",
      budgetMs: 30,
      delayFor: (round) => (round === 0 ? 5 : 100),
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

// JoyAgent (京东) lane — registry/executor unit coverage.
//
// Wire facts and their evidence live in open-sse/providers/registry/joyagent.js
// and open-sse/executors/joyagent.js; this file pins the behaviour those
// comments promise so a refactor cannot quietly break the protocol.
import { describe, expect, it, vi, beforeEach } from "vitest";

// The webIdentity probe reaches the catalog through proxyAwareFetch; mock it so
// no test touches the real upstream.
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(async () => new Response(JSON.stringify({ code: 0, data: { records: [] } }), { status: 200 })),
}));

import REGISTRY from "../../open-sse/providers/registry/index.js";
import { PROVIDERS, PROVIDER_MODELS } from "../../open-sse/providers/index.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { parseModel, resolveProviderAlias } from "../../open-sse/services/model.js";
import { getModelUpstreamId, isValidModel } from "../../open-sse/config/providerModels.js";
import { getExecutor, hasSpecializedExecutor } from "../../open-sse/executors/index.js";
import { parseJoyagentError, JoyagentExecutor } from "../../open-sse/executors/joyagent.js";
import {
  extractJoyagentCookie,
  probeJoyagentCookie,
  JOYAGENT_CHAT_URL,
} from "../../open-sse/shared/joyagent/credentials.js";
import { hasWebIdentityProbe, fetchWebIdentity } from "../../open-sse/services/webIdentity.js";
import { injectReasoningContent } from "../../open-sse/utils/reasoningContentInjector.js";
import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";

const JAR = "thor=ABC123; pin=jd_AcWZTZQJocwB; unick=test; ptKey=jca_testkey; jwaAccessToken=jwa_testtoken";

describe("JoyAgent provider", () => {
  const entry = REGISTRY.find((candidate) => candidate.id === "joyagent");

  it("is registered with aliases that resolve both ways", () => {
    expect(entry).toBeTruthy();
    expect(entry.alias).toBe("ja");
    expect(resolveProviderAlias("ja")).toBe("joyagent");
    expect(resolveProviderAlias("joyagent")).toBe("joyagent");
    expect(resolveProviderAlias("joywork")).toBe("joyagent");
  });

  it("keeps the `jd/` prefix of a slash-bearing model id intact", () => {
    // parseModel splits at the FIRST slash, so the upstream code survives —
    // and it is that exact code the endpoint expects in `model`.
    expect(parseModel("ja/jd/deepseek-v4-pro-0813")).toEqual({
      provider: "joyagent",
      model: "jd/deepseek-v4-pro-0813",
      isAlias: false,
      providerAlias: "ja",
    });
    expect(parseModel("joyagent/GLM-5.3").model).toBe("GLM-5.3");
  });

  it("publishes the openai-u transport, not the ACP sandbox", () => {
    expect(PROVIDERS.joyagent.baseUrl).toBe(JOYAGENT_CHAT_URL);
    expect(PROVIDERS.joyagent.baseUrl).toBe(
      "https://joyagent.jd.com/work/api/v1/models/openai-u/v1/chat/completions",
    );
    expect(PROVIDERS.joyagent.format).toBe("openai");
    expect(PROVIDERS.joyagent.authType).toBe("cookie");
    // validateUrl is probed with `Authorization: Bearer` by the generic
    // validator, which a cookie session answers 401 — liveness belongs to the
    // webIdentity probe instead.
    expect(PROVIDERS.joyagent.validateUrl).toBeUndefined();
    // No forceStream: this endpoint honours stream:false (measured), unlike the
    // ACP runtime which only ever answers SSE.
    expect(PROVIDERS.joyagent.forceStream).toBeFalsy();
    // A stream:false call only gets its headers after the whole answer is
    // generated, so the connect guard IS the generation ceiling: the 60s
    // default would abort long turns and re-bill them 3 more times.
    expect(PROVIDERS.joyagent.timeoutMs).toBe(300000);
    expect(PROVIDERS.joyagent.headers.Origin).toBe("https://joyagent.jd.com");
    expect(PROVIDERS.joyagent.headers.Referer).toBe("https://joyagent.jd.com/app/");
    expect(entry.category).toBe("webCookie");
  });

  it("models the five catalog codes with their declared ceilings", () => {
    const models = PROVIDER_MODELS.ja;
    expect(models.map((m) => m.id)).toEqual([
      "jd/deepseek-v4-pro-0813",
      "kimi-k3",
      "GLM-5.3",
      "MiniMax-M3",
      "Qwen3.5-397B-A17B",
    ]);
    // ids are the catalog `code`; the numeric `id` (24..28) 404s MODEL_NOT_FOUND.
    expect(models.find((m) => m.id === "kimi-k3").contextLength).toBe(2000000);
    expect(models.find((m) => m.id === "GLM-5.3").maxOutputTokens).toBe(4096);
  });

  it("carries a specialized executor and stays routable", () => {
    expect(hasSpecializedExecutor("joyagent")).toBe(true);
    expect(getExecutor("joyagent")).toBeInstanceOf(JoyagentExecutor);
  });

  describe("capabilities (measured 2026-11-06)", () => {
    it("declares no vision anywhere — the endpoint rejects image_url for every model", () => {
      // The name heuristics know "Qwen3.5"/"kimi" families and would switch
      // image input back on; the per-row vision:false is what keeps the promise.
      for (const id of ["jd/deepseek-v4-pro-0813", "kimi-k3", "GLM-5.3", "MiniMax-M3", "Qwen3.5-397B-A17B"]) {
        expect(getCapabilitiesForModel("joyagent", id).vision).toBe(false);
        expect(getCapabilitiesForModel("ja", id).vision).toBe(false);
      }
    });

    it("marks reasoning per model as the wire actually behaved", () => {
      expect(getCapabilitiesForModel("joyagent", "GLM-5.3").reasoning).toBe(true);
      expect(getCapabilitiesForModel("joyagent", "kimi-k3").reasoning).toBe(true);
      expect(getCapabilitiesForModel("joyagent", "MiniMax-M3").reasoning).toBe(true);
      expect(getCapabilitiesForModel("joyagent", "Qwen3.5-397B-A17B").reasoning).toBe(true);
      // DeepSeek-v4-pro answered a 鸡兔同笼 prompt with a full worked solution
      // and reasoning_tokens:0 — it does not think on this gateway.
      expect(getCapabilitiesForModel("joyagent", "jd/deepseek-v4-pro-0813").reasoning).toBe(false);
    });

    it("publishes the gateway's own context numbers", () => {
      expect(getCapabilitiesForModel("joyagent", "kimi-k3").contextWindow).toBe(2000000);
      expect(getCapabilitiesForModel("joyagent", "Qwen3.5-397B-A17B").contextWindow).toBe(100000);
      expect(getCapabilitiesForModel("joyagent", "jd/deepseek-v4-pro-0813").maxOutput).toBe(4096);
      // function calling verified against GLM-5.3 (a real tool_calls round-trip)
      expect(getCapabilitiesForModel("joyagent", "GLM-5.3").tools).toBe(true);
    });
  });
});

describe("JoyAgent credential parsing", () => {
  beforeEach(() => vi.clearAllMocks());

  it("accepts a raw Cookie header verbatim", () => {
    expect(extractJoyagentCookie({ apiKey: JAR })).toBe(JAR);
  });

  it("accepts a DevTools blob with the `Cookie:` prefix", () => {
    expect(extractJoyagentCookie({ apiKey: `Cookie: ${JAR}` })).toBe(JAR);
  });

  it("treats a bare value as ptKey, the one cookie that authenticates alone", () => {
    expect(extractJoyagentCookie({ apiKey: "jca_abc123" })).toBe("ptKey=jca_abc123");
  });

  it("accepts a cookie-editor JSON export", () => {
    const json = JSON.stringify([
      { name: "thor", value: "ABC", domain: ".jd.com" },
      { name: "ptKey", value: "jca_x", domain: "joyagent.jd.com" },
    ]);
    expect(extractJoyagentCookie({ apiKey: json })).toBe("thor=ABC; ptKey=jca_x");
  });

  it("reads the other credential fields the connection repo may use", () => {
    expect(extractJoyagentCookie({ accessToken: JAR })).toBe(JAR);
    expect(extractJoyagentCookie({ providerSpecificData: { cookie: JAR } })).toBe(JAR);
    expect(extractJoyagentCookie({})).toBe("");
    expect(extractJoyagentCookie(null)).toBe("");
  });
});

describe("JoyagentExecutor headers", () => {
  const executor = new JoyagentExecutor();

  it("sends the jar as Cookie and never as a Bearer token", () => {
    const headers = executor.buildHeaders({ apiKey: JAR }, true);
    expect(headers.Cookie).toBe(JAR);
    expect(headers.Authorization).toBeUndefined();
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers.Accept).toBe("text/event-stream");
    expect(headers.Origin).toBe("https://joyagent.jd.com");
  });

  it("keeps the registry fingerprint headers on a non-streaming call", () => {
    const headers = executor.buildHeaders({ apiKey: JAR }, false);
    expect(headers.Accept).toBeUndefined();
    expect(headers["User-Agent"]).toContain("Chrome/");
    expect(headers.Referer).toBe("https://joyagent.jd.com/app/");
  });

  it("resolves the URL from the registry transport", () => {
    expect(executor.buildUrl("GLM-5.3", true)).toBe(JOYAGENT_CHAT_URL);
  });
});

describe("JoyAgent error envelopes", () => {
  it("turns a dead session into an actionable 401", () => {
    const e = parseJoyagentError(401, JSON.stringify({ code: "AUTHENTICATION_REQUIRED", message: "登录已失效，请重新登录" }));
    expect(e.status).toBe(401);
    expect(e.message).toContain("JoyAgent session rejected");
    expect(e.message).toContain("登录已失效，请重新登录");
  });

  it("surfaces the reason hidden inside the model-service envelope", () => {
    const body = JSON.stringify({
      requestId: "1793928044399c75",
      error: {
        code: 400,
        status: "FAILED_RESPONSE",
        message: "模型服务调用失败",
        cause: JSON.stringify({ error: { message: "Bad Request: [message type 'image_url' is not supported]" } }),
      },
    });
    expect(parseJoyagentError(400, body).message).toBe("Bad Request: [message type 'image_url' is not supported]");
  });

  it("keeps MODEL_NOT_FOUND readable", () => {
    const e = parseJoyagentError(404, JSON.stringify({ code: "MODEL_NOT_FOUND", message: "Model does not exist or is unavailable for code=24" }));
    expect(e.message).toContain("code=24");
  });

  it("does not invent a reason for the empty 500 an unknown streamed model gets", () => {
    const e = parseJoyagentError(500, "");
    expect(e.status).toBe(500);
    expect(e.message).toBe("HTTP 500");
  });

  it("passes non-JSON bodies through", () => {
    expect(parseJoyagentError(502, "<html>Bad Gateway</html>").message).toBe("<html>Bad Gateway</html>");
  });
});

describe("JoyAgent probe", () => {
  // Real shape of GET /work/api/v1/gateway/auth/userInfo, captured live.
  const userBody = {
    code: 0,
    message: "success",
    data: { userId: "4131", pin: "jd_AcWZTZQJocwB", displayName: "JoyAgent 默认租户", tenantCode: "default-tenant" },
  };

  const fetcher = (impl) => probeJoyagentCookie(JAR, { fetchImpl: impl });

  it("accepts a live session and returns the account's own pin", async () => {
    const calls = [];
    const res = await fetcher(async (url, opts) => {
      calls.push({ url, cookie: opts.headers.Cookie });
      return { status: 200, ok: true, text: async () => JSON.stringify(userBody) };
    });
    expect(res.ok).toBe(true);
    // The opaque ASCII pin, NOT the percent-encoded `pin` cookie: this value
    // names the web-login connection and is its dedup key.
    expect(res.account).toBe("jd_AcWZTZQJocwB");
    expect(res.displayName).toBe("JoyAgent 默认租户");
    // One request only: a second serial call would double the validation latency.
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe("https://joyagent.jd.com/work/api/v1/gateway/auth/userInfo");
    expect(calls[0].cookie).toBe(JAR);
  });

  it("rejects a dead cookie with the server's own reason", async () => {
    const res = await fetcher(async () => ({
      status: 401,
      ok: false,
      text: async () => JSON.stringify({ code: "AUTHENTICATION_REQUIRED", message: "Work access token required" }),
    }));
    expect(res.ok).toBe(false);
    expect(res.inconclusive).toBeUndefined();
    expect(res.error).toBe("Work access token required");
  });

  it("stays inconclusive on transport trouble so a blip cannot mark a good session dead", async () => {
    const res = await fetcher(async () => ({ status: 503, ok: false, text: async () => "gateway" }));
    expect(res.ok).toBe(false);
    expect(res.inconclusive).toBe(true);

    const thrown = await fetcher(async () => {
      throw new Error("socket hang up");
    });
    expect(thrown.inconclusive).toBe(true);

    const noStatus = await fetcher(async () => ({ status: 0, ok: false, error: "proxy refused", text: async () => "" }));
    expect(noStatus.inconclusive).toBe(true);
    expect(noStatus.error).toBe("proxy refused");
  });

  it("stays inconclusive when the identity shape changes", async () => {
    // A live session always answers its pin, but a JD-side shape change says
    // more about the endpoint than about the credential — never mark it dead.
    const res = await fetcher(async () => ({
      status: 200,
      ok: true,
      text: async () => JSON.stringify({ code: 0, data: null }),
    }));
    expect(res.ok).toBe(false);
    expect(res.inconclusive).toBe(true);
    expect(res.error).toContain("no account pin");
  });

  it("reads an HTTP-200 business failure as a rejection", async () => {
    const res = await fetcher(async () => ({
      status: 200,
      ok: true,
      text: async () => JSON.stringify({ code: "FORBIDDEN_TENANT", message: "tenant not ready" }),
    }));
    expect(res.ok).toBe(false);
    expect(res.error).toBe("tenant not ready");
  });

  it("refuses to probe without a credential", async () => {
    const res = await probeJoyagentCookie("");
    expect(res.ok).toBe(false);
    expect(res.error).toContain("Missing");
  });
});

describe("JoyAgent boundaries", () => {
  it("sends no Cookie and no Authorization when the connection has no credential", () => {
    const headers = new JoyagentExecutor().buildHeaders({}, true);
    expect(headers.Cookie).toBeUndefined();
    expect(headers.Authorization).toBeUndefined();
    // Upstream then answers 401 AUTHENTICATION_REQUIRED, which parseError maps
    // to the "re-paste the Cookie header" message — the failure stays actionable
    // instead of throwing before the request.
    expect(parseJoyagentError(401, '{"code":"AUTHENTICATION_REQUIRED","message":"Work access token required"}').message)
      .toContain("re-paste the Cookie header");
  });

  it("keeps the exact catalog id on the wire (no dot/dash rewriting, no prefix loss)", () => {
    // normalizeModelId's digit-hyphen rule would turn Qwen3.5-397B-A17B into
    // "Qwen3.5.397B-A17B"; it only applies to DOT_VERSION_PROVIDERS, and the
    // gateway matches codes exactly, so a rewrite here would 404 forever.
    for (const id of ["jd/deepseek-v4-pro-0813", "Qwen3.5-397B-A17B", "MiniMax-M3", "GLM-5.3", "kimi-k3"]) {
      expect(getModelUpstreamId("ja", id)).toBe(id);
      expect(isValidModel("ja", id)).toBe(true);
    }
    // Wrong case is not repaired: it is forwarded verbatim and the gateway 404s
    // it. Caps fall through to the name patterns in that case, which is the
    // documented cost of a mistyped model name, not a routing bug.
    expect(isValidModel("ja", "glm-5.3")).toBe(false);
    expect(getModelUpstreamId("ja", "glm-5.3")).toBe("glm-5.3");
  });

  it("surfaces a malformed cookie-editor export instead of silently dropping auth", () => {
    expect(() => extractJoyagentCookie({ apiKey: '[{"name":"thor"}]' })).toThrow(/missing required field 'value'/);
  });

  it("reads a catalog row's name fields without falling back to undefined", () => {
    const row = { code: "kimi-k3", name: "Kimi-k3", displayName: "", contextLength: 2000000, responseTokens: 4096 };
    const mapped = {
      id: row.code,
      name: row.displayName || row.name || row.code,
      contextLength: row.contextLength,
      maxOutputTokens: row.responseTokens,
    };
    expect(mapped.name).toBe("Kimi-k3");
  });

  it("tolerates the shared reasoning_content injector on tool round-trips", () => {
    // DefaultExecutor runs injectReasoningContent over every body, and its
    // name rules fire for two of these five ids. Verified live 2026-11-06: the
    // gateway answers 200 and uses the tool result for all three models, so
    // the extra message-level field is accepted (unlike image_url, which is
    // hard-rejected with 400). Pinned so a change to the injector is noticed.
    const body = {
      model: "x",
      messages: [
        { role: "user", content: "北京天气" },
        { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "get_weather", arguments: "{}" } }] },
      ],
    };
    const injected = (model) => injectReasoningContent({ provider: "joyagent", model, body }).messages[1].reasoning_content;
    expect(injected("jd/deepseek-v4-pro-0813")).toBe(" ");
    expect(injected("kimi-k3")).toBe(" ");
    expect(injected("GLM-5.3")).toBeUndefined();
    expect(injected("Qwen3.5-397B-A17B")).toBeUndefined();
  });
});

describe("JoyAgent webIdentity probe registration", () => {
  beforeEach(() => vi.clearAllMocks());

  it("is registered so the dashboard validates the pasted cookie", async () => {
    expect(hasWebIdentityProbe("joyagent")).toBe(true);
  });

  it("reports valid on a live catalog", async () => {
    proxyAwareFetch.mockImplementation(async () =>
      new Response(JSON.stringify({ code: 0, data: { userId: "4131", pin: "jd_AcWZTZQJocwB", displayName: "JoyAgent 默认租户" } }), { status: 200 }),
    );
    const res = await fetchWebIdentity("joyagent", JAR);
    expect(res.status).toBe("valid");
    expect(res.email).toBe("jd_AcWZTZQJocwB");
  });

  it("reports invalid on 401 and unknown on a network failure", async () => {
    proxyAwareFetch.mockImplementation(async () =>
      new Response(JSON.stringify({ code: "AUTHENTICATION_REQUIRED", message: "登录已失效，请重新登录" }), { status: 401 }),
    );
    expect((await fetchWebIdentity("joyagent", JAR)).status).toBe("invalid");

    proxyAwareFetch.mockImplementation(async () => {
      throw new Error("ECONNREFUSED");
    });
    expect((await fetchWebIdentity("joyagent", JAR)).status).toBe("unknown");
  });

  it("accepts a bare ptKey value as the credential", async () => {
    proxyAwareFetch.mockImplementation(async () =>
      new Response(JSON.stringify({ code: 0, data: { userId: "4131", pin: "jd_AcWZTZQJocwB" } }), { status: 200 }),
    );
    const res = await fetchWebIdentity("joyagent", "jca_abc123");
    expect(res.status).toBe("valid");
    const [, opts] = proxyAwareFetch.mock.calls[0];
    expect(opts.headers.Cookie).toBe("ptKey=jca_abc123");
  });
});

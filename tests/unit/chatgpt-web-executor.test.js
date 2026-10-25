// Executor-level coverage for the chatgpt-web chat lane: the streaming branch,
// the status the account-fallback loop reacts to, and the bounded wait on
// chatgpt.com. Everything below the executor is stubbed — these tests are about
// what this class promises its caller.
process.env.FETCH_CONNECT_TIMEOUT_MS = "40";

import { describe, expect, it, beforeEach, vi } from "vitest";

const stubs = vi.hoisted(() => ({
  session: null,
  turn: null,
  cleanRoom: null,
}));

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (url, options, proxyOptions) => stubs.session(String(url), options, proxyOptions),
}));

vi.mock("../../open-sse/executors/chatgpt-web/adapter.js", () => ({
  readStorageState: () => ({ cookies: [{ name: "__Secure-next-auth.session-token", value: "1" }] }),
  createDefaultSession: async () => ({}),
  executeChatGptWebCleanRoom: (input) => stubs.cleanRoom(input),
  resolveChatGptWebChromeExecutable: () => "/usr/bin/chrome",
  buildChatGptWebOpenAiResponse: (model, result) => Response.json({ model, content: result.text }),
}));

vi.mock("../../open-sse/executors/chatgpt-web/chatHttp.js", () => ({
  runChatGptWebHttpTurn: (args) => stubs.turn(args),
}));

vi.mock("../../open-sse/executors/chatgpt-web/imageGenHttp.js", () => ({
  cookieHeader: () => "session=1",
  generateChatGptWebImageHttp: async () => [],
}));

vi.mock("../../open-sse/executors/chatgpt-web/imageGen.js", () => ({
  generateChatGptWebImage: async () => [],
}));

vi.mock("../../open-sse/executors/chatgptWebTools.js", () => ({
  buildToolModeResponse: async () => Response.json({ tool: true }),
}));

vi.mock("../../open-sse/executors/browserExecutableCheck.js", () => ({
  isMissingBrowserExecutable: () => false,
}));

const { ChatGptWebExecutor } = await import("../../open-sse/executors/chatgpt-web.js");

const executor = new ChatGptWebExecutor();

function input(overrides = {}) {
  return {
    credentials: { providerSpecificData: {}, connectionId: "conn-1" },
    body: { messages: [{ role: "user", content: "hi" }] },
    model: "gpt-5-6",
    stream: true,
    log: null,
    proxyOptions: null,
    ...overrides,
  };
}

const okSession = async () => Response.json({ accessToken: "access-token" });

beforeEach(() => {
  stubs.session = okSession;
  stubs.cleanRoom = async () => new Response("browser-turn", { status: 200 });
  stubs.turn = async () => ({ text: "", hasTools: false, requestedTools: [] });
});

describe("chatgpt-web streaming lane", () => {
  it("forwards assistant text as it arrives and closes the stream", async () => {
    stubs.turn = async ({ onReady, onDelta }) => {
      onReady();
      onDelta("Hel");
      onDelta("lo there");
      return { text: "Hello there", hasTools: false, requestedTools: [] };
    };

    const result = await executor.execute(input());
    expect(result.response.status).toBe(200);
    const text = await result.response.text();
    const frames = text.split("\n\n").filter((f) => f.startsWith("data: "));

    expect(frames[0]).toContain('"delta":{"role":"assistant"');
    expect(frames.some((f) => f.includes('"content":"Hel"'))).toBe(true);
    expect(frames.some((f) => f.includes('"content":"lo there"'))).toBe(true);
    expect(frames.at(-2)).toContain('"finish_reason":"stop"');
    expect(frames.at(-1)).toBe("data: [DONE]");
    expect(frames[0]).toContain('"model":"gpt-5-6"');
  });

  it("hands a Turnstile challenge to the browser page before any byte", async () => {
    stubs.turn = async ({ onDelta }) => {
      onDelta("never reaches the client");
      throw Object.assign(new Error("ChatGPT requires a Turnstile challenge"), { code: "TURNSTILE_REQUIRED" });
    };
    const result = await executor.execute(input());
    // Readiness never fired, so the client gets the browser turn instead of a
    // half-open stream carrying text the fallback also emits.
    expect(result.response.status).toBe(200);
    expect(await result.response.text()).toBe("browser-turn");
  });

  it("keeps the upstream status when the turn is rejected before the 200", async () => {
    stubs.turn = async () => {
      throw Object.assign(new Error("ChatGPT prepare failed (HTTP 401) unauthorized"), { status: 401 });
    };
    const result = await executor.execute(input());
    // 401 (not a re-guessed 502) is what lets the fallback loop cool this account
    // and try the next one.
    expect(result.response.status).toBe(401);
  });

  it("does not open the stream when the session token cannot be resolved", async () => {
    stubs.session = async () => new Response("nope", { status: 403 });
    const result = await executor.execute(input());
    expect(result.response.status).toBe(401);
  });

  it("bounds a silent chatgpt.com instead of holding the account open", async () => {
    // Stands in for a real fetch that never gets headers: it rejects only when
    // the abort it was handed actually fires.
    stubs.session = (url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new Error("aborted")));
    });
    const started = Date.now();
    const result = await executor.execute(input());
    expect(Date.now() - started).toBeLessThan(5000);
    expect(result.response.status).toBe(502);
    expect((await result.response.json()).error.message).toMatch(/connect timeout/);
  });

  it("routes the proxy intent into the session fetch", async () => {
    const seen = [];
    stubs.session = async (url, options, proxyOptions) => {
      seen.push({ url, proxyOptions });
      return Response.json({ accessToken: "access-token" });
    };
    stubs.turn = async ({ onReady }) => {
      onReady();
      return { text: "ok", hasTools: false, requestedTools: [] };
    };
    const proxyOptions = { connectionProxyEnabled: true, connectionProxyUrl: "http://127.0.0.1:7890" };
    const result = await executor.execute(input({ proxyOptions }));
    await result.response.text();

    expect(seen[0].url).toContain("/api/auth/session");
    expect(seen[0].proxyOptions).toEqual(proxyOptions);
  });

  it("sends a tool request down the buffered path, not the incremental one", async () => {
    const streamed = [];
    stubs.turn = async ({ onDelta }) => {
      streamed.push(Boolean(onDelta));
      return { text: "<tool>{\"name\":\"x\",\"arguments\":{}}</tool>", hasTools: true, requestedTools: [] };
    };
    await executor.execute(input({ body: { messages: [{ role: "user", content: "hi" }], tools: [{ name: "x" }] } }));
    // Tools need the whole turn before the <tool> blocks can be parsed.
    expect(streamed).toEqual([false]);
  });
});

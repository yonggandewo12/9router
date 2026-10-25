// ChatGptWebExecutor — chatgpt.com session provider (clean-room).
//
// Routes requests through ChatGPT's first-party web client from a logged-in
// browser page: the page's own module solves Sentinel/Turnstile/PoW and the
// turn runs over the direct /f/conversation SSE path. Tools are not supported
// (the adapter rejects them upstream, matching the current upstream protocol).

import { BaseExecutor } from "./base.js";
import { randomUUID } from "node:crypto";
import { executeChatGptWebCleanRoom, createDefaultSession, readStorageState, resolveChatGptWebChromeExecutable, buildChatGptWebOpenAiResponse } from "./chatgpt-web/adapter.js";
import { generateChatGptWebImage } from "./chatgpt-web/imageGen.js";
import { generateChatGptWebImageHttp, cookieHeader } from "./chatgpt-web/imageGenHttp.js";
import { runChatGptWebHttpTurn } from "./chatgpt-web/chatHttp.js";
import { buildToolModeResponse } from "./chatgptWebTools.js";
import { isMissingBrowserExecutable } from "./browserExecutableCheck.js";
import { sseChunk } from "../utils/sse.js";
import { SSE_DONE, SSE_HEADERS_NO_BUFFER } from "../utils/sseConstants.js";

export { isMissingBrowserExecutable } from "./browserExecutableCheck.js";

const CHATGPT_WEB_URL = "https://chatgpt.com";
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

/** Resolve the session access token over HTTP, seeding the stored cookie jar. */
async function fetchAccessToken({ storageState, userAgent, signal }) {
  const cookie = cookieHeader(storageState);
  const res = await fetch(`${CHATGPT_WEB_URL}/api/auth/session`, {
    headers: { "User-Agent": userAgent, Accept: "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    signal,
  });
  if (!res.ok) {
    throw Object.assign(new Error(`ChatGPT session unavailable (HTTP ${res.status})`), {
      status: res.status === 403 ? 401 : res.status || 502,
    });
  }
  const body = await res.json().catch(() => null);
  if (typeof body?.accessToken !== "string" || !body.accessToken) {
    throw Object.assign(new Error("ChatGPT session is not signed in"), { status: 401 });
  }
  return body.accessToken;
}

function statusForAdapterError(message) {
  if (/storage state|credentials|connection ID/i.test(message)) return 401;
  // Preserve upstream quota semantics so the shared account-fallback loop can
  // exclude a depleted Free session and immediately try the next account.
  if (
    /(?:\bHTTP[_\s-]*429\b|\bstatus\s+429\b|\brate[-_\s]?limit(?:ed)?\b|\bquota\s+(?:exhausted|reached|exceeded)\b|\b(?:image(?:\s+upload)?|upload|usage)\s+limit\s+(?:reached|exceeded)\b|\breached\s+(?:your\s+)?(?:image(?:\s+upload)?|upload|usage)\s+limit\b)/i.test(
      message
    )
  ) {
    return 429;
  }
  if (/request|messages|prompt|model|tools|text content|reasoning effort/i.test(message)) {
    return 400;
  }
  return 502;
}

function errorResponse(status, message) {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export class ChatGptWebExecutor extends BaseExecutor {
  constructor() {
    super("chatgpt-web", { id: "chatgpt-web", baseUrl: CHATGPT_WEB_URL });
  }

  async testConnection(credentials) {
    try {
      const raw = credentials?.providerSpecificData?.storageState ?? credentials?.apiKey;
      if (typeof raw !== "string" || !raw.trim()) return false;
      // Accept either a full storage-state JSON or a raw session-token cookie.
      if (raw.trim().startsWith("{")) {
        JSON.parse(raw);
        return true;
      }
      return /__Secure-next-auth\.session-token|^[\w-]+\.[\w-]+\.[\w-]+$/.test(raw.trim());
    } catch {
      return false;
    }
  }

  async execute(input) {
    try {
      const http = await this.#executeHttp(input);
      if (http) return http;
      const response = await executeChatGptWebCleanRoom(input);
      return { response, url: CHATGPT_WEB_URL, headers: {}, transformedBody: input.body };
    } catch (error) {
      const message = error instanceof Error ? error.message : "ChatGPT Web browser execution failed";
      // A missing browser/Chrome is a host/config problem, not a transient
      // upstream fault — actionable 503 with the cooldown hint.
      if (isMissingBrowserExecutable(message)) {
        return {
          response: errorResponse(
            503,
            "ChatGPT Web requires a Chrome/Chromium browser (headed). Install Google Chrome " +
              "on the host (or set CHATGPT_WEB_CHROME_PATH), and run `npx playwright-core install chromium`."
          ),
          url: CHATGPT_WEB_URL,
          headers: {},
          transformedBody: input.body,
        };
      }
      return {
        response: errorResponse(statusForAdapterError(message), message),
        url: CHATGPT_WEB_URL,
        headers: {},
        transformedBody: input.body,
      };
    }
  }

  /**
   * Plain-HTTP chat turn. Returns null when the browser path should take over
   * (Turnstile enforcement).
   */
  async #executeHttp(input) {
    const { credentials, body, model, stream } = input;
    let storageState;
    try {
      storageState = readStorageState(credentials);
    } catch {
      return null;
    }
    const providerData = credentials?.providerSpecificData;
    const userAgent =
      typeof providerData?.customUserAgent === "string" && providerData.customUserAgent.trim()
        ? providerData.customUserAgent.trim()
        : DEFAULT_USER_AGENT;

    // Streaming chat without tools goes out incrementally. The access token is
    // fetched first, and the response is not returned until the upstream has
    // accepted the turn: session/prepare failures must keep their HTTP status so
    // the shared account-fallback loop can react (expired cookie, quota), which a
    // premature 200 would hide behind a broken stream.
    const hasRequestedTools = Array.isArray(body?.tools) && body.tools.length > 0;
    if (input.stream === true && !hasRequestedTools) {
      const accessToken = await fetchAccessToken({ storageState, userAgent, signal: input.signal });
      return this.#streamHttpTurn({ input, accessToken, storageState, userAgent, model });
    }

    let turn;
    try {
      const accessToken = await fetchAccessToken({ storageState, userAgent, signal: input.signal });
      turn = await runChatGptWebHttpTurn({
        baseUrl: CHATGPT_WEB_URL,
        accessToken,
        cookie: cookieHeader(storageState),
        userAgent,
        body,
        signal: input.signal,
        log: input.log,
      });
    } catch (error) {
      if (error?.code === "TURNSTILE_REQUIRED" || /Turnstile/i.test(error?.message || "")) return null;
      throw error;
    }

    if (!turn.hasTools) {
      return {
        response: buildChatGptWebOpenAiResponse(model, { text: turn.text }, stream),
        url: CHATGPT_WEB_URL,
        headers: {},
        transformedBody: body,
      };
    }
    const buffered = buildChatGptWebOpenAiResponse(model, { text: turn.text }, false);
    return {
      response: await buildToolModeResponse(buffered, turn.requestedTools, stream, {
        // OpenAI-shaped ids (`call-<ts>_<n>`) — clients treat them as opaque.
        idSeed: "call",
        cid: `chatcmpl-${randomUUID()}`,
        created: Math.floor(Date.now() / 1000),
        model,
      }),
      url: CHATGPT_WEB_URL,
      headers: {},
      transformedBody: body,
    };
  }

  /**
   * Streaming plain-HTTP chat turn. Resolves once the upstream accepted the
   * turn, so the caller can return a 200 that is already known to be valid; the
   * body then carries assistant text as it arrives. Turnstile still needs the
   * browser, and is handled before anything is emitted.
   */
  async #streamHttpTurn({ input, accessToken, storageState, userAgent, model }) {
    const { body, signal, log } = input;
    const encoder = new TextEncoder();
    const abort = new AbortController();
    const turnSignal = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal;
    const id = `chatcmpl-${randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);
    const streamModel = typeof model === "string" && model.trim() ? model.trim() : "chatgpt-web";
    let roleSent = false;
    let controller = null;
    let closed = false;

    const sse = new ReadableStream(
      {
        start: (c) => { controller = c; },
        cancel() { abort.abort(); },
      },
      { highWaterMark: 16384 }
    );

    const emit = (delta, finish = null) => {
      if (closed) return;
      try {
        controller.enqueue(encoder.encode(sseChunk({
          id,
          object: "chat.completion.chunk",
          created,
          model: streamModel,
          system_fingerprint: null,
          choices: [{ index: 0, delta, finish_reason: finish, logprobs: null }],
        })));
      } catch {
        closed = true;
      }
    };

    let resolveReady;
    let rejectReady;
    const ready = new Promise((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });

    const turnPromise = runChatGptWebHttpTurn({
      baseUrl: CHATGPT_WEB_URL,
      accessToken,
      cookie: cookieHeader(storageState),
      userAgent,
      body,
      signal: turnSignal,
      log,
      onReady: () => resolveReady(),
      onDelta: (text) => {
        if (!roleSent) {
          roleSent = true;
          emit({ role: "assistant", content: "" });
        }
        emit({ content: text });
      },
    });
    turnPromise.catch((error) => rejectReady(error));

    try {
      await ready;
    } catch (error) {
      const turnstile = error?.code === "TURNSTILE_REQUIRED" || /Turnstile/i.test(error?.message || "");
      if (turnstile) {
        const response = await executeChatGptWebCleanRoom(input);
        return { response, url: CHATGPT_WEB_URL, headers: {}, transformedBody: body };
      }
      throw error;
    }

    turnPromise
      .then(() => {
        if (!roleSent) {
          roleSent = true;
          emit({ role: "assistant", content: "" });
        }
        emit({}, "stop");
        if (!closed) {
          try {
            controller.enqueue(encoder.encode(SSE_DONE));
            controller.close();
          } catch {
            closed = true;
          }
        }
      })
      .catch((error) => {
        if (closed) return;
        try { controller.error(error); } catch { /* cancelled */ }
        closed = true;
      });

    return {
      response: new Response(sse, { status: 200, headers: { ...SSE_HEADERS_NO_BUFFER } }),
      url: CHATGPT_WEB_URL,
      headers: {},
      transformedBody: body,
    };
  }

  /**
   * Generate image(s) through ChatGPT's picture_v2 pipeline.
   *
   * Plain HTTP first — the sentinel headers are solved in Node (see
   * sentinel.js), so no browser is needed. The browser path stays as a
   * fallback for the day OpenAI enforces the Turnstile VM challenge.
   *
   * @returns {Promise<Array<{ b64: string, mime: string }>>}
   */
  async generateMedia({ prompt, n = 1, size, credentials, signal, log }) {
    if (!prompt) throw new Error("prompt is required for image generation");
    const storageState = readStorageState(credentials);
    const providerData = credentials.providerSpecificData;
    const userAgent =
      typeof providerData?.customUserAgent === "string" && providerData.customUserAgent.trim()
        ? providerData.customUserAgent.trim()
        : DEFAULT_USER_AGENT;

    const results = [];
    for (let i = 0; i < Math.max(1, n); i++) {
      results.push(await this.#generateOneImage({ prompt, size, storageState, userAgent, signal, log, credentials }));
    }
    return results;
  }

  async #generateOneImage({ prompt, size, storageState, userAgent, signal, log, credentials }) {
    try {
      const accessToken = await fetchAccessToken({ storageState, userAgent, signal });
      return await generateChatGptWebImageHttp({
        baseUrl: CHATGPT_WEB_URL,
        accessToken,
        cookie: cookieHeader(storageState),
        userAgent,
        prompt,
        sizeHint: size,
        signal,
        log,
      });
    } catch (error) {
      // Turnstile enforcement is the only case the browser path still wins;
      // everything else should surface its real error.
      if (error?.code !== "TURNSTILE_REQUIRED" && !/Turnstile/i.test(error?.message || "")) throw error;
      log?.warn?.("CGPT-WEB", "Sentinel demanded Turnstile — falling back to the browser path");
    }

    const connectionId =
      typeof credentials?.connectionId === "string" && credentials.connectionId.trim()
        ? credentials.connectionId.trim()
        : null;
    if (!connectionId) throw new Error("ChatGPT Web image generation requires a connection ID");
    const providerData = credentials.providerSpecificData;
    const session = await createDefaultSession({
      connectionId,
      storageState,
      selection: { kind: "picker", modelLabel: "GPT-5.6 Sol", effortIndex: 0 },
      userAgent,
      locale: typeof providerData?.locale === "string" ? providerData.locale : undefined,
      timezone: typeof providerData?.timezone === "string" ? providerData.timezone : undefined,
      chromeExecutablePath: resolveChatGptWebChromeExecutable(providerData?.chromeExecutablePath),
    });
    try {
      await session.start();
      return await generateChatGptWebImage(session.page, { prompt, sizeHint: size, signal, log });
    } finally {
      await session.page.close().catch(() => {});
    }
  }
}

export default ChatGptWebExecutor;

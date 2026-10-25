// The chatgpt-web lane talks to chatgpt.com's own web API. Chat was parked on
// image until the HTTP path streamed properly; these pin the stream contract:
// assistant text must reach the client as it is appended upstream, and the
// authoritative conversation document must still win at the end.
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../open-sse/executors/chatgpt-web/sentinel.js", () => ({
  fetchSentinelHeaders: async () => ({ "X-Sentinel": "test" }),
}));

// proxyFetch patches the global fetch on import, so the lane's HTTP calls go
// through its own reference — stub proxyAwareFetch itself.
const net = vi.hoisted(() => ({ handler: null }));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (url, options) => net.handler(String(url), options),
}));

const { runChatGptWebHttpTurn, assistantTextFromDocument } = await import(
  "../../open-sse/executors/chatgpt-web/chatHttp.js"
);

const CONVERSATION_ID = "123e4567-e89b-12d3-a456-426614174000";
const enc = new TextEncoder();

function sseFrame(event, payload, sep = "\n") {
  return `event: ${event}${sep}data: ${JSON.stringify(payload)}${sep}${sep}`;
}

/** Minimal v1 delta stream: one assistant message whose text grows. */
function deltaStreamBody(initialText, sep = "\n") {
  const frames = [
    sseFrame("delta_encoding", "v1", sep),
    sseFrame("delta", {
      p: "",
      o: "add",
      v: {
        conversation_id: CONVERSATION_ID,
        mapping: {
          node0: {
            message: {
              author: { role: "assistant" },
              create_time: 1,
              content: { content_type: "text", parts: [initialText] },
              metadata: { is_complete: false },
            },
          },
        },
      },
    }, sep),
  ];
  return new ReadableStream({
    start(controller) {
      for (const frame of frames) controller.enqueue(enc.encode(frame));
      controller.close();
    },
  });
}

function stubFetch({ documentText, complete = true, sseText = "", sseSep = "\n" }) {
  net.handler = async (url) => {
    const target = String(url);
    if (target.includes("/f/conversation/prepare")) {
      return Response.json({ conduit_token: "tok" });
    }
    if (target.includes("/f/conversation")) {
      return new Response(deltaStreamBody(sseText, sseSep), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    if (target.includes("/backend-api/conversation/")) {
      return Response.json({
        mapping: {
          node0: {
            message: {
              author: { role: "assistant" },
              create_time: 1,
              content: { content_type: "text", parts: [documentText] },
              metadata: { is_complete: complete },
            },
          },
        },
      });
    }
    throw new Error(`unexpected fetch: ${target}`);
  };
}

beforeEach(() => {
  net.handler = async () => {
    throw new Error("no network stub installed");
  };
});
afterEach(() => {
  net.handler = null;
});

const baseArgs = {
  baseUrl: "https://chatgpt.test",
  accessToken: "access",
  cookie: "session=1",
  userAgent: "test-agent",
  body: { messages: [{ role: "user", content: "hi" }] },
};

describe("assistantTextFromDocument", () => {
  it("picks the newest assistant text and ignores other roles", () => {
    const document = {
      mapping: {
        a: { message: { author: { role: "assistant" }, create_time: 1, content: { content_type: "text", parts: ["old"] } } },
        b: { message: { author: { role: "user" }, create_time: 9, content: { content_type: "text", parts: ["ignored"] } } },
        c: { message: { author: { role: "assistant" }, create_time: 5, content: { content_type: "text", parts: ["new ", "text"] } } },
      },
    };
    expect(assistantTextFromDocument(document)).toBe("new text");
    expect(assistantTextFromDocument(null)).toBe("");
  });
});

describe("runChatGptWebHttpTurn streaming", () => {
  it("reports text incrementally and appends what the poll document adds", async () => {
    stubFetch({ sseText: "hel", documentText: "hello!" });
    const deltas = [];
    const turn = await runChatGptWebHttpTurn({ ...baseArgs, onDelta: (d) => deltas.push(d) });

    expect(turn.text).toBe("hello!");
    expect(turn.hasTools).toBe(false);
    // "hel" arrived on the delta stream; "lo!" came from the authoritative poll.
    expect(deltas.join("")).toBe("hello!");
    expect(deltas.length).toBeGreaterThan(1);
  });

  it("buffers the whole turn when no consumer asked for deltas", async () => {
    stubFetch({ sseText: "partial", documentText: "complete answer" });
    const turn = await runChatGptWebHttpTurn(baseArgs);
    expect(turn.text).toBe("complete answer");
  });

  it("streams when the wire separates frames with CRLF", async () => {
    // parseChatGptWebEncodedItem already tolerates CRLF; a frame splitter that
    // only knows LF would buffer every frame and hand the client one lump.
    stubFetch({ sseText: "hel", documentText: "hello!", sseSep: "\r\n" });
    const deltas = [];
    const turn = await runChatGptWebHttpTurn({ ...baseArgs, onDelta: (d) => deltas.push(d) });

    expect(turn.text).toBe("hello!");
    expect(deltas.join("")).toBe("hello!");
    expect(deltas.length).toBeGreaterThan(1);
  });

  it("keeps the streamed prefix and reports a rewritten final document", async () => {
    // The answer already on screen is never rewritten mid-turn; the divergence
    // is logged so the mismatch is visible instead of silently dropped.
    stubFetch({ sseText: "hel", documentText: "goodbye!" });
    const warnings = [];
    const log = { warn: (tag, message) => warnings.push(`${tag} ${message}`) };
    const deltas = [];
    const turn = await runChatGptWebHttpTurn({ ...baseArgs, onDelta: (d) => deltas.push(d), log });

    expect(turn.text).toBe("goodbye!");
    expect(deltas.join("")).toBe("hel");
    expect(warnings.join(" ")).toMatch(/diverged/);
  });

  it("notifies readiness only after the upstream accepted the turn", async () => {
    stubFetch({ sseText: "hi", documentText: "hi there" });
    let readyAt = -1;
    let firstDeltaAt = -1;
    const order = [];
    await runChatGptWebHttpTurn({
      ...baseArgs,
      onReady: () => { readyAt = order.length; order.push("ready"); },
      onDelta: () => { if (firstDeltaAt < 0) firstDeltaAt = order.length; order.push("delta"); },
    });
    expect(readyAt).toBe(0);
    expect(firstDeltaAt).toBeGreaterThan(readyAt);
  });

  it("does not report readiness when the turn is rejected upstream", async () => {
    net.handler = async (url) => {
      const target = String(url);
      if (target.includes("/f/conversation/prepare")) {
        return new Response("unauthorized", { status: 401 });
      }
      return Response.json({});
    };
    const onReady = vi.fn();
    await expect(runChatGptWebHttpTurn({ ...baseArgs, onReady })).rejects.toMatchObject({ status: 401 });
    expect(onReady).not.toHaveBeenCalled();
  });

  it("surfaces a refused turn with no text as an error instead of empty content", async () => {
    net.handler = async (url) => {
      const target = String(url);
      if (target.includes("/f/conversation/prepare")) return Response.json({ conduit_token: "tok" });
      if (target.includes("/f/conversation")) {
        return new Response(deltaStreamBody(""), { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      return Response.json({
        mapping: {
          node0: {
            message: {
              author: { role: "assistant" },
              create_time: 1,
              content: { content_type: "text", parts: [] },
              metadata: { is_complete: true, is_error: true },
            },
          },
        },
      });
    };
    await expect(runChatGptWebHttpTurn(baseArgs)).rejects.toMatchObject({ status: 400 });
  });
});

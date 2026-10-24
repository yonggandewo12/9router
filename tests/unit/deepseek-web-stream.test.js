// The deepseek-web executor talks to chat.deepseek.com's PoW-gated web API and
// re-emits its proprietary SSE as OpenAI chunks. These pin the stream contract:
// what counts as content, how a session that dies mid-generation is reported,
// and that cancelling the response tears the upstream read down.
import { describe, expect, it } from "vitest";

import { transformSSE, extractUserToken } from "../../open-sse/executors/deepseek-web.js";
import { cleanDeepSeekToken } from "../../open-sse/executors/deepseek-web/stream-format.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

function sseBody(lines, { onCancel = null } = {}) {
  return new ReadableStream({
    start(controller) {
      for (const line of lines) controller.enqueue(enc.encode(line + "\n"));
      controller.close();
    },
    cancel: onCancel || undefined,
  });
}

const frag = (content, type = "ANSWER") =>
  `data: ${JSON.stringify({ p: "response/fragments", v: [{ type, content }] })}`;
const FINISHED = `data: ${JSON.stringify({ p: "response/status", v: "FINISHED" })}`;

async function drain(stream) {
  const reader = stream.getReader();
  let out = "";
  let error = null;
  for (;;) {
    const { done, value } = await reader.read().catch((err) => {
      error = err;
      return { done: true, value: undefined };
    });
    if (done) break;
    out += dec.decode(value, { stream: true });
  }
  return { out, error };
}

function contentOf(out) {
  return [...out.matchAll(/"content":"((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1]}"`)).join("");
}

describe("deepseek-web stream transform", () => {
  it("emits OpenAI chunks, stop and [DONE] for a finished answer", async () => {
    const { out, error } = await drain(
      transformSSE(sseBody([frag("hello "), frag("world"), FINISHED]), "deepseek-web/deepseek-chat")
    );
    expect(error).toBeNull();
    expect(contentOf(out)).toBe("hello world");
    expect(out).toContain('"finish_reason":"stop"');
    expect(out.trimEnd().endsWith("data: [DONE]")).toBe(true);
  });

  it("keeps the word FINISHED inside genuine answer text", async () => {
    const { out } = await drain(
      transformSSE(sseBody([frag("the build FINISHED successfully"), FINISHED]), "deepseek-web/deepseek-chat")
    );
    expect(contentOf(out)).toBe("the build FINISHED successfully");
  });

  it("routes THINK fragments to reasoning_content", async () => {
    const { out } = await drain(
      transformSSE(sseBody([frag("hmm", "THINK"), frag("answer"), FINISHED]), "deepseek-web/deepseek-chat")
    );
    expect(out).toContain('"reasoning_content":"hmm"');
    expect(contentOf(out)).toBe("answer");
  });

  it("errors an empty stream whose session died before FINISHED", async () => {
    const { out, error } = await drain(
      transformSSE(sseBody([frag("")]), "deepseek-web/deepseek-chat")
    );
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/before completion/);
    expect(out).not.toContain("[DONE]");
  });

  it("completes a PARTIAL answer whose session died, instead of erroring mid-reply", async () => {
    const { out, error } = await drain(
      transformSSE(sseBody([frag("partial answer")]), "deepseek-web/deepseek-chat")
    );
    expect(error).toBeNull();
    expect(contentOf(out)).toBe("partial answer");
    expect(out).toContain('"finish_reason":"stop"');
  });

  it("cancelling the transformed stream cancels the upstream read", async () => {
    let upstreamCancelled = false;
    const upstream = new ReadableStream({
      start(controller) {
        controller.enqueue(enc.encode(frag("a") + "\n"));
        // never closes: stands in for a long generation
      },
      cancel() {
        upstreamCancelled = true;
      },
    });
    const transformed = transformSSE(upstream, "deepseek-web/deepseek-chat");
    const reader = transformed.getReader();
    await reader.read();
    await reader.cancel();
    expect(upstreamCancelled).toBe(true);
  });
});

describe("cleanDeepSeekToken", () => {
  it("strips a leaked status marker at the fragment start only", () => {
    expect(cleanDeepSeekToken("FINISHED rest")).toBe("rest");
    expect(cleanDeepSeekToken("FINISHED")).toBe("");
    expect(cleanDeepSeekToken("the job FINISHED ok")).toBe("the job FINISHED ok");
    expect(cleanDeepSeekToken("SEARCHING the web")).toBe("the web");
  });
});

describe("extractUserToken", () => {
  // chat.deepseek.com writes this envelope for every visitor; treating it as the
  // token sends `Bearer {"value":null,...}` and fails with 401 forever.
  it("rejects DeepSeek's pre-login placeholder envelope", () => {
    expect(extractUserToken({ apiKey: '{"value":null,"__version":"0"}' })).toBeNull();
    expect(extractUserToken({ apiKey: '{"value":"","__version":"0"}' })).toBeNull();
  });

  it("unwraps a real envelope and passes raw tokens through", () => {
    expect(extractUserToken({ apiKey: '{"value":"abc-token-123","__version":"0"}' })).toBe("abc-token-123");
    expect(extractUserToken({ apiKey: "raw-token-value" })).toBe("raw-token-value");
    expect(extractUserToken({ accessToken: "from-access-token" })).toBe("from-access-token");
  });
});

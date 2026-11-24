import { afterEach, describe, expect, it, vi } from "vitest";
import { BaseExecutor } from "../../open-sse/executors/base.js";
import { CodeBuddyExecutor, sanitizeCodeBuddySystemPrompt } from "../../open-sse/executors/codebuddy-cn.js";

const longRules = "Project rules: preserve public APIs, write regression tests, and explain tradeoffs. ".repeat(90);
const marker = "You are Claude Code, Anthropic's official CLI for Claude.";

afterEach(() => vi.restoreAllMocks());

describe("CodeBuddy CN precise system-prompt sanitization", () => {
  it("leaves a long legitimate system prompt byte-for-byte intact", () => {
    expect(sanitizeCodeBuddySystemPrompt(longRules)).toBe(longRules);
    const out = new CodeBuddyExecutor().transformRequest("glm-5.2", {
      model: "glm-5.2",
      messages: [{ role: "system", content: longRules }, { role: "user", content: "hi" }],
    }, true, {});
    expect(out.messages[0].content).toBe(longRules);
  });

  it("sanitizes developer-role identity markers as well as system markers", () => {
    const out = new CodeBuddyExecutor().transformRequest("glm-5.2", {
      model: "glm-5.2",
      messages: [
        { role: "developer", content: `Keep developer rules.\n${marker}` },
        { role: "user", content: "hi" },
      ],
    }, true, {});
    expect(out.messages[0].content).toContain("Keep developer rules.");
    expect(out.messages[0].content).not.toMatch(/claude code/i);
  });

  it("keeps an unchanged typed-block array by reference", () => {
    const blocks = [{ type: "text", text: longRules }];
    expect(sanitizeCodeBuddySystemPrompt(blocks)).toBe(blocks);
  });

  it("replaces only the identity phrase and preserves surrounding project rules", () => {
    const input = `${longRules}\n${marker}\nNever delete user data.`;
    const out = sanitizeCodeBuddySystemPrompt(input);
    expect(out).toContain(longRules);
    expect(out).toContain("Never delete user data.");
    expect(out).toContain("You are an AI coding assistant.");
    expect(out).not.toMatch(/claude code|anthropic's official cli/i);
  });

  it("sanitizes typed text blocks without dropping non-text blocks", () => {
    const image = { type: "image_url", image_url: { url: "https://example.test/a.png" } };
    const out = sanitizeCodeBuddySystemPrompt([
      { type: "text", text: `Keep this rule.\n${marker}` },
      image,
    ]);
    expect(out[0].text).toContain("Keep this rule.");
    expect(out[0].text).not.toMatch(/claude code/i);
    expect(out[1]).toBe(image);
  });

  it("retries once with a neutral system prompt only after the known 11128 identity refusal", async () => {
    const execute = vi.spyOn(BaseExecutor.prototype, "execute")
      .mockResolvedValueOnce({
        response: Response.json({ code: 11128, msg: "Illegal API invocation from an unapproved channel" }, { status: 400 }),
      })
      .mockResolvedValueOnce({ response: new Response("ok", { status: 200 }) });
    const body = {
      model: "glm-5.2",
      messages: [{ role: "system", content: longRules }, { role: "user", content: "hi" }],
    };

    const result = await new CodeBuddyExecutor().execute({ model: "glm-5.2", body, stream: true, credentials: {} });

    expect(result.response.status).toBe(200);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[1][0].body.messages[0].content).toBe(
      "You are a helpful AI assistant that helps with software engineering tasks.",
    );
  });

  it("bounds inspection of a stalled 400 response body", async () => {
    vi.useFakeTimers();
    try {
      const execute = vi.spyOn(BaseExecutor.prototype, "execute").mockResolvedValue({
        response: new Response(new ReadableStream({ start() {} }), { status: 400 }),
      });
      const pending = new CodeBuddyExecutor().execute({
        model: "glm-5.2",
        body: { messages: [{ role: "system", content: longRules }, { role: "user", content: "hi" }] },
        stream: true,
        credentials: {},
      });
      await vi.advanceTimersByTimeAsync(2000);
      const result = await pending;
      expect(result.response.status).toBe(400);
      expect(execute).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not replay a request on an unrelated 400", async () => {
    const execute = vi.spyOn(BaseExecutor.prototype, "execute").mockResolvedValue({
      response: Response.json({ code: 11101, msg: "invalid request" }, { status: 400 }),
    });
    const result = await new CodeBuddyExecutor().execute({
      model: "glm-5.2",
      body: { messages: [{ role: "system", content: longRules }, { role: "user", content: "hi" }] },
      stream: true,
      credentials: {},
    });
    expect(result.response.status).toBe(400);
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

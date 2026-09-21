/**
 * A Chat Completions stream that carries an in-band error frame (HTTP 200
 * already committed upstream, e.g. qoder's queue throttle) must not end as
 * `response.completed` for Responses/Codex clients — that is a fake success
 * with truncated output. It has to close as `response.failed`.
 */

import { describe, it, expect } from "vitest";
import { openaiToOpenAIResponsesResponse } from "../../open-sse/translator/response/openai-responses.js";
import { initState } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

describe("OpenAI Chat stream → Responses: in-band error frame", () => {
  it("fails the response instead of completing it", () => {
    const state = initState(FORMATS.OPENAI_RESPONSES);
    const events = [
      { id: "cmb-1", choices: [{ index: 0, delta: { content: "partial" } }] },
      { id: "cmb-1", choices: [], error: { message: "[qoder error 403: 10605]", type: "rate_limit_error", code: "rate_limit_exceeded" } },
    ].flatMap(chunk => openaiToOpenAIResponsesResponse(chunk, state));

    const failed = events.find(e => e.event === "response.failed");
    expect(failed).toBeDefined();
    expect(failed.data.response.status).toBe("failed");
    expect(failed.data.response.error.message).toContain("10605");
    expect(events.some(e => e.event === "response.completed")).toBe(false);
    // the text delta must still be closed so the event stream stays well-formed
    expect(events.some(e => e.event === "response.output_text.done")).toBe(true);
  });

  it("sends no terminal event twice when flush runs after the error", () => {
    const state = initState(FORMATS.OPENAI_RESPONSES);
    openaiToOpenAIResponsesResponse(
      { id: "cmb-1", choices: [{ index: 0, delta: { content: "partial" } }] },
      state
    );
    openaiToOpenAIResponsesResponse({ choices: [], error: { message: "boom" } }, state);
    expect(openaiToOpenAIResponsesResponse(null, state)).toEqual([]);
  });
});

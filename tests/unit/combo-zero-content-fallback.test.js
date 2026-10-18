import { describe, expect, it, vi } from "vitest";
import { handleComboChat, isZeroContentResponse } from "../../open-sse/services/combo.js";

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const jsonResponse = (payload, status = 200) =>
  new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });

const chat = (content, finish = "stop", extra = {}) => ({
  id: "chatcmpl-x",
  choices: [{ message: { role: "assistant", content, ...extra }, finish_reason: finish }],
});

function runCombo(responses, models = ["p/model-a", "p/model-b"]) {
  const handleSingleModel = vi.fn(async (body, modelStr) => {
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next;
  });
  return {
    handleSingleModel,
    call: handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models,
      handleSingleModel,
      log,
      comboName: "t",
      comboStrategy: "fallback",
      autoSwitch: false,
    }),
  };
}

describe("combo fallback on HTTP 200 with zero usable content", () => {
  it("skips an empty first seat and returns the next model's answer", async () => {
    // Only a stalled finish counts as empty: an empty message with
    // finish_reason "stop" is a legitimate answer (see the no-double-spend case).
    const { handleSingleModel, call } = runCombo([
      jsonResponse(chat("   ", "in_progress")),
      jsonResponse(chat("real answer")),
    ]);
    const res = await call;
    expect(res.status).toBe(200);
    expect((await res.json()).choices[0].message.content).toBe("real answer");
    expect(handleSingleModel).toHaveBeenCalledTimes(2);
  });

  it("does not let a skipped 200 become the combo's failure status", async () => {
    // The bug being guarded: recording lastStatus = 200 for the skipped seat made an
    // all-unusable combo answer {"error":…} under HTTP 200, so clients and
    // usageHistory both saw success.
    const { call } = runCombo([
      jsonResponse(chat("", "incomplete")),
      jsonResponse({ error: { message: "rate limited" } }, 429),
    ]);
    const res = await call;
    expect(res.status).toBe(429);
    expect((await res.json()).error.message).toBe("rate limited");
  });

  it("returns the last seat's empty answer instead of inventing an error", async () => {
    const { handleSingleModel, call } = runCombo([
      jsonResponse(chat("", "incomplete")),
      jsonResponse(chat("", "incomplete")),
    ]);
    const res = await call;
    expect(res.status).toBe(200);
    expect(handleSingleModel).toHaveBeenCalledTimes(2);
  });

  it("keeps a normal-finish empty completion as success (no double spend)", async () => {
    const { handleSingleModel, call } = runCombo([
      jsonResponse(chat("", "stop")),
      jsonResponse(chat("second seat")),
    ]);
    const res = await call;
    expect((await res.json()).choices[0].message.content).toBe("");
    expect(handleSingleModel).toHaveBeenCalledTimes(1);
  });

  it("treats tool calls and reasoning as usable content", async () => {
    const { handleSingleModel, call } = runCombo([
      jsonResponse(chat(null, "tool_calls", { tool_calls: [{ id: "c1", function: { name: "read", arguments: "{}" } }] })),
      jsonResponse(chat("unused")),
    ]);
    const res = await call;
    expect((await res.json()).choices[0].message.tool_calls).toHaveLength(1);
    expect(handleSingleModel).toHaveBeenCalledTimes(1);
    expect(isZeroContentResponse({ content: [{ type: "text", text: "" }, { type: "tool_use", id: "t", name: "r", input: {} }] })).toBe(false);
  });

  it("does not peek into a streaming seat", async () => {
    // The SSE lane is excluded on purpose: buffering it to test for emptiness would
    // cost the first byte on every successful combo turn.
    const stream = new Response("data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\n", {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
    const { handleSingleModel, call } = runCombo([stream]);
    const res = await call;
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(handleSingleModel).toHaveBeenCalledTimes(1);
  });
});

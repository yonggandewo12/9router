import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: mocks.fetch,
}));
vi.mock("../../open-sse/services/qoderModels.js", () => ({
  getQoderModelConfig: async () => ({ key: "auto", is_reasoning: false, max_output_tokens: 16 }),
  resolveQoderModels: vi.fn(),
  resolveQoderCredentials: vi.fn(),
  isQoderPat: () => false,
  QoderAuthError: class extends Error {},
}));

import { QoderExecutor } from "../../open-sse/executors/qoder.js";

const frame = (body, statusCodeValue = 200) =>
  `data: ${JSON.stringify({ statusCodeValue, body: JSON.stringify(body) })}\n\n`;

beforeEach(() => {
  mocks.fetch.mockReset();
});

describe("Qoder queue replay cleanup", () => {
  it("cancels the refused upstream body before polling and replaying", async () => {
    let queuedBodyCancelled = false;
    const queued = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(frame({
          code: "10605",
          message: "queued",
          isQueued: true,
          modelKey: "auto",
          queueType: "p3",
          retryAfterSeconds: 0,
        }, 429)));
        // Keep the socket open like the real gateway; only cancel() releases it.
      },
      cancel() {
        queuedBodyCancelled = true;
      },
    }), { status: 200, headers: { "Content-Type": "text/event-stream" } });

    const success = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          frame({ choices: [{ delta: { content: "OK" }, finish_reason: "stop" }] }) + "data: [DONE]\n\n",
        ));
        controller.close();
      },
    }), { status: 200, headers: { "Content-Type": "text/event-stream" } });

    let inferenceCalls = 0;
    mocks.fetch.mockImplementation(async (url) => {
      if (String(url).includes("/queue/status")) {
        return Response.json({ isQueued: false, modelKey: "auto", queueType: "p3", retryAfterSeconds: 0 });
      }
      inferenceCalls++;
      return inferenceCalls === 1 ? queued : success;
    });

    const result = await new QoderExecutor("qoder").execute({
      model: "auto",
      body: { messages: [{ role: "user", content: "hi" }], max_tokens: 8 },
      stream: true,
      credentials: {
        provider: "qoder",
        accessToken: "jt-test",
        providerSpecificData: { userId: "u", machineId: "m" },
      },
    });

    expect(result.response.status).toBe(200);
    expect(await result.response.text()).toContain("OK");
    expect(inferenceCalls).toBe(2);
    expect(queuedBodyCancelled).toBe(true);
  });
});

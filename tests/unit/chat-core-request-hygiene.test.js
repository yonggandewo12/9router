/**
 * Two account-state invariants in chatCore:
 *   1. A local translation failure happens BEFORE this request increments its
 *      pending counter. Decrementing on that path takes a unit off another
 *      in-flight request on the same model+account, which is what the concurrency
 *      limiter and the account-health view read.
 *   2. Whichever response the 401 retry drops has to be cancelled; an unread body
 *      keeps its socket parked until the kernel gives up.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { executeMock, refreshCredentialsMock, trackPendingRequest } = vi.hoisted(() => ({
  executeMock: vi.fn(),
  refreshCredentialsMock: vi.fn(),
  trackPendingRequest: vi.fn(),
}));

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: () => ({ noAuth: false, execute: executeMock, refreshCredentials: refreshCredentialsMock }),
}));

vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => ({
    logClientRawRequest: vi.fn(), logRawRequest: vi.fn(), logTargetRequest: vi.fn(),
    logProviderResponse: vi.fn(), logConvertedResponse: vi.fn(), logError: vi.fn(),
    appendProviderChunk: vi.fn(), appendConvertedChunk: vi.fn(), sessionPath: null,
  }),
}));

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest,
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
}));

// The translator returns null only when a registered route yields nothing; no client
// body shape reliably gets there. Stub the one call so the invariant (this failure is
// local, so it must not touch shared account state) is what the test exercises.
const { translateRequestMock } = vi.hoisted(() => ({ translateRequestMock: vi.fn() }));
vi.mock("../../open-sse/translator/index.js", async (importOriginal) => {
  const actual = await importOriginal();
  translateRequestMock.mockImplementation((...args) => actual.translateRequest(...args));
  return { ...actual, translateRequest: translateRequestMock };
});

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");

const okResponse = () => new Response(JSON.stringify({
  id: "msg_test", object: "chat.completion",
  choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop", index: 0 }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
}), { status: 200, headers: { "content-type": "application/json" } });

function unauthorizedResponse() {
  const response = new Response(JSON.stringify({ error: { message: "token expired" } }), {
    status: 401,
    headers: { "content-type": "application/json" },
  });
  const cancel = vi.fn(response.body.cancel.bind(response.body));
  response.body.cancel = cancel;
  return { response, cancel };
}

const args = (extra = {}) => ({
  body: { model: "gpt-5", messages: [{ role: "user", content: "hello" }], stream: false },
  modelInfo: { provider: "openai", model: "gpt-5" },
  credentials: { apiKey: "sk-old", accessToken: "at-old", refreshToken: "rt", providerSpecificData: {} },
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  connectionId: "conn-a",
  rtkEnabled: false,
  headroomEnabled: false,
  cavemanEnabled: false,
  ponytailEnabled: false,
  pxpipeEnabled: false,
  ...extra,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("chatCore request hygiene", () => {
  it("does not touch the pending counter when translation fails locally", async () => {
    translateRequestMock.mockReturnValueOnce(null);

    const result = await handleChatCore(args());

    expect(result.status).toBe(400);
    expect(result.success).toBe(false);
    expect(executeMock).not.toHaveBeenCalled();
    expect(trackPendingRequest).not.toHaveBeenCalled();
  });

  it("cancels the 401 response it replaces after a successful refresh", async () => {
    const { response: first, cancel } = unauthorizedResponse();
    executeMock
      .mockResolvedValueOnce({ response: first, url: "https://api.openai.com/v1/chat/completions", headers: {}, transformedBody: null })
      .mockResolvedValueOnce({ response: okResponse(), url: "https://api.openai.com/v1/chat/completions", headers: {}, transformedBody: null });
    refreshCredentialsMock.mockResolvedValueOnce({ accessToken: "at-new", apiKey: "at-new" });

    const result = await handleChatCore(args());

    expect(executeMock).toHaveBeenCalledTimes(2);
    expect(cancel).toHaveBeenCalled();
    expect(result.success).toBe(true);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// cursorModels talks to agent.api5.cursor.sh over raw HTTP/2 (h2-only upstream),
// so stub the http2 client instead of global.fetch.
const h2Mock = vi.hoisted(() => ({
  requests: [],
  nextResponse: { status: 200, body: new Uint8Array() },
}));

vi.mock("http2", () => ({
  default: {
    connect: (origin) => ({
      on: () => {},
      close: () => {},
      request: (headers) => {
        const handlers = {};
        const req = {
          on: (event, cb) => { (handlers[event] ||= []).push(cb); return req; },
          end: (body) => {
            h2Mock.requests.push({ origin, headers, body });
            queueMicrotask(() => {
              handlers.response?.forEach(cb => cb({ ":status": h2Mock.nextResponse.status }));
              if (h2Mock.nextResponse.body?.length) {
                handlers.data?.forEach(cb => cb(Buffer.from(h2Mock.nextResponse.body)));
              }
              handlers.end?.forEach(cb => cb());
            });
          },
        };
        return req;
      },
    }),
  },
}));

import {
  clearCursorModelCache,
  parseCursorUsableModels,
  resolveCursorModels,
} from "../../open-sse/services/cursorModels.js";

function varint(value) {
  const bytes = [];
  while (value >= 0x80) {
    bytes.push((value & 0x7f) | 0x80);
    value >>>= 7;
  }
  bytes.push(value);
  return Uint8Array.from(bytes);
}

function field(fieldNumber, value) {
  return Uint8Array.from([(fieldNumber << 3) | 2, ...varint(value.length), ...value]);
}

function text(value) {
  return new TextEncoder().encode(value);
}

function concat(...parts) {
  const size = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function model(id, name) {
  return field(1, concat(field(1, text(id)), field(4, text(name))));
}

describe("Cursor live model catalog", () => {
  beforeEach(() => {
    clearCursorModelCache();
  });

  afterEach(() => {
    clearCursorModelCache();
  });

  it("decodes the GetUsableModels protobuf response", () => {
    const payload = concat(
      model("default", "Auto"),
      model("gpt-5.3-codex", "GPT 5.3 Codex"),
      model("gpt-5.3-codex", "Duplicate"),
    );

    expect(parseCursorUsableModels(payload)).toEqual([
      { id: "default", name: "Auto" },
      { id: "gpt-5.3-codex", name: "GPT 5.3 Codex" },
    ]);
  });

  it("fetches the account-specific catalog and caches it", async () => {
    const payload = concat(model("claude-4.6-opus", "Claude 4.6 Opus"));
    h2Mock.requests.length = 0;
    h2Mock.nextResponse = { status: 200, body: Buffer.from(payload) };
    const credentials = {
      accessToken: "cursor-token",
      providerSpecificData: { machineId: "machine-id" },
    };

    await expect(resolveCursorModels(credentials)).resolves.toEqual({
      models: [{ id: "claude-4.6-opus", name: "Claude 4.6 Opus" }],
    });
    await expect(resolveCursorModels(credentials)).resolves.toEqual({
      models: [{ id: "claude-4.6-opus", name: "Claude 4.6 Opus" }],
    });

    expect(h2Mock.requests).toHaveLength(1);
    const { origin, headers } = h2Mock.requests[0];
    expect(origin).toBe("https://agent.api5.cursor.sh");
    expect(headers[":path"]).toBe("/agent.v1.AgentService/GetUsableModels");
    expect(headers["content-type"]).toBe("application/proto");
    expect(headers["accept"]).toBe("application/proto");
  });

  it("fails open when the Cursor catalog request fails", async () => {
    h2Mock.nextResponse = { status: 403, body: new Uint8Array() };

    await expect(resolveCursorModels({
      accessToken: "cursor-token",
      providerSpecificData: { machineId: "machine-id" },
    })).resolves.toBeNull();
  });
});

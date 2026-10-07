import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock DNS lookup so we control which host resolves to what IP.
const lookupMock = vi.fn();
vi.mock("node:dns/promises", () => ({ lookup: (...a) => lookupMock(...a) }));

// Track the dispatchers image.js builds, to prove they are pooled rather than
// rebuilt (and re-closed) for every image in a turn.
const { agentInstances } = vi.hoisted(() => ({ agentInstances: [] }));
vi.mock("undici", () => ({
  Agent: class MockAgent {
    constructor(options) {
      this.options = options;
      this.closed = false;
      agentInstances.push(this);
    }
    close() {
      this.closed = true;
      return Promise.resolve();
    }
  },
}));

import { fetchImageAsBase64 } from "../../open-sse/translator/concerns/image.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function mockFetchOnce(bytes, ok = true) {
  const body = {
    getReader() {
      let sent = false;
      return {
        read: async () => sent ? { done: true } : (sent = true, { done: false, value: new Uint8Array(bytes) }),
        cancel: async () => {},
      };
    },
  };
  globalThis.fetch = vi.fn(async () => ({ ok, body }));
}

beforeEach(() => {
  lookupMock.mockReset();
  // lookup(hostname, { all: true }) -> array of records; public by default.
  lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
});
afterEach(() => { vi.restoreAllMocks(); });

describe("fetchImageAsBase64 hardening", () => {
  it("rejects non-http url", async () => {
    expect(await fetchImageAsBase64("ftp://x/y.png")).toBeNull();
    expect(await fetchImageAsBase64("data:image/png;base64,xx")).toBeNull();
  });

  it("SSRF: rejects private IP (10.x)", async () => {
    lookupMock.mockResolvedValue([{ address: "10.0.0.5", family: 4 }]);
    expect(await fetchImageAsBase64("http://internal.example/x.png")).toBeNull();
  });

  it("SSRF: rejects cloud metadata 169.254.169.254", async () => {
    lookupMock.mockResolvedValue([{ address: "169.254.169.254", family: 4 }]);
    expect(await fetchImageAsBase64("http://metadata/x.png")).toBeNull();
  });

  it("SSRF: rejects blocked hostname localhost", async () => {
    expect(await fetchImageAsBase64("http://localhost/x.png")).toBeNull();
  });

  it("SSRF: rejects IPv6 loopback", async () => {
    lookupMock.mockResolvedValue([{ address: "::1", family: 4 }]);
    expect(await fetchImageAsBase64("http://x/y.png")).toBeNull();
  });

  it("accepts valid PNG from public host", async () => {
    mockFetchOnce(PNG);
    const r = await fetchImageAsBase64("https://example.com/a.png");
    expect(r).not.toBeNull();
    expect(r.mimeType).toBe("image/png");
    expect(r.url.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("rejects disguised non-image payload (magic byte mismatch)", async () => {
    mockFetchOnce(Buffer.from("<?php system($_GET[c]); ?>"));
    expect(await fetchImageAsBase64("https://example.com/evil.png")).toBeNull();
  });

  it("rejects payload over size cap", async () => {
    mockFetchOnce(Buffer.alloc(1024));
    expect(await fetchImageAsBase64("https://example.com/big.png", { maxBytes: 100 })).toBeNull();
  });

  it("returns null when fetch not ok", async () => {
    mockFetchOnce(PNG, false);
    expect(await fetchImageAsBase64("https://example.com/404.png")).toBeNull();
  });

  it("reuses one pinned dispatcher per host+IP instead of rebuilding it per image", async () => {
    mockFetchOnce(PNG);
    const before = agentInstances.length;

    expect(await fetchImageAsBase64("https://pool.test/a.png")).not.toBeNull();
    expect(await fetchImageAsBase64("https://pool.test/b.png")).not.toBeNull();

    expect(agentInstances.length - before).toBe(1);
    expect(globalThis.fetch.mock.calls[1][1].dispatcher).toBe(agentInstances[before]);
    expect(agentInstances[before].closed).toBe(false);
  });

  it("still dials the validated IP through the cached dispatcher", async () => {
    mockFetchOnce(PNG);
    await fetchImageAsBase64("https://pinning.test/a.png");
    const pinned = agentInstances[agentInstances.length - 1];

    await new Promise((resolve) => pinned.options.connect.lookup("pinning.test", {}, (_err, records) => {
      expect(records).toEqual([{ address: "93.184.216.34", family: 4 }]);
      resolve();
    }));
  });

  it("builds a fresh dispatcher when the host resolves to a new IP", async () => {
    mockFetchOnce(PNG);
    const before = agentInstances.length;
    await fetchImageAsBase64("https://rotate.test/a.png");
    lookupMock.mockResolvedValue([{ address: "93.184.216.99", family: 4 }]);
    await fetchImageAsBase64("https://rotate.test/b.png");

    expect(agentInstances.length - before).toBe(2);
  });
});

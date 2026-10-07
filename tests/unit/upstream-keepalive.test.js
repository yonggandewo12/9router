// Locks the two transport decisions that decide time-to-first-token:
//  1. an upstream socket survives the gap between two turns of an agent session;
//  2. a long client-side idle timer never hands out a socket the upstream closed.
// Plus the client-facing header that keeps intermediaries from buffering the stream.
//
// The upstream stub is a raw TCP server on purpose: it answers HTTP/1.1 without a
// `Keep-Alive: timeout=` header, which is what copilot.tencent.com and
// api.anthropic.com actually do. Node's own http.Server advertises
// `keep-alive: timeout=<keepAliveTimeout>`, and undici honors an advertised value
// over its client-side default — a real http.Server would hide the very cliff
// these tests exist to pin.
import { describe, it, expect, afterAll } from "vitest";
import net from "node:net";
import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { SSE_HEADERS_CORS } from "../../open-sse/utils/sseConstants.js";
import { UPSTREAM_KEEPALIVE_TIMEOUT_MS } from "../../open-sse/config/runtimeConfig.js";

function startRawUpstream({ idleDestroyMs = null } = {}) {
  let connections = 0;
  let requests = 0;
  const live = new Set();
  const server = net.createServer((sock) => {
    connections++;
    live.add(sock);
    sock.on("close", () => live.delete(sock));
    sock.setNoDelay();
    let buf = "";
    const onData = (chunk) => {
      buf += chunk.toString("binary");
      const headEnd = buf.indexOf("\r\n\r\n");
      if (headEnd === -1) return;
      const head = buf.slice(0, headEnd);
      const lenMatch = /content-length:\s*(\d+)/i.exec(head);
      const bodyLen = lenMatch ? Number(lenMatch[1]) : 0;
      if (buf.length < headEnd + 4 + bodyLen) return;
      buf = buf.slice(headEnd + 4 + bodyLen);
      requests++;
      const body = '{"ok":true}';
      // `connection: keep-alive` and deliberately NO `keep-alive: timeout=`.
      sock.write(
        "HTTP/1.1 200 OK\r\n" +
        "content-type: application/json\r\n" +
        `content-length: ${Buffer.byteLength(body)}\r\n` +
        "connection: keep-alive\r\n\r\n" + body
      );
    };
    sock.on("data", onData);
    sock.on("error", () => {});
    if (idleDestroyMs) sock.setTimeout(idleDestroyMs, () => sock.destroy());
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({
      url: `http://127.0.0.1:${server.address().port}/echo`,
      sockets: () => connections,
      hits: () => requests,
      // The pooled socket outlives the test on purpose (that is the point), so
      // server.close() alone would hang waiting for it.
      stop: async () => {
        for (const s of live) s.destroy();
        await new Promise((r) => server.close(r));
      },
    }));
  });
}

const post = (url) => proxyAwareFetch(url, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ ping: 1 }),
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe("upstream connection reuse", () => {
  const upstreams = [];
  afterAll(async () => { for (const u of upstreams) await u.stop(); });

  it("keeps one socket alive across an idle gap past undici's 4s default", async () => {
    expect(UPSTREAM_KEEPALIVE_TIMEOUT_MS).toBeGreaterThan(4000);
    const upstream = await startRawUpstream();
    upstreams.push(upstream);
    const { url, sockets } = upstream;

    const first = await post(url);
    expect(first.status).toBe(200);
    await first.text();

    // Past undici's stock 4s default (and its 2s threshold), well inside ours.
    await sleep(6000);
    const second = await post(url);
    expect(second.status).toBe(200);
    await second.text();

    expect(sockets()).toBe(1);
  }, 30_000);

  it("still succeeds when the upstream destroys the idle socket first", async () => {
    // The pooled socket is dead before the next request wants it: the client must
    // reap it on the close event instead of writing into a corpse.
    const upstream = await startRawUpstream({ idleDestroyMs: 250 });
    upstreams.push(upstream);
    const { url, hits } = upstream;

    for (let i = 0; i < 6; i++) {
      const res = await post(url);
      await res.text();
      expect(res.status).toBe(200);
      await sleep(700);
    }
    expect(hits()).toBe(6);
  }, 30_000);
});

describe("client-facing SSE headers", () => {
  it("forbids intermediary buffering and re-encoding of the stream", () => {
    expect(SSE_HEADERS_CORS["Content-Type"]).toBe("text/event-stream");
    expect(SSE_HEADERS_CORS["X-Accel-Buffering"]).toBe("no");
    expect(SSE_HEADERS_CORS["Cache-Control"]).toContain("no-transform");
  });
});

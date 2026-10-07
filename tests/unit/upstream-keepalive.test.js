// Locks the transport decisions that decide time-to-first-token:
//  1. an upstream socket survives the gap between two turns of an agent session;
//  2. a long client-side idle timer never hands out a socket the upstream closed;
//  3. a configured proxy stays in front even when the caller brings its own
//     dispatcher (the pinned-IP image fetch) — an egress policy outranks a
//     transport detail (#4333);
// plus the client-facing header that keeps intermediaries from buffering the stream.
//
// The upstream stub is a raw TCP server on purpose: it answers HTTP/1.1 without a
// `Keep-Alive: timeout=` header, which is what every gateway this proxy actually
// talks to does. Node's own http.Server advertises
// `keep-alive: timeout=<keepAliveTimeout>`, and undici honors an advertised value
// over its client-side default — a real http.Server would hide the very cliff
// these tests exist to pin.
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import net from "node:net";
import { Agent } from "undici";
import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { SSE_HEADERS_CORS } from "../../open-sse/utils/sseConstants.js";
import { UPSTREAM_KEEPALIVE_TIMEOUT_MS } from "../../open-sse/config/runtimeConfig.js";

const PROXY_ENV_VARS = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"];

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

// Forward proxy: counts whatever it was asked to carry, in either dialect undici
// may pick (absolute-form for an http origin, CONNECT tunnel for an https one).
function startCountingProxy() {
  let carried = 0;
  const live = new Set();
  const server = net.createServer((client) => {
    client.once("data", (head) => {
      const text = head.toString("latin1");
      const [requestLine, ...rest] = text.split("\r\n");
      const [method, target] = requestLine.split(" ");
      carried++;
      const isConnect = method === "CONNECT";
      const host = isConnect ? target : new URL(target).host;
      const [hostname, port] = isConnect ? target.split(":") : [new URL(target).hostname, new URL(target).port || 80];
      const upstream = net.connect(Number(port), hostname, () => {
        if (isConnect) client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        else upstream.write(`${method} ${new URL(target).pathname} HTTP/1.1\r\n${rest.join("\r\n")}\r\n\r\n`);
        client.pipe(upstream);
        upstream.pipe(client);
      });
      live.add(client); live.add(upstream);
      upstream.on("error", () => client.destroy());
      client.on("error", () => upstream.destroy());
      client.on("close", () => upstream.destroy());
      upstream.on("close", () => client.destroy());
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({
      url: `http://127.0.0.1:${server.address().port}`,
      carried: () => carried,
      stop: async () => {
        for (const s of live) s.destroy();
        await new Promise((r) => server.close(r));
      },
    }));
  });
}

const post = (url, extra = {}) => proxyAwareFetch(url, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ ping: 1 }),
  ...extra,
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe("upstream connection reuse", () => {
  const openers = [];
  beforeEach(() => {
    // A developer's own shell proxy would otherwise swallow these 127.0.0.1
    // requests (getEnvProxyUrl only exempts what NO_PROXY names).
    for (const name of PROXY_ENV_VARS) vi.stubEnv(name, "");
  });
  afterEach(() => vi.unstubAllEnvs());
  afterAll(async () => { for (const u of openers) await u.stop(); });

  it("keeps one socket alive across an idle gap past undici's 4s default", async () => {
    expect(UPSTREAM_KEEPALIVE_TIMEOUT_MS).toBeGreaterThan(4000);
    const upstream = await startRawUpstream();
    openers.push(upstream);
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
    const upstream = await startRawUpstream({ idleDestroyMs: 200 });
    openers.push(upstream);
    const { url, hits } = upstream;

    for (let i = 0; i < 4; i++) {
      const res = await post(url);
      await res.text();
      expect(res.status).toBe(200);
      await sleep(500);
    }
    expect(hits()).toBe(4);
  }, 30_000);

  it("keeps a configured proxy in front of a caller-supplied dispatcher", async () => {
    const upstream = await startRawUpstream();
    const proxy = await startCountingProxy();
    openers.push(upstream, proxy);
    vi.stubEnv("HTTP_PROXY", proxy.url);

    // Stands for translator/concerns/image.js, which pins a validated IP and
    // passes its own Agent. It must not become a way around the proxy.
    const callerDispatcher = new Agent();
    const res = await post(upstream.url, { dispatcher: callerDispatcher });
    await res.text();

    expect(res.status).toBe(200);
    expect(proxy.carried()).toBe(1);
    await callerDispatcher.close().catch(() => {});
  }, 30_000);

  it("honours the caller's dispatcher when no proxy is configured", async () => {
    const upstream = await startRawUpstream();
    openers.push(upstream);
    const callerDispatcher = new Agent();
    const res = await post(upstream.url, { dispatcher: callerDispatcher });
    await res.text();

    expect(res.status).toBe(200);
    await callerDispatcher.close().catch(() => {});
  }, 30_000);
});

describe("client-facing SSE headers", () => {
  it("forbids intermediary buffering and re-encoding of the stream", () => {
    expect(SSE_HEADERS_CORS["Content-Type"]).toBe("text/event-stream");
    expect(SSE_HEADERS_CORS["X-Accel-Buffering"]).toBe("no");
    expect(SSE_HEADERS_CORS["Cache-Control"]).toContain("no-transform");
  });
});

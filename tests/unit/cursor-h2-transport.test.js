import { describe, it, expect, vi } from "vitest";

// The Cursor transports are the only place in the fork that speaks raw HTTP/2,
// and both failure modes that matter (a head that never arrives, a socket that
// dies without END_STREAM) cannot be produced against a real server in a test.
// So http2 itself is stubbed with the handful of members the executor uses.
const h2 = vi.hoisted(() => {
  const sessions = [];

  class Emitter {
    constructor() {
      this.listeners = new Map();
    }
    on(event, fn) {
      const list = this.listeners.get(event) || [];
      list.push(fn);
      this.listeners.set(event, list);
      return this;
    }
    once(event, fn) {
      const wrapped = (...args) => {
        this.off(event, wrapped);
        fn(...args);
      };
      return this.on(event, wrapped);
    }
    off(event, fn) {
      const list = this.listeners.get(event) || [];
      const index = list.indexOf(fn);
      if (index >= 0) list.splice(index, 1);
      return this;
    }
    emit(event, ...args) {
      for (const fn of [...(this.listeners.get(event) || [])]) fn(...args);
      return true;
    }
  }

  const connect = () => {
    const client = new Emitter();
    client.closed = false;
    client.close = () => {
      client.closed = true;
    };
    client.request = () => {
      const req = new Emitter();
      req.destroyed = false;
      req.writeCalls = 0;
      req.write = () => {
        req.writeCalls += 1;
      };
      req.end = () => {};
      req.destroy = () => {
        if (req.destroyed) return;
        req.destroyed = true;
        req.emit("close");
      };
      sessions.push({ client, req });
      return req;
    };
    return client;
  };

  return { sessions, connect };
});

vi.mock("http2", () => ({ default: { connect: h2.connect }, connect: h2.connect }));

const { CursorExecutor } = await import("../../open-sse/executors/cursor.js");

const AGENT_URL = "https://agent.api5.cursor.sh/agent.v1.AgentService/Run";
const lastSession = () => h2.sessions[h2.sessions.length - 1];
const tick = () => new Promise((resolve) => setImmediate(resolve));

const credentials = {
  accessToken: "test-token",
  providerSpecificData: { machineId: "a".repeat(64) },
};

describe("Cursor legacy HTTP/2 transport (makeHttp2Request)", () => {
  it("resolves a numeric status when the response head has no :status", async () => {
    const executor = new CursorExecutor();
    const pending = executor.makeHttp2Request("https://api2.cursor.sh/x", {}, Buffer.from("body"), null);
    await tick();
    const { req, client } = lastSession();
    req.emit("end");

    const response = await pending;
    // undefined here would make the caller's `new Response(..., {status})` a 200.
    expect(response.status).toBe(0);
    expect(client.closed).toBe(true);
  });

  it("resolves the real status and drains the body", async () => {
    const executor = new CursorExecutor();
    const pending = executor.makeHttp2Request("https://api2.cursor.sh/x", {}, Buffer.from("body"), null);
    await tick();
    const { req, client } = lastSession();
    req.emit("response", { ":status": 429 });
    req.emit("data", Buffer.from("nope"));
    req.emit("end");

    const response = await pending;
    expect(response.status).toBe(429);
    expect(response.body.toString()).toBe("nope");
    expect(client.closed).toBe(true);
  });

  it("rejects at once when the caller already aborted", async () => {
    const executor = new CursorExecutor();
    const controller = new AbortController();
    controller.abort();
    const pending = executor.makeHttp2Request("https://api2.cursor.sh/x", {}, Buffer.from("body"), controller.signal);

    await expect(pending).rejects.toThrow(/aborted/i);
    const { client, req } = lastSession();
    expect(client.closed).toBe(true);
    // client.close() lets live streams finish, so the request has to kill its own.
    expect(req.destroyed).toBe(true);
    expect(req.writeCalls).toBe(0);
  });
});

describe("Cursor AgentService HTTP/2 session (openAgentHttp2Stream)", () => {
  it("settles the head wait when the session is closed before any response", async () => {
    const executor = new CursorExecutor();
    const session = executor.openAgentHttp2Stream(AGENT_URL, {}, null);
    session.close();

    await expect(session.responseHeaders).rejects.toThrow(/stream closed/i);
    expect(lastSession().client.closed).toBe(true);
  });

  it("settles the head wait when the caller aborts", async () => {
    const executor = new CursorExecutor();
    const controller = new AbortController();
    const session = executor.openAgentHttp2Stream(AGENT_URL, {}, controller.signal);
    controller.abort();

    await expect(session.responseHeaders).rejects.toThrow(/aborted/i);
  });

  it("gives up on a response head that never arrives", async () => {
    const executor = new CursorExecutor();
    executor.config = { ...executor.config, timeoutMs: 25 };
    const session = executor.openAgentHttp2Stream(AGENT_URL, {}, null);

    await expect(session.responseHeaders).rejects.toThrow(/no response head/i);
  });

  it("fails a mid-stream read when the socket drops without END_STREAM", async () => {
    const executor = new CursorExecutor();
    const session = executor.openAgentHttp2Stream(AGENT_URL, {}, null);
    const { req } = lastSession();
    req.emit("response", { ":status": 200 });
    await session.responseHeaders;
    req.emit("data", Buffer.from("partial"));
    expect(await session.read()).toEqual({ value: Buffer.from("partial"), done: false });

    req.destroy();
    await expect(session.read()).rejects.toThrow(/stream closed/i);
  });

  it("treats the close that follows a clean end as teardown, not an error", async () => {
    const executor = new CursorExecutor();
    const session = executor.openAgentHttp2Stream(AGENT_URL, {}, null);
    const { req } = lastSession();
    req.emit("response", { ":status": 200 });
    await session.responseHeaders;
    req.emit("data", Buffer.from("hello"));
    req.emit("end");
    req.emit("close");
    session.close();

    expect(await session.read()).toEqual({ value: Buffer.from("hello"), done: false });
    expect(await session.read()).toEqual({ value: undefined, done: true });
  });
});

describe("Cursor transport choice under a proxy", () => {
  // proxyAwareFetch is the only transport that can carry a resolved proxy; the
  // h2 duplex opens a direct socket and would leak the host IP behind a pool.
  const imageBody = {
    messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAA" } }] }],
  };

  async function runLegacy(executor, proxyOptions) {
    executor.makeHttp2Request = vi.fn(async () => ({ status: 200, headers: {}, body: Buffer.alloc(0) }));
    executor.makeFetchRequest = vi.fn(async () => ({ status: 200, headers: {}, body: Buffer.alloc(0) }));
    await executor.execute({
      model: "gpt-4o",
      body: imageBody,
      stream: false,
      credentials,
      proxyOptions,
    });
    return executor;
  }

  it("uses fetch when a strict pool cannot be honored on h2", async () => {
    const executor = await runLegacy(new CursorExecutor(), { strictProxy: true, proxyPoolId: "pool-1" });
    expect(executor.makeFetchRequest).toHaveBeenCalledTimes(1);
    expect(executor.makeHttp2Request).not.toHaveBeenCalled();
  });

  it("uses fetch when a connection proxy is enabled", async () => {
    const executor = await runLegacy(new CursorExecutor(), { connectionProxyEnabled: true, connectionProxyUrl: "http://127.0.0.1:8080" });
    expect(executor.makeFetchRequest).toHaveBeenCalledTimes(1);
    expect(executor.makeHttp2Request).not.toHaveBeenCalled();
  });

  it("keeps the h2 duplex when there is no proxy to honor", async () => {
    const executor = await runLegacy(new CursorExecutor(), null);
    expect(executor.makeHttp2Request).toHaveBeenCalledTimes(1);
    expect(executor.makeFetchRequest).not.toHaveBeenCalled();
  });
});

describe("Cursor AgentService empty-turn retry", () => {
  function stubSession(status) {
    const closes = [];
    return {
      closes,
      session: {
        responseHeaders: Promise.resolve({ ":status": status }),
        write() {},
        end() {},
        close: () => closes.push(true),
        async read() {
          return { value: undefined, done: true };
        },
      },
    };
  }

  it("closes the retry session when its head is not 200", async () => {
    const executor = new CursorExecutor();
    const first = stubSession(200);
    const retry = stubSession(503);
    const queue = [first.session, retry.session];
    executor.openAgentHttp2Stream = () => queue.shift();

    // 80+ messages is what makes an empty turn retryable (long-replay recovery).
    const messages = Array.from({ length: 80 }, (_, i) => ({
      role: i % 2 ? "assistant" : "user",
      content: `message ${i}`,
    }));
    const result = await executor.executeAgent({
      model: "gpt-5.2",
      body: { messages },
      stream: false,
      credentials,
    });

    expect(first.closes.length).toBeGreaterThan(0);
    // The fresh h2 client is opened outside consume(), so nothing else closes it.
    expect(retry.closes.length).toBeGreaterThan(0);
    expect(result.response.status).toBe(400);
  });
});

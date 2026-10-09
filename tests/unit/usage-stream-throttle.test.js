// Dashboard stats SSE: the emitter fires 250ms after every completed request, so
// an unthrottled handler turns a busy minute into a full usage recalculation per
// request. These pin the coalescing (and that a late change still gets a run).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const fx = vi.hoisted(() => ({ fullCalls: 0, lightCalls: 0, gate: null, emitter: null }));

vi.mock("@/lib/usageDb", async () => {
  const { EventEmitter } = await import("node:events");
  fx.emitter = new EventEmitter();
  fx.emitter.setMaxListeners(0);
  return {
    statsEmitter: fx.emitter,
    getUsageStats: async () => {
      fx.fullCalls++;
      if (fx.gate) await fx.gate;
      return { total: fx.fullCalls, activeRequests: 0, recentRequests: [] };
    },
    getActiveRequests: async () => {
      fx.lightCalls++;
      return { activeRequests: 1, recentRequests: [], errorProvider: null };
    },
  };
});

const { GET } = await import("../../src/app/api/usage/stream/route.js");

// Collects SSE payloads in the background so a test can advance timers freely.
async function connect() {
  const res = await GET();
  const events = [];
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const pump = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let sep;
      while ((sep = buf.indexOf("\n\n")) >= 0) {
        const raw = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        if (raw.startsWith("data: ")) events.push(JSON.parse(raw.slice(6)));
      }
    }
  })();
  return { res, events, reader, pump };
}

const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
  fx.fullCalls = 0;
  fx.lightCalls = 0;
  fx.gate = null;
});

afterEach(() => {
  fx.emitter.removeAllListeners("update");
  fx.emitter.removeAllListeners("pending");
  vi.useRealTimers();
});

describe("usage stats stream coalescing", () => {
  it("sends the full stats once on connect", async () => {
    const { events, reader } = await connect();
    await flush();
    expect(fx.fullCalls).toBe(1);
    expect(events).toHaveLength(1);
    expect(events[0].total).toBe(1);
    await reader.cancel();
  });

  it("collapses a burst of updates into one heavy recalc plus cheap pushes", async () => {
    const { events, reader } = await connect();
    await flush();

    for (let i = 0; i < 20; i++) fx.emitter.emit("update");
    await vi.advanceTimersByTimeAsync(300);
    await vi.advanceTimersByTimeAsync(2000);

    // One recalc for the whole burst, not twenty — and a handful of events, not
    // the 40 an unthrottled handler would have pushed.
    expect(fx.fullCalls).toBe(2);
    expect(events).toHaveLength(4);
    expect(events.at(-1).total).toBe(2);
    expect(fx.lightCalls).toBeLessThanOrEqual(2);
    await reader.cancel();
  });

  it("still recalculates for a change that lands mid-recalc", async () => {
    const { reader } = await connect();
    await flush();
    expect(fx.fullCalls).toBe(1);

    // Hold the next recalc open, then let a change arrive while it runs.
    let release;
    fx.gate = new Promise((r) => { release = r; });
    await vi.advanceTimersByTimeAsync(2100);
    fx.emitter.emit("update");
    await flush();
    expect(fx.fullCalls).toBe(2); // started, blocked on the gate

    fx.emitter.emit("update"); // lands mid-recalc
    await flush();
    expect(fx.fullCalls).toBe(2); // not started twice in parallel

    fx.gate = null;
    release();
    await vi.advanceTimersByTimeAsync(2100);
    expect(fx.fullCalls).toBe(3); // trailing run picked the change up
    await reader.cancel();
  });

  it("detaches listeners and timers when the client goes away", async () => {
    const { reader, pump } = await connect();
    await flush();
    expect(fx.emitter.listenerCount("update")).toBe(1);

    await reader.cancel();
    await pump;
    expect(fx.emitter.listenerCount("update")).toBe(0);
    expect(fx.emitter.listenerCount("pending")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

import { getUsageStats, statsEmitter, getActiveRequests } from "@/lib/usageDb";

export const dynamic = "force-dynamic";

// statsEmitter fires "update" 250ms after every completed request. Under load that
// used to mean one full getUsageStats() + two ~25KB events per request, on the
// event loop that also serves the model streams. Coalesce instead: the cheap
// active/recent push is rate-limited, the heavy recalc runs at most once per
// interval with a trailing run so the last change is never dropped.
const LIGHT_PUSH_MIN_MS = 250;
const FULL_REFRESH_MIN_MS = 2000;

export async function GET() {
  const encoder = new TextEncoder();
  const state = {
    closed: false,
    keepalive: null,
    send: null,
    sendPending: null,
    cachedStats: null,
    timers: new Set(),
    fullInFlight: false,
    lastFullAt: 0,
    lastLightAt: 0,
  };

  const track = (fn, ms) => {
    const timer = setTimeout(() => {
      state.timers.delete(timer);
      fn();
    }, ms);
    state.timers.add(timer);
    return timer;
  };

  const close = () => {
    if (state.closed) return;
    state.closed = true;
    for (const timer of state.timers) clearTimeout(timer);
    state.timers.clear();
    clearInterval(state.keepalive);
    if (state.send) {
      statsEmitter.off("update", state.send);
      statsEmitter.off("pending", state.sendPending);
    }
  };

  const stream = new ReadableStream({
    async start(controller) {
      const emit = (payload) => {
        if (state.closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
        } catch {
          close();
        }
      };

      // Cheap: only activeRequests + recentRequests change, the rest is cached.
      let lightTimer = null;
      const pushLight = () => {
        if (state.closed || !state.cachedStats) return;
        const wait = LIGHT_PUSH_MIN_MS - (Date.now() - state.lastLightAt);
        if (wait > 0) {
          if (lightTimer) return;
          lightTimer = track(() => {
            lightTimer = null;
            state.lastLightAt = 0;
            pushLight();
          }, wait);
          return;
        }
        state.lastLightAt = Date.now();
        getActiveRequests()
          .then(({ activeRequests, recentRequests, errorProvider }) => {
            if (state.closed || !state.cachedStats) return;
            emit({ ...state.cachedStats, activeRequests, recentRequests, errorProvider });
          })
          .catch(close);
      };

      // Heavy: full recalculation. `fullDirty` records that something changed
      // since the last run; exactly one of {in-flight run, pending timer} may
      // exist at a time so a burst can never queue two recalcs back to back.
      let fullTimer = null;
      let fullDirty = false;

      function scheduleFull() {
        if (state.closed) return;
        fullDirty = true;
        if (fullTimer || state.fullInFlight) return;
        const wait = FULL_REFRESH_MIN_MS - (Date.now() - state.lastFullAt);
        if (wait > 0) {
          fullTimer = track(() => {
            fullTimer = null;
            fullDirty = false;
            runFull();
          }, wait);
          return;
        }
        fullDirty = false;
        runFull();
      }

      const runFull = async () => {
        if (state.closed || state.fullInFlight) return;
        state.fullInFlight = true;
        state.lastFullAt = Date.now();
        try {
          const stats = await getUsageStats();
          state.cachedStats = stats;
          emit(stats);
        } catch {
          close();
        } finally {
          state.fullInFlight = false;
        }
        // A change arrived while we were recalculating — run once more so the
        // client never settles on stale totals.
        if (fullDirty) scheduleFull();
      };

      state.send = () => {
        pushLight();
        scheduleFull();
      };
      state.sendPending = () => pushLight();

      try {
        const stats = await getUsageStats();
        state.cachedStats = stats;
        state.lastFullAt = Date.now();
        emit(stats);
      } catch {
        close();
        return;
      }

      statsEmitter.on("update", state.send);
      statsEmitter.on("pending", state.sendPending);

      state.keepalive = setInterval(() => {
        if (state.closed) {
          clearInterval(state.keepalive);
          return;
        }
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          close();
        }
      }, 25000);
    },

    cancel() {
      close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

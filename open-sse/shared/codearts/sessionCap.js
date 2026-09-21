// CodeArts (华为云码道) concurrent-session cap.
//
// The snap gateway allows 3 concurrent chat sessions per personal-station
// account, keyed by the `user-session-id` header. Live capture: 5 parallel
// streams return 200/200/200 plus two HTTP 400 `TM.00001041
// 并发会话数已达上限(3个)` within ~1s, and a slot frees when the stream ends.
//
// `/api/v1/queue/status` is NOT the arbiter of that cap, so nothing here calls
// it: a signed GET answers `status:"working"` for any task_id even while chat
// requests are being refused, and each GET registers a row that only a DELETE
// clears (that registry is what the CLI's own pre-flight uses). The chat call is
// the only request that reports capacity truthfully, so a refused turn re-issues
// the chat call until a slot frees or the wait budget runs out.
export const SESSION_CAP_ERROR_CODE = "TM.00001041";

// 9router serves interactive clients, which give up long before the CLI's
// 29-minute keepalive, so a refused turn waits out a bounded window.
export const SESSION_CAP_WAIT_MS = 45000;
const FIRST_DELAY_MS = 2000;
const MAX_DELAY_MS = 8000;

/**
 * Abort-aware sleep. The caller's signal is chatCore's client-disconnect
 * controller, and the executor contract on that path is an AbortError.
 */
export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener?.("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

function abortError(signal) {
  const error = new Error("CodeArts session-slot wait aborted");
  error.name = "AbortError";
  error.cause = signal?.reason;
  return error;
}

/** True when an upstream error body is the concurrent-session rejection. */
export function isSessionCapExceeded(text) {
  return typeof text === "string" && text.includes(SESSION_CAP_ERROR_CODE);
}

/** Backoff before retry `round` (0-based), jittered so parallel conversations do not retry in lockstep. */
export function capRetryDelayMs(round) {
  const base = Math.min(MAX_DELAY_MS, FIRST_DELAY_MS * 2 ** round);
  return base + Math.floor(Math.random() * (base / 4));
}

/**
 * Drive `attempt` — one chat round trip, reported as { capped, result } — until
 * the gateway stops refusing it for capacity, then hand back the last result.
 * @returns {Promise<object>} the executor result to return to the client
 */
export async function sendUntilSessionSlot({
  attempt, model = "", signal = null, log = null,
  budgetMs = SESSION_CAP_WAIT_MS, delayFor = capRetryDelayMs, nap = sleep,
} = {}) {
  const deadline = Date.now() + budgetMs;
  for (let round = 0; ; round++) {
    const { capped, result } = await attempt();
    if (!capped) return result;

    const waitMs = delayFor(round);
    const remaining = deadline - Date.now() - waitMs;
    if (remaining <= 0) {
      log?.warn?.("QUEUE", `CODEARTS | ${model} still refused after ${Math.round(budgetMs / 1000)}s of full session slots`);
      return result;
    }
    log?.warn?.("QUEUE", `CODEARTS | ${model} refused: all session slots busy, resend in ${waitMs / 1000}s (${Math.round(remaining / 1000)}s left)`);
    await nap(waitMs, signal);
  }
}

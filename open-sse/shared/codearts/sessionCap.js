// CodeArts (华为云码道) gateway refusals — the two ways the snap gateway says
// "not yet", and the bounded resend that turns either into a wait.
//
// 1. CONCURRENT SESSION CAP. 3 concurrent chat sessions per personal-station
//    account, keyed by the `user-session-id` header. Live capture: 5 parallel
//    streams return 200/200/200 plus two HTTP 400 `TM.00001041
//    并发会话数已达上限(3个)` within ~1s, and a slot frees when the stream ends.
// 2. MODEL QUEUE. Every catalog model carries `model_parameters.enable_queue`,
//    and the official CLI treats HTTP 429 with a `queue-status: queued` header as
//    "wait, then re-POST the same request" (its own budget is 12h; ours is a
//    proxy budget, since an interactive client has usually given up long before).
//
// `/api/v1/queue/status` is deliberately NOT consulted: a signed GET answers
// `status:"working"` for any task_id that was never registered, each GET creates
// a row only DELETE clears, and it reports nothing about either refusal above.
// (The CLI's `trace-queues/<traceId>` poll endpoint is not even published on
// snap-access — it answers APIG.0101 "The API does not exist".) The chat call is
// the only request that reports both truthfully, so a refused turn re-issues the
// chat call until the gateway stops refusing it or the window closes.
const SESSION_CAP_ERROR_CODE = "TM.00001041";

// 9router serves interactive clients, which give up long before the CLI's
// 12-hour queue budget, so a refused turn waits out a bounded window.
const REFUSAL_WAIT_MS = 45000;
const FIRST_DELAY_MS = 2000;
const MAX_DELAY_MS = 8000;
// CLI parity: a 429 without Retry-After means "check again in 5s".
const QUEUE_DEFAULT_WAIT_S = 5;
const QUEUE_MIN_WAIT_MS = 1000;

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

/**
 * True when the gateway queued this turn instead of answering it. Header-based:
 * the CLI detects the same signal (`queue-status: queued`, case-insensitive) and
 * the body carries nothing distinguishable.
 */
export function isModelQueued(response) {
  const status = String(response?.headers?.get?.("queue-status") || "");
  return status.toLowerCase() === "queued";
}

/** How long the gateway asked us to wait before re-POSTing, in ms. */
export function queueRetryDelayMs(response) {
  const declared = Number(response?.headers?.get?.("retry-after"));
  const seconds = Number.isFinite(declared) && declared > 0 ? declared : QUEUE_DEFAULT_WAIT_S;
  return Math.max(QUEUE_MIN_WAIT_MS, seconds * 1000);
}

/** Backoff before retry `round` (0-based), jittered so parallel conversations do not retry in lockstep. */
export function capRetryDelayMs(round) {
  const base = Math.min(MAX_DELAY_MS, FIRST_DELAY_MS * 2 ** round);
  return base + Math.floor(Math.random() * (base / 4));
}

/**
 * Drive `attempt` — one chat round trip, reported as { retryInMs, result } —
 * until the gateway stops refusing it, then hand back the last result.
 * `retryInMs` null/absent means "not a refusal (or no time left to wait)".
 * @returns {Promise<object>} the executor result to return to the client
 */
export async function sendUntilAdmitted({
  attempt, model = "", signal = null, log = null,
  budgetMs = REFUSAL_WAIT_MS, nap = sleep,
} = {}) {
  const deadline = Date.now() + budgetMs;
  for (let round = 0; ; round++) {
    const { retryInMs = null, result } = await attempt(round);
    if (retryInMs == null) return result;

    const remaining = deadline - Date.now();
    if (remaining <= retryInMs) {
      log?.warn?.("QUEUE", `CODEARTS | ${model} still refused after ${Math.round(budgetMs / 1000)}s of waiting`);
      return result;
    }
    log?.warn?.("QUEUE", `CODEARTS | ${model} refused, resend in ${retryInMs / 1000}s (${Math.round(remaining / 1000)}s left)`);
    await nap(retryInMs, signal);
  }
}

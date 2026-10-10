import { FETCH_CONNECT_TIMEOUT_MS } from "../config/runtimeConfig.js";

/**
 * Abort guard for the wait on response HEADERS.
 *
 * An upstream that completes the handshake and then goes silent holds the client
 * request, its socket and its account concurrency slot open until the OS gives up.
 * Every lane that calls fetch itself needs this; three of them hand-rolled their own
 * copy, which is why it lives here.
 *
 * The bound ends at headers — a legitimately slow job (image generation, a long
 * non-streaming completion) must not be cut off mid-body, so `clear()` runs as soon
 * as the response object exists.
 *
 * A caller-supplied signal is merged, never replaced: dropping it would unhook the
 * lane from client disconnects.
 */
export function connectTimeoutGuard(signal = null, timeoutMs = FETCH_CONNECT_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timeoutError = new Error("fetch connect timeout");
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort(timeoutError);
  }, timeoutMs);

  return {
    signal: signal ? AbortSignal.any([signal, ctrl.signal]) : ctrl.signal,
    get timedOut() { return timedOut; },
    clear() { clearTimeout(timer); },
    // Our own ceiling must not be reported as a client cancellation — chatCore maps
    // AbortError to 499 and skips the provider-error path, which would hide a dead
    // upstream instead of cooling the account down.
    settleError(error) { return timedOut ? timeoutError : error; },
  };
}

/**
 * fetch() bounded to the wait for response headers. See connectTimeoutGuard.
 */
export async function fetchWithConnectTimeout(url, init = {}, timeoutMs = FETCH_CONNECT_TIMEOUT_MS) {
  const guard = connectTimeoutGuard(init.signal, timeoutMs);
  try {
    return await fetch(url, { ...init, signal: guard.signal });
  } catch (error) {
    throw guard.settleError(error);
  } finally {
    guard.clear();
  }
}

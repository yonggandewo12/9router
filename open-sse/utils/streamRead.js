// Bounded reader for upstream streams that must not be trusted to keep moving.
// Shared by the executors that pre-read a response body (Kiro's integrity repair,
// Codex's transient-error peek): both run before pipeWithDisconnect arms its stall
// watchdog, so an unbounded reader.read() there is a request — and a socket — held
// open forever by an upstream that sends headers and then goes quiet.

export function makeAbortError(reason) {
  const error = new Error(reason?.message || reason || "Request aborted");
  error.name = "AbortError";
  return error;
}

export async function readWithTimeout(reader, signal, timeoutMs, message) {
  if (signal?.aborted) throw makeAbortError(signal.reason);
  let timeout;
  let abortHandler;
  const timeoutPromise = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  const abortPromise = new Promise((_, reject) => {
    abortHandler = () => reject(makeAbortError(signal.reason));
    signal?.addEventListener("abort", abortHandler, { once: true });
  });
  try {
    return await Promise.race([reader.read(), timeoutPromise, abortPromise]);
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener?.("abort", abortHandler);
  }
}

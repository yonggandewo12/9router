import { updateProviderConnection } from "@/lib/localDb";

// Round-robin rotation hints live in memory and reach SQLite coalesced in the
// background. Persisting them inline made account selection await a full-row
// read-merge-upsert, which is what forced the global selection mutex; with the
// write out of the critical section the pick is a synchronous, atomic decision.
const PERSIST_DEBOUNCE_MS = 250;

/**
 * connectionId → { lastUsedAt, consecutiveUseCount, timer }
 * @type {Map<string, { lastUsedAt: string, consecutiveUseCount: number, timer: NodeJS.Timeout|null }>}
 */
const rotationState = new Map();

export function rotationOf(connectionId) {
  const entry = rotationState.get(connectionId);
  if (!entry) return null;
  return { lastUsedAt: entry.lastUsedAt, consecutiveUseCount: entry.consecutiveUseCount };
}

/**
 * Record a use. The in-memory value is immediately visible to the next
 * selection, so concurrent callers rotate without waiting for the row.
 */
export function markUsed(connectionId, consecutiveUseCount, lastUsedAt = new Date().toISOString()) {
  if (!connectionId || connectionId === "noauth") return;
  const entry = rotationState.get(connectionId) || { lastUsedAt: null, consecutiveUseCount: 0, timer: null };
  entry.lastUsedAt = lastUsedAt;
  entry.consecutiveUseCount = consecutiveUseCount;
  rotationState.set(connectionId, entry);

  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => { persist(connectionId, entry); }, PERSIST_DEBOUNCE_MS);
  entry.timer.unref?.();
}

async function persist(connectionId, entry) {
  entry.timer = null;
  try {
    // updateProviderConnection merges into the stored JSON blob, so this cannot
    // clobber fields another writer changed while the write was deferred.
    const updated = await updateProviderConnection(connectionId, {
      lastUsedAt: entry.lastUsedAt,
      consecutiveUseCount: entry.consecutiveUseCount,
    });
    // Rotation is advisory: a vanished row or a failed write must not resurrect
    // stale state, and the next request re-reads the DB anyway.
    if (!updated && entry.timer === null && rotationState.get(connectionId) === entry) {
      rotationState.delete(connectionId);
    }
  } catch {
    if (entry.timer === null && rotationState.get(connectionId) === entry) rotationState.delete(connectionId);
  }
}

/**
 * Persist every pending rotation now. Awaits the same merge writes the debounce
 * would have issued, so shutdown and tests see deterministic state.
 */
export async function flushRotationState() {
  const pending = [];
  for (const [connectionId, entry] of rotationState) {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = null;
    pending.push(persist(connectionId, entry));
  }
  await Promise.all(pending);
}

// Timers are unref'd so a pending merge never holds the process open; beforeExit
// flushes whatever is still queued when the loop drains. SIGINT/SIGTERM are NOT
// handled: adding a listener for them replaces Node's default terminate, and a
// handler that only starts async work would leave Ctrl+C with a running server.
const flushHandler = () => {
  flushRotationState().catch(() => {});
};

function ensureShutdownHandler() {
  // HMR/dev reloads re-evaluate this module; drop any previous registration so
  // one process never flushes twice per exit.
  process.off("beforeExit", flushHandler);
  process.on("beforeExit", flushHandler);
}

ensureShutdownHandler();

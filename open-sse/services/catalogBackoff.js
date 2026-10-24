// Failure backoff for live model catalogs.
//
// /v1/models is polled by clients, and a connection whose catalog cannot be
// fetched (dead credential, revoked grant, upstream down) would otherwise pay
// one rejected round trip — and usually one log line — on every single poll,
// forever. Resolvers that throw are backed off at the route; resolvers that
// signal failure by returning null back themselves off here.
//
// Success clears the entry, so a recovered connection is re-probed on the next
// poll instead of waiting out the window.
const CATALOG_BACKOFF_MS = 10 * 60 * 1000;
const backoffUntil = new Map();

export function catalogFetchInBackoff(key) {
  const until = backoffUntil.get(key);
  if (!until) return false;
  if (until <= Date.now()) {
    backoffUntil.delete(key);
    return false;
  }
  return true;
}

export function noteCatalogFetchFailure(key) {
  const now = Date.now();
  // Entries are keyed by credential/connection ids that rotate, so sweep the
  // expired ones on write instead of letting them live for the process life.
  for (const [k, until] of backoffUntil) {
    if (until <= now) backoffUntil.delete(k);
  }
  backoffUntil.set(key, now + CATALOG_BACKOFF_MS);
}

export function clearCatalogFetchBackoff(key) {
  backoffUntil.delete(key);
}

/** Test-only. */
export function __resetCatalogBackoffForTest() {
  backoffUntil.clear();
}

export function getStatusVariant(isActive, effectiveStatus) {
  if (isActive === false) return "default";
  if (effectiveStatus === "active" || effectiveStatus === "success") return "success";
  if (effectiveStatus === "error" || effectiveStatus === "expired" || effectiveStatus === "unavailable") return "error";
  return "default";
}

/**
 * Whether the stored access token is past its expiry. testStatus alone goes
 * stale: it is written at login and only updated by request outcomes, so a
 * token that expired while idle kept showing "active" for weeks.
 */
export function isConnectionTokenExpired(connection, nowMs = Date.now()) {
  const raw = connection?.expiresAt;
  if (!raw) return false;
  const ms = new Date(raw).getTime();
  return Number.isFinite(ms) && ms <= nowMs;
}

/**
 * Effective badge status: cooldown-expired locks revert to active, and an
 * expired token overrides an otherwise-healthy status. Existing error states
 * (unavailable/error) keep precedence — they carry more information.
 */
export function getEffectiveStatus(connection, { isCooldown = false, isTokenExpired = false } = {}) {
  const base = connection?.testStatus === "unavailable" && !isCooldown ? "active" : connection?.testStatus;
  if (isTokenExpired && (!base || base === "active" || base === "success")) return "expired";
  return base;
}

/**
 * Identify providers that have connections configured, but ALL of them are deactivated (isActive === false).
 * Providers with 0 connections (e.g. keyless local nodes) are NOT considered deactivated.
 * @param {Array<{provider: string, isActive?: boolean}>} connections
 * @returns {Set<string>} Set of deactivated provider IDs
 */
export function getDeactivatedProviderIds(connections) {
  const byProvider = {};
  for (const c of connections || []) {
    if (!c?.provider) continue;
    if (!byProvider[c.provider]) byProvider[c.provider] = { total: 0, active: 0 };
    byProvider[c.provider].total += 1;
    if (c.isActive !== false) byProvider[c.provider].active += 1;
  }
  const deactivated = new Set();
  for (const [provider, stats] of Object.entries(byProvider)) {
    if (stats.total > 0 && stats.active === 0) {
      deactivated.add(provider);
    }
  }
  return deactivated;
}

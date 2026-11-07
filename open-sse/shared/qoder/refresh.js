/**
 * Qoder device-token refresh.
 *
 * The official client refreshes dt- tokens with a plain JSON POST to
 * {openapi}/api/v1/deviceToken/refresh — no COSY signing, no bearer header;
 * the refresh token rides in the body alongside the machine identity:
 *   { refresh_token, machine_id?, machine_token? }
 * machine_token is a UMID attestation the desktop SDK collects; the app omits
 * it when unavailable, so we send machine_id only. The response rotates both
 * tokens: { device_token, refresh_token, expires_at, refresh_token_expires_at }.
 *
 * (The old center-host /algo/api/v3/user/refresh_token endpoint answers 403 —
 * it is not the device-token flow.)
 */

import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { dedupRefresh } from "../../services/tokenRefresh/dedup.js";
import { qoderDeviceTokenRefreshUrl, qoderRegionOf, QODER_REGION_INTL } from "./constants.js";

/**
 * Upstream expiry hints arrive as RFC3339 strings or epoch numbers (seconds
 * or milliseconds). Mirror the app's parser: >1e12 is ms, smaller is seconds.
 * Returns Unix ms, or null when absent/unparseable.
 */
export function parseQoderExpiryMs(value) {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value > 1e12 ? Math.floor(value) : Math.floor(value * 1000);
  }
  if (typeof value === "string" && value.trim()) {
    const trimmed = value.trim();
    if (/^\d+$/.test(trimmed)) {
      const n = Number(trimmed);
      return n > 1e12 ? n : n * 1000;
    }
    const parsed = Date.parse(trimmed);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function normalizeMachineId(value) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed && trimmed !== "unknown" ? trimmed : "";
}

/**
 * Refresh a Qoder device token. Returns the merged-credential shape consumed
 * by mergeRefreshedCredentials / chatCore's onCredentialsRefreshed:
 *   { accessToken, refreshToken, expiresAt, providerSpecificData }
 * `false` = no refresh material for this lane (PAT / job-token / missing RT);
 * `null` = transient failure (retry); { error: "invalid_grant" } = the refresh
 * token is dead and re-login is the only way back.
 */
export async function refreshQoderDeviceToken(credentials, { log, proxyOptions = null, region, signal = null } = {}) {
  const refreshToken = credentials?.refreshToken;
  const accessToken = credentials?.accessToken || credentials?.apiKey || "";
  // Only the device lane refreshes here. PATs carry no stored RT, and job
  // tokens (jt-) refresh through jobToken/refresh with material we don't keep.
  if (!refreshToken || typeof refreshToken !== "string") return false;
  if (accessToken.startsWith("pt-") || accessToken.startsWith("jt-")) return false;

  const effRegion = region || qoderRegionOf(credentials?.provider) || QODER_REGION_INTL;
  const machineId = normalizeMachineId(credentials?.providerSpecificData?.machineId);

  return dedupRefresh(`qoder-${effRegion}`, refreshToken, async () => {
    const response = await proxyAwareFetch(
      qoderDeviceTokenRefreshUrl(effRegion),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "User-Agent": "qodercli/1.0.0",
        },
        body: JSON.stringify({
          refresh_token: refreshToken,
          ...(machineId ? { machine_id: machineId } : {}),
        }),
        signal,
      },
      proxyOptions,
    );

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      log?.warn?.("TOKEN_REFRESH", `qoder device refresh failed (HTTP ${response.status}): ${text.slice(0, 200)}`);
      if (response.status === 400 || response.status === 401 || response.status === 403) {
        return { error: "invalid_grant" };
      }
      return null;
    }

    const data = await response.json().catch(() => null);
    if (!data?.device_token) {
      log?.warn?.("TOKEN_REFRESH", "qoder device refresh returned no device_token");
      return null;
    }

    const expiresMs = parseQoderExpiryMs(data.expires_at);
    const refreshExpiresMs = parseQoderExpiryMs(data.refresh_token_expires_at);
    log?.info?.("TOKEN_REFRESH", "qoder device token refreshed", {
      region: effRegion,
      expiresAt: expiresMs ? new Date(expiresMs).toISOString() : null,
    });

    return {
      accessToken: data.device_token,
      refreshToken: data.refresh_token || refreshToken,
      ...(expiresMs ? { expiresAt: new Date(expiresMs).toISOString() } : {}),
      providerSpecificData: {
        ...(refreshExpiresMs ? { refreshTokenExpiresAt: new Date(refreshExpiresMs).toISOString() } : {}),
      },
    };
  }, log);
}
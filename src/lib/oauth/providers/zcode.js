import crypto from "crypto";
import { ZCODE_OAUTH_CONFIG } from "../constants/oauth.js";

// ZCode Start Plan OAuth — same CLI polling handshake as glm
// (zcode.z.ai/api/v1/oauth/cli/init → poll/ready), but the credential is the
// `token` field itself: it is the HS256 JWT the client stores as
// `zcodejwttoken` and sends to zcode-plan as `Authorization: Bearer`.
// There is no API-key minting step and no refresh grant — expiry means re-login.
const zcode = {
  config: ZCODE_OAUTH_CONFIG,
  flowType: "device_code",
  requestDeviceCode: async (config) => {
    const pollToken = crypto.randomBytes(32).toString("hex");
    const response = await fetch(config.cliInitUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${pollToken}`,
      },
      body: JSON.stringify({ provider: config.providerId || "zai" }),
    });
    if (!response.ok) {
      throw new Error(`ZCode OAuth init failed: ${await response.text()}`);
    }
    const payload = await response.json();
    if (!isSuccessCode(payload.code) || !payload.data) {
      throw new Error(payload.msg || "ZCode OAuth init returned no data");
    }
    const data = payload.data;
    if (!data.flow_id || !data.authorize_url) {
      throw new Error("ZCode OAuth init response missing flow_id/authorize_url");
    }
    return {
      device_code: data.flow_id,
      verification_uri: data.authorize_url,
      expires_in: relativeSeconds(data.expires_at) ?? 300,
      interval: data.poll_interval_sec || 3,
      _zcodePollToken: pollToken,
    };
  },
  pollToken: async (config, deviceCode, _codeVerifier, extraData) => {
    const pollToken = extraData?._zcodePollToken;
    if (!pollToken) {
      return {
        ok: true,
        data: {
          error: "access_denied",
          error_description: "Missing ZCode poll token — restart the login flow",
        },
      };
    }

    const response = await fetch(`${config.cliPollUrl}/${encodeURIComponent(deviceCode)}`, {
      headers: { Authorization: `Bearer ${pollToken}` },
    });
    if (!response.ok) {
      return {
        ok: true,
        data: {
          error: "access_denied",
          error_description: `ZCode poll failed (HTTP ${response.status})`,
        },
      };
    }

    const payload = await response.json();
    if (!isSuccessCode(payload.code)) {
      return {
        ok: true,
        data: { error: "access_denied", error_description: payload.msg || "ZCode poll failed" },
      };
    }

    const data = payload.data || {};
    if (data.status === "pending") return { ok: true, data: { error: "authorization_pending" } };
    if (data.status === "failed") {
      return {
        ok: true,
        data: {
          error: "access_denied",
          error_description: "ZCode authorization failed or was cancelled",
        },
      };
    }
    if (data.status !== "ready") {
      return {
        ok: true,
        data: { error: "authorization_pending", error_description: `Unknown status: ${data.status}` },
      };
    }

    const jwt = typeof data.token === "string" ? data.token.trim() : "";
    if (!jwt) {
      return {
        ok: true,
        data: { error: "access_denied", error_description: "ZCode poll response missing token" },
      };
    }

    return {
      ok: true,
      data: {
        access_token: jwt,
        _zcodeUser: data.user || {},
      },
    };
  },
  mapTokens: (tokens) => {
    const user = tokens._zcodeUser || {};
    const displayName = user.name || user.email || null;
    return {
      accessToken: tokens.access_token,
      refreshToken: null,
      email: user.email || null,
      ...(displayName ? { displayName } : {}),
      providerSpecificData: {
        authMethod: "cli_poll",
        username: user.name || undefined,
        userId: user.user_id || undefined,
        zcodeJwtToken: tokens.access_token,
      },
    };
  },
};

// Absolute epoch (s or ms) → seconds from now; null when absent/invalid.
// Same contract as glm's: upstream has sent both units historically.
function relativeSeconds(absoluteEpochSeconds) {
  const raw = Number(absoluteEpochSeconds);
  if (!Number.isFinite(raw) || raw <= 0) return null;
  const ms = raw > 1e12 ? raw : raw * 1000;
  const seconds = Math.floor((ms - Date.now()) / 1000);
  return seconds > 0 ? seconds : null;
}

// ZCode answers {code, msg, data}; code 0/200 (or absent) = success.
function isSuccessCode(code) {
  return code === undefined || code === null || code === 0 || code === 200 || code === "0" || code === "200";
}

export default zcode;

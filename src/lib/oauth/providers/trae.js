import crypto from "crypto";
import { TRAE_CONFIG } from "../constants/oauth.js";
import { extractJsonPath } from "./_shared.js";

// ───────────────────────────────────────────────────────────────────────────
// Trae (ByteDance) OAuth helpers — shared by consumer Trae (marscode) and
// Trae Enterprise (console.enterprise.trae.cn).
//
// Both sites run the same device flow:
//   GetLoginGuidance → /authorization consent → local callback carrying a
//   refresh token → ExchangeToken → Cloud-IDE-JWT (≈14 days) → GetUserInfo.
// What differs is hostnames, the JSON envelope around responses (consumer
// `Result.*` vs enterprise `Data.*`), the callback's parameter names, and the
// identity values the chat API expects — all carried by `config`.
// ───────────────────────────────────────────────────────────────────────────

// Response payloads: consumer Trae wraps in Result.*, enterprise in Data.*.
const ACCESS_TOKEN_PATHS = [
  ["Result", "AccessToken"], ["Result", "accessToken"], ["Data", "Token"], ["Data", "AccessToken"],
  ["accessToken"], ["access_token"], ["token"],
];
const REFRESH_TOKEN_PATHS = [
  ["Result", "RefreshToken"], ["result", "refresh_token"], ["Data", "RefreshToken"],
  ["refreshToken"], ["refresh_token"],
];
const EXPIRES_AT_PATHS = [
  ["Result", "ExpiresAt"], ["Result", "expiresAt"], ["result", "expires_at"],
  ["Data", "TokenExpireAt"], ["Data", "ExpiresAt"], ["expiresAt"], ["expires_at"],
];
const USER_EMAIL_PATHS = [
  ["Result", "NonPlainTextEmail"], ["Result", "Email"], ["Result", "email"],
  ["Data", "UserInfo", "Email"], ["Data", "UserInfo", "Account"],
  ["email"], ["data", "email"],
];
const USER_NAME_PATHS = [
  ["Result", "ScreenName"], ["Result", "Nickname"], ["Result", "Name"],
  ["Data", "UserInfo", "Name"], ["result", "nickname"], ["nickname"], ["name"],
];
const USER_ID_PATHS = [
  ["Result", "UserID"], ["Result", "userId"], ["Data", "UserInfo", "UserID"], ["userId"], ["user_id"],
];
// AIRegion ("SG"/"US") drives the SOLO scope; Region is a separate wire field.
const USER_AI_REGION_PATHS = [["Result", "AIRegion"], ["Result", "aiRegion"], ["Data", "UserInfo", "AIRegion"], ["aiRegion"]];
const USER_REGION_PATHS = [["Result", "Region"], ["Result", "region"], ["Data", "UserInfo", "Region"], ["region"]];

export function createTraeProvider(config) {
  const cfg = { requireLoginHost: true, identityDefaults: {}, ...config };
  // Identity fields the chat API's common_params echoes back. Consumer Trae is
  // a marscode SaaS user; enterprise is a tenant member (see registry entry).
  const defs = { tenant: "marscode", region: "US-East", userIdentity: "Free", ...cfg.identityDefaults };

  // Per-login device context. No IDE access in 9router, so use stable defaults.
  function buildDeviceContext() {
    return {
      plugin_version: cfg.defaultPluginVersion,
      machine_id: crypto.randomUUID(),
      device_id: cfg.defaultDeviceId,
      x_device_brand: "unknown",
      x_device_type: "unknown",
      x_os_version: "unknown",
      x_env: "",
      x_app_version: defs.appVersion || cfg.defaultAppVersion,
      x_app_type: cfg.defaultAppType,
    };
  }

  // POST GetLoginGuidance → { Result: { LoginHost } }
  async function fetchLoginGuidance(loginTraceId) {
    const body = JSON.stringify({ loginTraceID: loginTraceId, login_trace_id: loginTraceId });
    let lastErr = "no successful response";
    for (const url of cfg.loginGuidanceUrls) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            "User-Agent": cfg.userAgent,
          },
          body,
        });
        if (!res.ok) { lastErr = `${url} HTTP ${res.status}`; continue; }
        const data = await res.json();
        const loginHost = extractJsonPath(data, [
          ["Result", "LoginHost"], ["Result", "loginHost"], ["Result", "LoginURL"],
          ["result", "loginHost"], ["data", "Result", "LoginHost"], ["data", "loginHost"],
          ["Data", "LoginHost"], ["LoginHost"], ["loginHost"],
        ]);
        if (loginHost) return loginHost;
        lastErr = `${url} missing LoginHost`;
      } catch (e) { lastErr = `${url} ${e.message}`; }
    }
    // Not a throw: buildAuthUrl() is the only consumer of loginHost, while
    // exchangeTokens() re-runs prepareConfig() after the browser flow already
    // succeeded — guidance flakiness must not destroy a completed login.
    return { error: `Trae GetLoginGuidance failed: ${lastErr}` };
  }

  // Build the browser verification URL the user opens to sign in.
  function buildVerificationUrl(loginHost, loginTraceId, callbackUrl, ctx) {
    const url = new URL(loginHost.startsWith("http") ? loginHost : `https://${loginHost.replace(/^\/+/, "")}`);
    url.pathname = cfg.authorizationPath;
    const p = new URLSearchParams();
    p.set("login_version", "1");
    p.set("auth_from", "trae");
    p.set("login_channel", "native_ide");
    p.set("plugin_version", ctx.plugin_version);
    p.set("auth_type", "local");
    p.set("client_id", cfg.clientId);
    p.set("redirect", "0");
    p.set("login_trace_id", loginTraceId);
    p.set("auth_callback_url", callbackUrl);
    p.set("machine_id", ctx.machine_id);
    p.set("device_id", ctx.device_id);
    p.set("x_device_id", ctx.device_id);
    p.set("x_machine_id", ctx.machine_id);
    p.set("x_device_brand", ctx.x_device_brand);
    p.set("x_device_type", ctx.x_device_type);
    p.set("x_os_version", ctx.x_os_version);
    p.set("x_env", ctx.x_env);
    p.set("x_app_version", ctx.x_app_version);
    p.set("x_app_type", ctx.x_app_type);
    url.search = p.toString();
    return url.toString();
  }

  // Parse the Trae OAuth callback (query string or full URL).
  //   consumer:     ?isRedirect=true&refreshToken=...&loginHost=...[&x-cloudide-token=...]
  //   enterprise:   ?isRedirect=true&host=...&userJwt={"RefreshToken":...,"Token":...}
  function parseCallback(raw) {
    const text = String(raw || "").trim();
    let queryStr = text;
    if (text.includes("?")) queryStr = text.slice(text.indexOf("?") + 1);
    if (text.startsWith("#")) queryStr = text.slice(1);
    const params = Object.fromEntries(new URLSearchParams(queryStr));
    const pick = (keys) => {
      for (const k of keys) { const v = params[k]; if (v && String(v).trim()) return String(v).trim(); }
      return null;
    };
    const err = pick(["error", "error_code", "errorCode"]);
    if (err) {
      const desc = pick(["error_description", "error_desc", "message"]);
      throw new Error(desc ? `Trae auth failed: ${err} (${desc})` : `Trae auth failed: ${err}`);
    }
    // The enterprise consent page hands back a JSON blob instead of flat params.
    let userJwt = null;
    const rawJwt = pick(["userJwt", "user_jwt"]);
    if (rawJwt) { try { userJwt = JSON.parse(rawJwt); } catch { userJwt = null; } }
    const fromJwt = (keys) => {
      if (!userJwt) return null;
      for (const k of keys) { const v = userJwt[k]; if (v && String(v).trim()) return String(v).trim(); }
      return null;
    };
    const refreshToken = pick(["refreshToken", "refresh_token", "RefreshToken"]) || fromJwt(["RefreshToken", "refreshToken"]);
    if (!refreshToken) throw new Error("Trae callback missing refreshToken");
    const loginHost = pick(["loginHost", "login_host", "LoginHost", "host", "consoleHost", "coreHost"]);
    if (!loginHost && cfg.requireLoginHost) throw new Error("Trae callback missing loginHost");
    const cloudideToken = pick(["x-cloudide-token", "xCloudideToken", "accessToken", "access_token", "token"]);
    return { refreshToken, loginHost, cloudideToken };
  }

  // Allowed API origins for ExchangeToken/GetUserInfo — hardcoded HTTPS allowlist only.
  // loginHost from the callback is intentionally NOT honored (SSRF guard: a callback
  // attacker could otherwise point this at internal hosts/cloud metadata).
  function apiOrigins() {
    return [...cfg.apiOrigins];
  }

  // POST ExchangeToken {ClientID, RefreshToken, ClientSecret, UserID}
  //  → { Result: { AccessToken, ... } } | { Data: { Token, ... } }
  async function fetchExchangeToken(refreshToken, cloudideToken) {
    const body = JSON.stringify({
      ClientID: cfg.clientId,
      RefreshToken: refreshToken,
      ClientSecret: cfg.clientSecret,
      UserID: "",
    });
    let lastErr = "no successful response";
    for (const origin of apiOrigins()) {
      const url = `${origin.replace(/\/$/, "")}${cfg.exchangeTokenPath}`;
      try {
        const headers = {
          Accept: "application/json",
          "Content-Type": "application/json",
          "User-Agent": cfg.userAgent,
        };
        if (cloudideToken) headers["x-cloudide-token"] = cloudideToken;
        const res = await fetch(url, { method: "POST", headers, body });
        const text = await res.text();
        if (!res.ok) { lastErr = `${url} HTTP ${res.status}`; continue; }
        let data; try { data = JSON.parse(text); } catch { lastErr = `${url} invalid JSON`; continue; }
        const accessToken = extractJsonPath(data, ACCESS_TOKEN_PATHS);
        if (!accessToken) {
          const msg = extractJsonPath(data, [["message"], ["msg"], ["error"], ["Result", "Message"], ["Data", "Message"]]) || "missing AccessToken";
          lastErr = `${url} ${msg}`;
          continue;
        }
        return {
          accessToken,
          refreshToken: extractJsonPath(data, REFRESH_TOKEN_PATHS) || refreshToken,
          expiresIn: null, // ExchangeToken returns an absolute expiry, converted below
          expiresAt: extractJsonPath(data, EXPIRES_AT_PATHS),
        };
      } catch (e) { lastErr = `${url} ${e.message}`; }
    }
    throw new Error(`Trae ExchangeToken failed: ${lastErr}`);
  }

  // POST GetUserInfo with x-cloudide-token → identity fields used by SOLO common_params.
  async function fetchUserInfo(accessToken) {
    for (const origin of apiOrigins()) {
      const url = `${origin.replace(/\/$/, "")}${cfg.getUserInfoPath}`;
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            "User-Agent": cfg.userAgent,
            "x-cloudide-token": accessToken,
          },
          body: JSON.stringify({}),
        });
        if (!res.ok) continue;
        const data = await res.json();
        return {
          email: extractJsonPath(data, USER_EMAIL_PATHS),
          name: extractJsonPath(data, USER_NAME_PATHS),
          aiRegion: extractJsonPath(data, USER_AI_REGION_PATHS),
          region: extractJsonPath(data, USER_REGION_PATHS),
          userId: extractJsonPath(data, USER_ID_PATHS),
          // Enterprise: UserInfo.TenantID is the numeric tenant id, which is NOT
          // what common_params.tenant wants (that stays `defs.tenant`).
          tenantId: extractJsonPath(data, [["Result", "TenantID"], ["Data", "UserInfo", "TenantID"], ["tenantId"]]),
        };
      } catch { /* try next origin */ }
    }
    return { email: null, name: null };
  }

  // Map AIRegion (e.g. "SG", "US") → SOLO scope used in common_params.
  function scopeForRegion(aiRegion) {
    const r = (aiRegion || "").toLowerCase();
    if (r === "sg" || r.includes("singapore")) return "marscode-sg";
    if (r === "cn" || r.includes("cn") || r.includes("china")) return "marscode-cn";
    return "marscode-us";
  }

  // Trae — browser OAuth: GetLoginGuidance → verification URL
  // → local callback (refreshToken) → ExchangeToken → GetUserInfo.
  // state === config.loginTraceID so the proxy can match the callback.
  return {
    config: cfg,
    flowType: "authorization_code",
    callbackPath: cfg.callbackPath,
    prepareConfig: async () => {
      const loginTraceID = crypto.randomUUID();
      const loginHost = await fetchLoginGuidance(loginTraceID);
      return { ...cfg, loginTraceID, loginHost };
    },
    buildAuthUrl: (config, redirectUri, state) => {
      // A guidance failure surfaces as { error } — hard-fail only here, the
      // one place that actually needs the host (the authorize step).
      if (typeof config.loginHost !== "string") {
        throw new Error(config.loginHost?.error || "Trae GetLoginGuidance returned no LoginHost");
      }
      const ctx = buildDeviceContext();
      const traceId = config.loginTraceID || state;
      return buildVerificationUrl(config.loginHost, traceId, redirectUri, ctx);
    },
    exchangeToken: async (config, code) => {
      const trimmed = String(code || "").trim();
      // A raw Cloud-IDE-JWT never carries a query/fragment, so anything
      // shaped like a redirect target is a callback and must fail loudly —
      // otherwise the whole URL gets stored as a bogus token and every chat
      // 401s later.
      const looksCallback = trimmed.includes("?") || trimmed.startsWith("#");
      if (!looksCallback) {
        // Strip "Cloud-IDE-JWT " / "Bearer " prefix users paste from the Authorization header
        const clean = trimmed.replace(/^(Cloud-IDE-JWT|Bearer)\s+/i, "");
        return { accessToken: clean, refreshToken: null, expiresIn: cfg.tokenLifetimeDays * 24 * 60 * 60, _authMethod: "imported" };
      }
      const { refreshToken, cloudideToken } = parseCallback(trimmed);
      return { ...(await fetchExchangeToken(refreshToken, cloudideToken)), _authMethod: "oauth" };
    },
    postExchange: async (tokens) => {
      const userInfo = await fetchUserInfo(tokens.accessToken);
      return { userInfo };
    },
    mapTokens: (tokens, extra) => {
      // Trae hands back an absolute expiry, in seconds on the consumer site and
      // in milliseconds on the enterprise one — normalize before differencing.
      const rawExpiry = Number(tokens.expiresAt);
      const expirySec = Number.isFinite(rawExpiry)
        ? (rawExpiry > 1e12 ? Math.floor(rawExpiry / 1000) : rawExpiry)
        : Math.floor(new Date(tokens.expiresAt || 0).getTime() / 1000);
      const expiresIn = tokens.expiresIn
        || (Number.isFinite(expirySec) && expirySec > 0
          ? Math.max(60, expirySec - Math.floor(Date.now() / 1000))
          : null)
        || cfg.tokenLifetimeDays * 24 * 60 * 60;
      const ui = extra?.userInfo || {};
      const pinned = cfg.identityDefaults || {};
      // Enterprise pins its tenant region/scope (a mismatched AIRegion from
      // GetUserInfo makes the remote-agent API reject the session); consumer
      // Trae mirrors whatever the account reports.
      const aiRegion = pinned.region || ui.aiRegion || defs.region;
      // Enterprise pins its region outright; consumer keeps whatever the account
      // reports, since SOLO echoes Region separately from AIRegion.
      const region = pinned.region || ui.region || aiRegion;
      // SOLO common_params defaults — identity fields web_id/biz_user_id are not
      // exposed by GetUserInfo; empty strings are accepted upstream (verified).
      return {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresIn,
        email: ui.email || undefined,
        displayName: ui.name || undefined,
        providerSpecificData: {
          authMethod: tokens._authMethod || "oauth",
          aiRegion,
          region,
          tenant: defs.tenant,
          tenantId: ui.tenantId || undefined,
          userId: ui.userId || "",
          scope: pinned.scope || scopeForRegion(aiRegion),
          webId: "",
          bizUserId: "",
          // GetUserInfo's UserID is not what common_params.user_unique_id
          // expects; empty is what both sites accept (verified live).
          userUniqueId: "",
          appLanguage: "en",
          appVersion: defs.appVersion || cfg.defaultAppVersion,
          userRegion: aiRegion === "SG" ? "SG" : "US",
          userIdentity: defs.userIdentity,
        },
      };
    },
  };
}

export default createTraeProvider(TRAE_CONFIG);

// Trae Enterprise (ByteDance TRAE 企业版) provider registry entry.
//
// Same SOLO remote-agent protocol as consumer Trae (`trae`), served from the
// tenant's enterprise host:
//   POST {base}/chat_sessions → {data:{chat_session_id, message_id}}
//   GET  {base}/chat_sessions/{id}/events?reply_to_message_id=... → SSE
//   Auth: Authorization: Cloud-IDE-JWT <jwt>
//
// Login is the browser device flow, identical in shape to consumer Trae with a
// different host: GetLoginGuidance → /authorization consent → callback
// refreshToken → ExchangeToken → 14-day Cloud-IDE-JWT.
//
// The console's "CLI 登录令牌" (trae-lt-...) is deliberately NOT wired up as an
// auth mode — see the note in shared/trae/enterprise.js.
const API_HOST = "https://console.enterprise.trae.cn";
const EXCHANGE_URL = `${API_HOST}/cloudide/api/v3/trae/oauth/ExchangeToken`;
export default {
  id: "trae-enterprise",
  alias: "te",
  uiAlias: "te",
  category: "oauth",
  authType: "oauth",
  hasOAuth: true,
  authModes: ["oauth"],
  display: {
    name: "Trae Enterprise",
    icon: "bolt",
    color: "#FF6A00",
    textIcon: "TE",
    website: API_HOST,
    notice: {
      signupUrl: `${API_HOST}/personal/account`,
    },
  },
  transport: {
    baseUrl: `${API_HOST}/api/remote/v1`,
    format: "openai",
    headers: {
      "X-Trae-Client-Type": "web",
      "X-Preferenced-Language": "en",
      "Referer": `${API_HOST}/`,
    },
    auth: {
      combined: true,
      header: "Authorization",
      scheme: "Cloud-IDE-JWT",
    },
  },
  oauth: {
    clientId: "ono9krqynydwx5",
    clientSecret: "-",
    platform: "trae",
    // Enterprise console host serves the same /cloudide/api/v3/trae/* backend
    // as consumer marscode's api.marscode.com.
    loginGuidanceUrls: [`${API_HOST}/cloudide/api/v3/trae/GetLoginGuidance`],
    // Hardcoded HTTPS allowlist for ExchangeToken/GetUserInfo (SSRF guard:
    // the loginHost echoed by the callback is never trusted).
    apiOrigins: [API_HOST],
    exchangeTokenPath: "/cloudide/api/v3/trae/oauth/ExchangeToken",
    getUserInfoPath: "/cloudide/api/v3/trae/GetUserInfo",
    // Absolute forms — tokenUrl/exchangeTokenUrl/refreshUrl are what the engine
    // and tokenRefresh read (same shape as the consumer `trae` entry).
    tokenUrl: EXCHANGE_URL,
    exchangeTokenUrl: EXCHANGE_URL,
    refreshUrl: EXCHANGE_URL,
    userInfoUrl: `${API_HOST}/cloudide/api/v3/trae/GetUserInfo`,
    refresh: { encoding: "json" },
    authorizationPath: "/authorization",
    callbackPath: "/callback",
    webUrl: API_HOST,
    // Enterprise GETUserInfo/ExchangeToken wrap payloads in Data.*, not Result.*
    responseEnvelope: "Data",
    // The enterprise callback carries host/consoleHost/coreHost instead of
    // loginHost, and loginHost is never used for API calls → not required.
    requireLoginHost: false,
    // Per-tenant identity defaults (consumer Trae uses marscode/US-East).
    identityDefaults: {
      tenant: "tob_online",
      scope: "saas",
      region: "cn-beijing",
      userIdentity: "member",
      appVersion: "3.5.54",
    },
    // Static fallback catalog; the live tenant catalog is fetched per account.
    modelsUrl: `${API_HOST}/api/remote/v1/models`,
  },
  // Model catalog verified live on 2026-09-20 (solo_coder group). `auto` sends
  // model_selection_strategy=auto with an empty model_name.
  models: [
    { id: "auto", name: "Auto (Server Picks)" },
    { id: "Doubao-Seed-2.0-Code", name: "Doubao-Seed-2.0-Code" },
    { id: "Doubao_1_6", name: "Doubao-Seed-Code" },
    { id: "glm-5.1", name: "GLM-5.1" },
    { id: "glm-5v-turbo", name: "GLM-5V-Turbo" },
    { id: "minimax-m2.7", name: "MiniMax-M2.7" },
    { id: "deepseek-V4-Pro", name: "DeepSeek-V4-Pro" },
    { id: "DeepSeek-V4-Flash", name: "DeepSeek-V4-Flash" },
    { id: "custom_gemini-3", name: "Gemini-3.1-Pro-Preview" },
  ],
  // No usage API reachable with a Cloud-IDE-JWT (the console quota endpoints
  // need the browser session cookie), so the dashboard hides the quota panel.
  features: { usage: false },
};

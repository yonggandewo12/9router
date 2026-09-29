// DevEco Code (华为 DevEco Code CLI) provider registry entry.
//
// DevEco Code is a fork of opencode; its inference goes through Huawei's MaaS
// gateway in plain OpenAI-compatible format:
//   POST https://cn.devecostudio.huawei.com/sse/codeGenie/maas/v2/chat/completions
//        Authorization: Bearer <opaque-access-token>
//        Chat-Id: <32-hex-per-conversation>
//        lang: en
//
// Auth flow (HUAWEI ID):
//   1. Browser → /console/DevEcoIDE/apply?port=<loopback>&appid=1008&code=<state>
//   2. Callback → tempToken + siteId
//   3. GET /authrouter/auth/api/temptoken/check → jwtToken
//   4. GET /authrouter/auth/api/jwToken/check (header jwtToken) → accessToken
//   Token TTL ~30 min; refresh via same endpoint + refresh:"true" header.
//
// URLs are kept side-effect-free (no imports from auth modules) per registry convention.
const BASE = "https://cn.devecostudio.huawei.com";
const MaaS_CHAT = `${BASE}/sse/codeGenie/maas/v2/chat/completions`;

export default {
  id: "deveco",
  alias: "dv",
  uiAlias: "dv",
  category: "oauth",
  authType: "oauth",
  hasOAuth: true,
  authModes: ["oauth"],
  hasFree: true,
  display: {
    name: "DevEco Code",
    icon: "code",
    color: "#C7000B",
    textIcon: "DV",
    website: "https://devecostudio.huawei.com",
    notice: {
      signupUrl: `${BASE}/console/DevEcoIDE/apply`,
    },
  },
  transport: {
    baseUrl: MaaS_CHAT,
    format: "openai",
    forceStream: true,
    headers: {
      lang: "en",
    },
  },
  oauth: {
    baseUrl: BASE,
    // The portal POSTs the login fields to http://127.0.0.1:<port>/callback
    // (CLI: callbackPath="/callback"; "/" alone 404s the real callback).
    callbackPath: "/callback",
    appId: "1008",
    authorizeUrl: `${BASE}/console/DevEcoIDE/apply`,
    tempTokenCheckUrl: `${BASE}/authrouter/auth/api/temptoken/check`,
    jwtTokenCheckUrl: `${BASE}/authrouter/auth/api/jwToken/check`,
    successRedirectPath: "console/DevEcoCode/loginSuccess",
    failedRedirectPath: "console/DevEcoCode/loginFailed",
    // TTL/region/wire params live in shared/deveco/auth.js (single source):
    // accessToken 30 min, site=CN, version=1.0.0.
    refreshLeadMs: 300000,
    // The CLI waits 600s for the browser callback before giving up.
    oauthTimeoutMs: 600000,
  },
  models: [
    {
      id: "GLM-5.1",
      name: "GLM-5.1 Free",
      contextLength: 170000,
      maxOutputTokens: 32000,
    },
    {
      id: "GLM-5.3",
      name: "GLM-5.3 Free",
      contextLength: 170000,
      maxOutputTokens: 32000,
      reasoning: true,
    },
    {
      id: "Qwen3_VL_235B_A22B_Instruct",
      name: "Qwen3 VL 235B (Vision)",
      contextLength: 32768,
      maxOutputTokens: 8192,
      capabilities: { vision: true },
    },
  ],
  serviceKinds: ["llm"],
  passthroughModels: false,
  features: { usage: false },
};

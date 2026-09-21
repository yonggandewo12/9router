// CodeArts (华为云码道) provider registry entry.
//
// Chat is OpenAI-shaped, but the snap-access gateway authenticates with a
// Huawei request signature instead of a token:
//   POST https://sts.cn-north-4.myhuaweicloud.com/v1/oauth2/tokens
//        (PKCE code + DPoP proof) → temporary AK/SK + security_token (~1h)
//   POST {snap}/api/v2/chat/completions   Authorization: SDK-HMAC-SHA256 …
//
// So `transport` declares no `auth` descriptor at all — CodeartsExecutor signs
// every request in buildHeaders (open-sse/executors/codearts.js), and the AK/SK
// lives in providerSpecificData, not in apiKey/accessToken.
//
// The browser login is the CLI's own loopback flow (portal/authorize + PKCE +
// a 127.0.0.1 callback); 9router reproduces it in src/lib/oauth/providers/codearts.js.
const PORTAL_BASE = "https://codearts.huaweicloud.com/portal";
const STS_BASE = "https://sts.cn-north-4.myhuaweicloud.com";
const API_BASE = "https://snap-access.cn-north-4.myhuaweicloud.com";
const TOKEN_URL = `${STS_BASE}/v1/oauth2/tokens`;

export default {
  id: "codearts",
  alias: "ca",
  uiAlias: "ca",
  category: "oauth",
  authType: "oauth",
  hasOAuth: true,
  authModes: ["oauth"],
  display: {
    name: "CodeArts",
    icon: "code",
    color: "#C7000B",
    textIcon: "CA",
    website: "https://codearts.huaweicloud.com",
    notice: {
      signupUrl: `${PORTAL_BASE}/settings/cli-auth`,
    },
  },
  transport: {
    baseUrl: `${API_BASE}/api/v2/chat/completions`,
    format: "openai",
    headers: { "User-Agent": "codearts/26.9.3" },
  },
  oauth: {
    clientId: "CodeArts_Tui",
    authorizeUrl: `${PORTAL_BASE}/authorize`,
    tokenUrl: TOKEN_URL,
    refreshUrl: TOKEN_URL,
    stsBase: STS_BASE,
    callbackPath: "/oauth/callback",
    // Portal rejects "S256"; the CLI sends this literal spelling.
    codeChallengeMethod: "SHA-256",
    // Sent as `locale` on the authorize URL and the post-login portal redirect.
    locale: "zh-cn",
    // Refresh needs the login's DPoP key + x-agent-user-account, so it is NOT the
    // generic form grant — handlers live in refreshCodeartsFromCredentials().
    // CLI parity: re-mint at 10 min before expiry (its VW() threshold).
    refreshLeadMs: 600000,
    // The CLI waits 300s for the browser callback before giving up.
    oauthTimeoutMs: 300000,
    portalBase: PORTAL_BASE,
    apiBase: API_BASE,
    userInfoUrl: `${API_BASE}/snap-manager/v1/current/user`,
    modelsUrl: `${API_BASE}/v1/agent-center/agents/detail`,
    // The published agent whose model list the CLI reads.
    agentId: "a8bcb36232554267a5142361cc25a393",
  },
  // Catalog verified live on 2026-09-20 (cn-north-4, personal station). A chat
  // call is refused with 400 TM.00001041 once the account's 3 concurrent
  // sessions are taken — CodeartsExecutor then resends until one frees
  // (shared/codearts/sessionCap.js).
  models: [
    { id: "GLM-5.2", name: "GLM-5.2", contextLength: 202752 },
    { id: "GLM-5.2-ArkTS-SPARK", name: "GLM-5.2 ArkTS SPARK" },
    { id: "OpenPangu-2.0-Pro", name: "OpenPangu 2.0 Pro", contextLength: 524288 },
    { id: "OpenPangu-2.0-Flash", name: "OpenPangu 2.0 Flash", contextLength: 524288 },
  ],
  // No quota/usage endpoint is reachable with a temporary AK/SK.
  features: { usage: false },
};

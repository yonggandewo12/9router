// ZCode (Zhipu's coding client) Start Plan lane.
//
// The client's own plan traffic does not go to api.z.ai: `account:zai-start-plan`
// in ZCode's builtin provider rules points at
//   https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages
// (Claude wire format) and authenticates with the short HS256 JWT the CLI OAuth
// flow returns as `data.token` (stored locally as `zcodejwttoken`), NOT with an
// API key. Live-verified 2026-10-23 against a logged-in Start Plan account:
//   - Azure-style headers (x-api-key, X-ZCode-Authorization) → 401
//   - Authorization: Bearer <jwt> → passes, provided the system prompt is the
//     official ZCode agent prompt (see executors/zcode.js)
//   - allowed models: GLM-5.3, GLM-5.3-Flash (5.2 / 5-Turbo answer 3006)
// The coding-plan API key lane stays on the `glm` provider.
const BASE = "https://zcode.z.ai/api/v1";

export default {
  id: "zcode",
  priority: 138,
  alias: "zcode",
  aliases: ["zcode-plan", "zc"],
  uiAlias: "zc",
  category: "oauth",
  authType: "oauth",
  hasOAuth: true,
  authModes: ["oauth", "apikey"],
  display: {
    name: "ZCode Start Plan",
    icon: "code",
    color: "#1D4ED8",
    textIcon: "ZC",
    website: "https://zcode.z.ai",
    notice: {
      text: "Log in with the Z.ai account that owns a ZCode Start Plan; the CLI OAuth JWT is used as the credential.",
      signupUrl: "https://zcode.z.ai",
    },
  },
  transport: {
    baseUrl: `${BASE}/zcode-plan/anthropic/v1/messages`,
    format: "claude",
    auth: {
      combined: true,
      header: "Authorization",
      scheme: "bearer",
    },
  },
  // Same CLI polling flow as glm (no PKCE, no callback): init mints a poll
  // token, poll/ready returns `token` — that token IS the credential here.
  oauth: {
    providerId: "zai",
    cliInitUrl: `${BASE}/oauth/cli/init`,
    cliPollUrl: `${BASE}/oauth/cli/poll`,
  },
  models: [
    { id: "GLM-5.3-Flash", name: "GLM-5.3 Flash", contextLength: 1000000 },
    { id: "GLM-5.3", name: "GLM-5.3", contextLength: 1000000, reasoning: true },
  ],
};

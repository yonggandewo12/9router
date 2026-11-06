export default {
  id: "codebuddy-cn",
  // Short model prefix (cbcn/glm-5.2). "cbcn" = CodeBuddy CN; reserve "cbai"
  // for a future codebuddy-ai (intl) provider. The full id still resolves.
  alias: "cbcn",
  uiAlias: "cbcn",
  hidden: false,
  priority: 90,
  display: {
    name: "CodeBuddy CN",
    icon: "smart_toy",
    color: "#006EFF",
    website: "https://copilot.tencent.com",
    notice: {
      signupUrl: "https://copilot.tencent.com",
    },
  },
  category: "oauth",
  authModes: ["oauth", "apikey"],
  hasOAuth: true,
  transport: {
    baseUrl: "https://copilot.tencent.com/v2/chat/completions",
    forceStream: true,
    // CodeBuddy is a unified OpenAI-compatible gateway: every model (GLM, Kimi,
    // MiniMax, DeepSeek, Hunyuan) takes reasoning via OpenAI-style reasoning_effort,
    // not its vendor-native thinking shape. Force the openai thinking format.
    thinkingFormat: "openai",
    headers: {
      "User-Agent": "CLI/2.108.1 CodeBuddy/2.108.1",
      "X-Product": "SaaS",
      "X-IDE-Type": "CLI",
      "X-IDE-Name": "CLI",
      "x-requested-with": "XMLHttpRequest",
      "x-codebuddy-request": "1",
    },
    auth: {
      combined: true,
      header: "Authorization",
      scheme: "bearer",
      // Channel check requires the plugin's request/conversation ids — without
      // them upstream rejects with 400 / 11128 "request illegal".
      hooks: ["codebuddyHeaders"],
    },
    // Quota endpoint differs from the chat gateway: POST returns nested Tencent
    // billing payload (data.Response.Data.Accounts[]). See services/usage/codebuddy-cn.js.
    usage: {
      url: "https://copilot.tencent.com/v2/billing/meter/get-user-resource",
    },
  },
  models: [
    { id: "glm-5.2", name: "GLM-5.2" },
    // glm-5.1 dropped 2026-11-06: it is absent from the account's /v3/config table and a
    // bare request 400s with code 11150 ("the reasoning effort value is not supported by
    // the current model") — it only answers once reasoning_effort is sent, which a plain
    // OpenAI client never does. Keeping it published meant a selectable id that 400'd.
    { id: "minimax-m3", name: "MiniMax-M3" },
    // Catalog mirrors the server's product-config payload. That payload has a
    // real address — GET {baseUrl}/console/enterprises/{enterpriseId}/config/models,
    // which the plugin's own logs call "product configuration" — but it is
    // gated: it needs a token whose `enterprise_id` JWT claim is populated
    // (an ultimate/team account). A personal account's token carries an empty
    // claim and the call answers 403 not_authorized, and the web console's own
    // session cookies do not authorize the path either (401 from the APISIX
    // front, while /console/account on the same cookies returns 200). So this
    // list cannot be refreshed automatically for personal accounts and stays
    // manual. Models the server no longer publishes are
    // removed even when the chat endpoint still answers them — the published
    // list is the contract. Drop log: glm-5.0 / glm-4.7 and hy4-preview-x
    // (endpoint returns 11102 "model service info not found"), plus
    // glm-5.0-turbo / minimax-m2.7 / kimi-k2.5 / hy3-preview /
    // deepseek-v3-2-volc (absent from the server list, though still answering
    // 200), glm-5v-turbo / kimi-k2.7 / kimi-k2.6 (absent from the server list
    // since the 2026-09-30 snapshot, replaced by kimi-k2.8-preview), and
    // deepseek-v4-flash (replaced server-side by deepseek-v4.1-flash, then
    // re-listed briefly — kept out; endpoint still answers 200 but the list
    // is the contract). hy3-x is the paid tier of hy3 and stays excluded.
    // "-x" suffix = paid tier of the same model (free id rides the promo quota).
    { id: "hy3", name: "Hy3" },
    { id: "hy4-preview", name: "Hy4-Preview" },
    { id: "glm-5.3", name: "GLM-5.3" },
    { id: "glm-5.3-flash", name: "GLM-5.3-Flash" },
    { id: "kimi-k3-1", name: "Kimi-K3" },
    { id: "kimi-k2.8-preview", name: "Kimi-K2.8-Preview" },
    { id: "deepseek-v4-pro", name: "DeepSeek-V4-Pro" },
    { id: "deepseek-v4.1-flash", name: "DeepSeek-V4.1-Flash" },
    // Gateway-side routers, not fixed models: the server picks the backend per
    // request and echoes it in the streamed `model` field — and the pick is not
    // stable across calls. Typical answers, re-probed 2026-11-06 on
    // copilot.tencent.com: auto → glm-5.3-flash, default → glm-5.3-flash,
    // fast-model → deepseek-v4.1-flash, balanced-model → glm-5.3, deep-model →
    // kimi-k3. Credit multipliers come from the account's /v3/config rows and are
    // NOT what an earlier note here claimed (fast x0.15, balanced x0.50, deep
    // x1.00; hy4-preview-x x0.29, glm-5.3 x0.69, glm-5.2 x0.79, kimi-k3-2 x1.62
    // region, deepseek-v4.1-flash x0.11, space-bunny x0.08). All routers answer
    // image parts and take tools. None of the five appears in the published table
    // or in `agents[].models`, so services/codebuddyModels.js carries them through
    // ROUTER_IDS instead of dropping them with the unpublished ids. The gateway
    // types tool_choice as a string, so the forced-object form is downgraded for
    // them in executors/codebuddy-cn.js.
    { id: "auto", name: "Auto" },
    { id: "default", name: "Default" },
    { id: "fast-model", name: "Fast" },
    { id: "balanced-model", name: "Balanced" },
    { id: "deep-model", name: "Deep" },
  ],
  oauth: {
    baseUrl: "https://copilot.tencent.com",
    stateUrl: "https://copilot.tencent.com/v2/plugin/auth/state",
    tokenUrl: "https://copilot.tencent.com/v2/plugin/auth/token",
    refreshUrl: "https://copilot.tencent.com/v2/plugin/auth/token/refresh",
    userAgent: "CLI/2.63.2 CodeBuddy/2.63.2",
    platform: "CLI",
    pollInterval: 5000,
  },
  features: {
    usage: true,
    usageApikey: true,
  },
};

// JoyAgent (京东) — https://joyagent.jd.com/app/#/chat
//
// The web app exposes TWO different upstreams behind one login. Only the cheap one
// is modelled here (measured 2026-11-06 against a live account):
//
//   • `/work/api/v1/models/openai-u/v1/chat/completions` — a plain OpenAI
//     Chat Completions proxy in front of the MAAS models the account can see.
//     Standard request/response, standard SSE with `data: [DONE]`, function
//     calling, `delta.reasoning_content`, per-chunk usage. ~2 points of the
//     monthly quota per short turn (measured: 2.27 pts for 101 tokens).
//   • `sessions.create` → an ACP (Agent Client Protocol) JSON-RPC runtime in a
//     cloud sandbox (`agr-cubeproxy.agr-zyx.jdcloud.com/sandbox/<id>/8765/
//     v1/runtimes/acp`), which runs Claude Code 2.1.888 with its own skill
//     belt. Same question there cost ~73 points and 35 336 baseline input
//     tokens, and the answer only streams as `session/update` notifications.
//     Deliberately NOT modelled: 30× the price for a chat lane.
//
// Auth is the JD session cookie, nothing else. Verified by elimination:
//   • the full jar from a logged-in tab            → 200
//   • `ptKey=<jca_…>` alone                        → 200 (but it expires in ~7 days)
//   • passport cookies only (no ptKey, no jwaAccessToken) → 200, and the gateway
//     mints a fresh `jwaAccessToken` in `Set-Cookie` on every /work/api call,
//     so a durable login survives a day-plus token rotation without help
//   • `jwaAccessToken` alone, `thor` alone, `pin` alone, `thor+pin(+unick)` → 401
//     AUTHENTICATION_REQUIRED "登录已失效，请重新登录"
// No risk-control signature is required: the page loads JD's SGM SDK
// (`sgm-m.jd.com`, `sgm-himalayas.jd.com`) but that only ships telemetry — a bare
// Node `fetch` with just `Cookie` and `Content-Type` completed full turns.
const BASE = "https://joyagent.jd.com";
const API = `${BASE}/work/api/v1`;

export default {
  id: "joyagent",
  priority: 216,
  alias: "ja",
  aliases: ["joyagent", "joywork"],
  uiAlias: "ja",
  category: "webCookie",
  authType: "cookie",
  authHint:
    "Use “Login via Browser” — a JoyAgent window opens, you sign in with your JD account, and the session cookies are captured for you (re-login refreshes the same connection). Manual fallback: paste the whole Cookie header of a logged-in joyagent.jd.com request (DevTools → Network → any /work/api/ call → cookie). The JD passport cookies are what carry the session; a bare `ptKey=…` value also works for ~7 days.",
  display: {
    name: "JoyAgent (京东)",
    icon: "auto_awesome",
    color: "#0060C0",
    textIcon: "JA",
    website: "https://joyagent.jd.com/app/",
    notice: {
      signupUrl: "https://joyagent.jd.com/app/#/chat",
    },
  },
  transport: {
    baseUrl: `${API}/models/openai-u/v1/chat/completions`,
    format: "openai",
    authType: "cookie",
    // The connect guard bounds the wait for RESPONSE HEADERS, and a
    // `stream:false` call only gets its headers once the whole answer is
    // generated. The 60s default is therefore a live billing trap: measured
    // 2026-11-06, a full 4096-token turn took 90.7s (≈45 tok/s), so it would
    // abort, get mapped to the 502 bucket by BaseExecutor, and re-fire 3 more
    // REAL upstream calls — 4× the quota for one request. 300s is 3.3× the
    // worst measured case. Streaming is unaffected: its headers arrive in 1-3s
    // and the open stream is bounded by the engine's own 360s stall watchdog.
    // Related, and purely upstream behaviour: GLM-5.3 spent all 4096 tokens on
    // reasoning and answered with empty content at this ceiling, so a client
    // that wants a long answer must not also cap the turn at maxOutput.
    timeoutMs: 300000,
    // No validateUrl: that field is probed with `Authorization: Bearer` by the
    // generic validator, which a cookie session fails. Liveness and identity go
    // through the webIdentity probe instead (services/webIdentity.js →
    // GET /work/api/v1/gateway/auth/userInfo), which is also what the
    // Login-via-Browser flow uses to name and dedup the connection.
    headers: {
      // Not required today (measured), but this is a consumer login endpoint and
      // JD gates several of its hosts on a browser-shaped request.
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      Origin: BASE,
      Referer: `${BASE}/app/`,
    },
  },
  models: [
    // ids are the `code` field of GET /work/api/v1/models and are what the
    // endpoint expects in `model` — the numeric `id` (24..28) is rejected with
    // 404 MODEL_NOT_FOUND. `jd/` is part of the first id, not a provider prefix.
    // contextLength is the gateway's own declared number from that same row and
    // is NOT verified: this endpoint returns no context metadata, and a request
    // that actually fills 200k+ costs real quota. maxOutputTokens IS verified —
    // a 4096-token generation stopped at exactly 4096 with finish_reason
    // "length" (measured 2026-11-06).
    { id: "jd/deepseek-v4-pro-0813", name: "DeepSeek-v4-pro", contextLength: 200000, maxOutputTokens: 4096 },
    { id: "kimi-k3", name: "Kimi-k3", contextLength: 2000000, maxOutputTokens: 4096 },
    { id: "GLM-5.3", name: "GLM-5.3", contextLength: 1000000, maxOutputTokens: 4096 },
    { id: "MiniMax-M3", name: "MiniMax-M3", contextLength: 200000, maxOutputTokens: 4096 },
    { id: "Qwen3.5-397B-A17B", name: "Qwen3.5", contextLength: 100000, maxOutputTokens: 4096 },
  ],
  passthroughModels: false,
  // No `features.usage`: the balance lives at
  // GET /work/api/v1/governance/subscription/user-usage
  // (`data.usedPoints` / `data.totalMonthlyPoints`; this plan is 15 000/month
  // and a short turn measured ≈2.3 points, so the ceiling is roughly 6 000
  // turns). Rendering it needs a services/usage/ fetcher, which this lane does
  // not carry.
};

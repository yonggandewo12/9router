// 妙手 (CatPaw, Meituan) desktop-assistant lane.
//
// 妙手 is Meituan's Electron desktop AI assistant (`com.catx.catpaw`). Its chat
// traffic is NOT an OpenAI endpoint: the agent CLI POSTs to a session-scoped
// SSE API and authenticates with the Meituan Passport session token
// (`X-Passport-Token`, opaque). Measured 2026-11-05 on this machine: the app's
// cookie store holds that token for `.nocode.cn` with a 30-day expiry, and the
// very same string sits in a `.meituan.com` cookie (`pay_param_token`) — it is
// the passport SSO token, not an app-minted credential.
//
// Live-captured 2026-11-05 from 妙手 2026.1016.0032 through mitmproxy
// (dist-electron + @catpaw/agent-sdk, then replayed with curl):
//
//   POST https://ai.catpaw.meituan.com/api/agent/conversation/round
//        {conversationId, message|messages, modelType, source:"CatX", mode:"CATX_APP",
//         toolVersion:"2.0.2", permissionMode, ...}
//        → creates the round; the LAST message must be role user.
//   POST /api/agent/conversation/event  {conversationId, eventType:"conversation",
//        data:{status:"running"|"completed"|"canceled"}}
//        → the turn endpoint refuses with "会话未在执行中" unless the server-side
//          status was flipped to running first.
//   POST /api/agent/conversation/turn   {conversationId, message, toolConfigs,
//        toolVersion:"2.0.2", source, modelType, mode, stream:true}
//        → SSE. Each `data:` frame carries the WHOLE assistant message so far
//          (cumulative `content[]`, `finished` on the last one), then `[DONE]`.
//
// Measured facts that shaped the executor:
//   • Auth: only `Cookie: X-Passport-Token=<token>` is required; `user-mis-id`
//     and the `m-*` tracing headers are optional (both variants answered 200).
//     A dead token answers HTTP 401 {unifyCode:1003010001} on every endpoint.
//   • `stream:false` is ignored — the gateway always answers text/event-stream,
//     so this lane is pinned to streaming and converted for JSON clients.
//   • The model catalog (`GET /api/agent/models?mode=CATX_APP`) needs the CLI's
//     `m-appkey` header, not just the cookie; without it the list comes back [].
//   • Client tools work: `toolConfigs:[{name, description, inputSchema, enable,
//     fromClient:true}]` makes the model emit `{type:"tool_use", toolCallId,
//     toolName, toolParams}`. The server never executes anything on its behalf
//     for fromClient tools; the caller runs it and reports back.
//   • BUT the gateway also offers its OWN agent tool belt on every turn: the
//     same request with `toolConfigs:[]` came back as an undeclared `web_search`
//     (and once as `bash` + `web_search`), which no OpenAI client can execute.
//     `enable:false` entries take those tools off the table — see
//     CATPAW_BUILTIN_TOOLS in executors/miaoshou.js for the measured list.
//   • Tool results come back through the NEXT round: a `{type:"tool"}` message
//     carrying `{type:"tool_result"}` plus a trailing user message. The API
//     rejects a message list whose last entry is `tool`, and rejects role
//     `system` outright ("客户端只能发送 user、tool 或 assistant").
//   • System prompts: `systemPromptContext.systemPrompt` on round or turn works
//     (verified with tool calling and with a JSON-only instruction). `rulesMessage`
//     and `systemPromptOverride` did not take effect in the same probes.
//   • Images: `{type:"image_url", imageUrl:{url:"data:image/png;base64,…"}}`
//     is accepted and read by the vision path.
//   • Reasoning: the gateway decides per request whether to think; when it does,
//     the text block carries `reasoningContent` (same model, different prompts:
//     0 chars on "what is 13x17", 77 chars on a greeting). `reasoning_effort`
//     and `thinking` in the turn body were accepted but changed nothing, so no
//     thinking knob is advertised.
//   • `modelType` is resolved from the ROUND body; the turn body's value is
//     ignored (measured: round=89 + turn=10002544 answered with GLM-5.3).
//   • A reused messageId answers 431 "消息已存在", so every round/turn message
//     carries a fresh uuid.
//   • /turn/stop needs a non-empty turnRequestId (empty → 400) and reports
//     "stopping"; `/api/gateway/*` quota endpoints answer "无权访问该接口" for
//     this token, so there is no balance to render (per-turn credit_cost still
//     rides in `contextInfo.usage`).
//   • The captured round/turn body has no sampling fields at all, so client
//     `temperature` / `top_p` / `max_tokens` have nothing to land on and are
//     dropped by the executor (the upstream decides generation settings itself).
//
// Wiring: the desktop app shells out to `@catpaw/agent-sdk/bin/catpaw-cli
// server`, which listens on 127.0.0.1 and speaks its own /api + /v2 protocol.
// This lane talks to the SAME upstream HTTP API the CLI itself uses, so no
// local app or CLI process is required at runtime.
const BASE = "https://ai.catpaw.meituan.com";

export default {
  id: "miaoshou",
  priority: 215,
  alias: "ms",
  aliases: ["miaoshou", "catpaw"],
  uiAlias: "ms",
  category: "webCookie",
  authType: "cookie",
  authModes: ["cookie"],
  authHint:
    "Paste the Meituan Passport session token from 妙手 (X-Passport-Token) — or use “Import from 妙手” while the desktop app is signed in.",
  display: {
    name: "妙手 (CatPaw)",
    icon: "pets",
    color: "#FFC300",
    textIcon: "MS",
    website: "https://catpaw.meituan.com",
    notice: {
      signupUrl: "https://catpaw.meituan.com",
    },
  },
  transport: {
    baseUrl: `${BASE}/api/agent/conversation/turn`,
    format: "openai",
    // Upstream ignores stream:false and always answers SSE (measured), so the
    // handler must never take the JSON path against it.
    forceStream: true,
    authType: "cookie",
    timeoutMs: 600000,
  },
  models: [
    // contextLength / maxOutputTokens are MEASURED, not vendor marketing: every
    // turn frame carries `contextInfo:{contextWindowTokens,maxOutputTokens,maxTokens}`
    // for the model that actually served the request (read live 2026-11-05 for all
    // 11 rows below). `maxTokens` is always contextWindow − 20000, i.e. the gateway
    // reserves 20k for output + its own system prompt and built-in tool schemas
    // (~19.6k of the baseline prompt), so a request that fills `contextLength`
    // itself is already over budget.
    // The catalog also lists "MiniMax-M3.1-Flash", but that row carries NO
    // modelType, so it cannot be routed and is deliberately not modelled here.
    { id: "longcat-2.5", name: "LongCat 2.5", modelType: 10002544, contextLength: 204800, maxOutputTokens: 32768 },
    { id: "longcat-2.0", name: "LongCat 2.0", modelType: 77, contextLength: 204800, maxOutputTokens: 32768 },
    { id: "glm-5.3", name: "GLM-5.3", modelType: 89, contextLength: 204800, maxOutputTokens: 32000 },
    { id: "glm-5.3-flash", name: "GLM-5.3 Flash", modelType: 91, contextLength: 204800, maxOutputTokens: 32000 },
    { id: "glm-5.3-flashx", name: "GLM-5.3 FlashX", modelType: 98, contextLength: 204800, maxOutputTokens: 32000 },
    { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", modelType: 97, contextLength: 1024000, maxOutputTokens: 32768 },
    { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", modelType: 64, contextLength: 204800, maxOutputTokens: 32768 },
    { id: "minimax-m3", name: "MiniMax M3", modelType: 70, contextLength: 921600, maxOutputTokens: 32768 },
    { id: "kimi-k3.1-pro", name: "Kimi K3.1 Pro", modelType: 10002533, contextLength: 900000, maxOutputTokens: 32768 },
    { id: "kimi-k3", name: "Kimi K3", modelType: 83, contextLength: 204800, maxOutputTokens: 32000 },
    // modelType 0 is a real catalog row ("Auto"); the gateway picks per request and
    // names the winner in `message.model` (measured: glm-5.3-flash-mt). The window
    // below is whatever Auto resolved to on 2026-11-05 — it is the smallest of the
    // family, which is the safe thing to advertise for a moving target.
    { id: "auto", name: "Auto (server picks)", modelType: 0, contextLength: 204800, maxOutputTokens: 32000 },
  ],
  passthroughModels: false,
  // No `features.usage`: the quota endpoints under /api/gateway/* answer
  // "无权访问该接口" for the app's own passport token (measured), so there is no
  // balance to render. Per-request credit_cost still rides in the turn payload.
};

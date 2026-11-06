// MiaoshouExecutor — 妙手 (CatPaw, Meituan) desktop-assistant inference proxy.
//
// 妙手's chat is a session-scoped SSE API, not OpenAI /chat/completions (see
// providers/registry/miaoshou.js for the captured wire facts). Three upstream
// calls make one turn, and the order is load-bearing:
//
//   1. POST /api/agent/conversation/round   — creates the round; the LAST
//      message in `messages` must be role user. `modelType` is taken from HERE.
//   2. POST /api/agent/conversation/event   — {eventType:"conversation",
//      data:{status:"running"}}. /turn refuses with "会话未在执行中" without it.
//   3. POST /api/agent/conversation/turn    — the SSE stream we hand back.
//
// This executor owns conversation continuity itself: the gateway has no
// client-side conversation memory (9router is stateless), so the OpenAI
// `messages[]` history is replayed into `round.messages` every time. The round
// body must END in a user message, so the trailing user turn is lifted out of
// the replay and sent as the round's last entry; a trailing assistant is
// dropped (the server always generates the next assistant message itself).
//
// Tool results: 妙手 reports tool results as a `{type:"tool"}` message, but a
// message list ending in `tool` is rejected ("消息列表的最后一条必须是 user 类型").
// After an OpenAI tool round the history ends in tool results, so a one-line
// user continuation prompt is appended and the tool messages stay in the
// replay, where the model reads them (verified live 2026-11-05).
//
// Adjacency rules (measured 2026-11-05, all three arrive as HTTP 200 envelopes
// with unifyCode 1005010001):
//   • after `tool`  → only user|assistant. Two consecutive `tool` messages are a
//     400 ("tool 消息后面只能是 user 或 assistant，实际是: tool"), and OpenAI clients
//     send one `role:"tool"` message PER result, so a parallel tool round is
//     exactly that illegal run — the results are merged into a single `tool`
//     message holding one `tool_result` block each.
//   • after `user`  → only user|assistant ("user 消息后面只能是 user 或 assistant,
//     实际是: tool"). A result with no preceding assistant tool_use turn cannot be
//     placed, so that request stays the client's error rather than an invented
//     assistant turn.
//   • a `tool` message may not OPEN the list ("上一条消息不是 assistant 消息,
//     无法添加 tool 消息").
import { randomUUID } from "node:crypto";
import { BaseExecutor } from "./base.js";
import { SSE_DONE, SSE_HEADERS_NO_BUFFER } from "../utils/sseConstants.js";
import { sseChunk } from "../utils/sse.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";
import { connectTimeoutGuard } from "../utils/fetchTimeout.js";
import { buildErrorBody } from "../utils/error.js";
import { HTTP_STATUS } from "../config/runtimeConfig.js";
import { getModelMeta } from "../config/providerModels.js";
import { extractMiaoshouToken } from "../shared/miaoshou/credentials.js";

export const MIAOSHOU_BASE = "https://ai.catpaw.meituan.com";
export const MIAOSHOU_TOKEN_COOKIE = "X-Passport-Token";
export const MIAOSHOU_TOOL_VERSION = "2.0.2";
// `source`/`mode` are what the desktop app sends; the gateway echoes `source`
// back in agent_start events and keys some behaviour on `mode`.
export const MIAOSHOU_SOURCE = "CatX";
export const MIAOSHOU_MODE = "CATX_APP";

const ROUND_URL = `${MIAOSHOU_BASE}/api/agent/conversation/round`;
const EVENT_URL = `${MIAOSHOU_BASE}/api/agent/conversation/event`;
const TURN_URL = `${MIAOSHOU_BASE}/api/agent/conversation/turn`;
const TURN_STOP_URL = `${MIAOSHOU_BASE}/api/agent/conversation/turn/stop`;

// Connect-guard ceiling for the three conversation calls, i.e. the wait for
// /round, /event and /turn's RESPONSE HEADERS only (guardedFetch clears the
// guard as soon as /turn answers, so the SSE stream itself is never cut by this
// number). All three calls answered in ~1s across every measurement; the ceiling
// exists for the hung case, where 120s bounds how long a dead upstream can park
// the request, its socket and the account's concurrency slot. Overridable without
// a code change via MIAOSHOU_CONNECT_TIMEOUT_MS.
//
// What bounds the OPEN stream is the engine's own inter-chunk watchdog
// (streamingHandler.js:103 → pipeWithDisconnect, STREAM_STALL_TIMEOUT_MS = 360s),
// which starts once this executor has returned. The registry's transport
// .timeoutMs does NOT apply here: it is read only by BaseExecutor.execute(), and
// this lane replaces execute() wholesale.
const REQUEST_TIMEOUT_MS = (() => {
  const raw = parseInt(process.env.MIAOSHOU_CONNECT_TIMEOUT_MS, 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 120 * 1000;
})();
// reportDone/stopTurn are best-effort bookkeeping after the client already has
// its answer. They must never hold the response open, so they carry their own
// short ceiling instead of the client signal (usually aborted by the time they
// fire, which would skip the cancel bookkeeping they exist to do).
const TERMINAL_TIMEOUT_MS = 10000;

// Every conversation/turn message id must be unique across the whole server
// side conversation: reusing one answers HTTP 431 "消息已存在".
const freshId = () => randomUUID();

// ── Credentials ───────────────────────────────────────────────────────────

/**
 * Canonical copy moved to shared/miaoshou/credentials.js (next to probeCatpawToken)
 * so the import route, webIdentity and this executor share ONE parser instead of
 * three drifting regexes. Re-exported here for the existing importers.
 */
export { extractMiaoshouToken };

function authHeaders(token, { stream = false } = {}) {
  // Only /turn accepts `Accept: text/event-stream`; /round and /event answer a
  // bare 406 for it (measured 2026-11-05), so the JSON Accept is the default.
  return {
    Cookie: `${MIAOSHOU_TOKEN_COOKIE}=${token}`,
    "Content-Type": "application/json",
    // The catalog endpoint only answers with a non-empty list when the CLI's
    // appkey rides along; harmless on the conversation endpoints.
    "m-appkey": "com.sankuai.mcopilot.cli",
    Accept: stream ? "text/event-stream" : "application/json",
  };
}

// ── Message conversion (OpenAI ⇄ 妙手) ────────────────────────────────────

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

/**
 * System prompts cannot be sent as role:"system" (the API answers
 * "不支持的消息类型: system"). They ride in `systemPromptContext.systemPrompt`
 * instead — verified to steer the model, tool calling included.
 */
function collectSystemPrompt(messages) {
  return messages
    .filter((m) => m?.role === "system" || m?.role === "developer")
    .map((m) => textOf(m.content).trim())
    .filter(Boolean)
    .join("\n\n");
}

function imagePartsOf(content) {
  if (!Array.isArray(content)) return [];
  const out = [];
  for (const part of content) {
    if (part?.type === "image_url") {
      const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
      if (typeof url === "string" && url) out.push({ type: "image_url", imageUrl: { url, detail: "auto" } });
    } else if (part?.type === "image" && part.source?.type === "base64" && part.source.data) {
      out.push({
        type: "image_url",
        imageUrl: { url: `data:${part.source.media_type || "image/png"};base64,${part.source.data}`, detail: "auto" },
      });
    }
  }
  return out;
}

// ── Built-in tool surface ────────────────────────────────────────────────
// 妙手 offers its own agent tool belt on EVERY turn, whatever we send: measured
// 2026-11-05, "北京明天天气怎么样？" with `toolConfigs: []` came back as a
// `web_search` tool_use, and a rerun as `bash` + `web_search`. A client cannot
// execute a tool it never declared, so those turns are dead ends (and on a coding
// agent they show up as "unknown tool"). Listing a built-in with `enable:false`
// removes it from the surface — the same prompt then answers in text. There is no
// endpoint to enumerate the tools (`/api/agent/tools` → 404), so this is the app's
// own name map (妙手 2026.1016.0032, from the tool→category table in app.asar)
// plus the names observed live. A newer app version can still add a tool this
// list does not cover.
export const CATPAW_BUILTIN_TOOLS = [
  // web
  "web_search", "web_fetch", "km_search", "docs_search", "fetch_docs",
  // filesystem + shell
  "read", "read_file", "list_dir", "write", "string_replace", "multi_edit",
  "delete_file", "read_lints", "fetch_rules", "run_terminal_cmd", "bash",
  // search
  "grep", "grep_search", "glob_file_search", "codebase_search",
  // sub-agents, planning and session state
  "task", "task_output", "wait_for_tasks", "AskQuestion", "ConfirmTool",
  "create_plan", "todo_write", "create_goal", "update_goal", "get_goal",
  "TaskCreate", "TaskUpdate", "TaskGet", "TaskList", "TeamCreate", "TeamDelete",
  "generate_image", "memory_search", "skill", "canvasRuntime",
  // MCP bridges (both spellings the app uses)
  "call_mcp_tool", "CallMcpTool",
];

/**
 * OpenAI `tools[]` → 妙手 client-tool entries. `fromClient:true` is what makes
 * the gateway hand the call back to us instead of running it itself.
 */
export function toToolConfigs(tools) {
  if (!Array.isArray(tools)) return [];
  const out = [];
  for (const tool of tools) {
    const fn = tool?.type === "function" ? tool.function : tool;
    const name = typeof fn?.name === "string" ? fn.name.trim() : "";
    if (!name) continue;
    out.push({
      name,
      enable: true,
      fromClient: true,
      ...(typeof fn.description === "string" && fn.description ? { description: fn.description } : {}),
      ...(fn.parameters && typeof fn.parameters === "object" ? { inputSchema: fn.parameters } : {}),
    });
  }
  return out;
}

/** Client tools + the built-in off-switches, as one `toolConfigs[]`. */
function toolConfigsWithBuiltinsOff(tools) {
  const configs = toToolConfigs(tools);
  const declared = new Set(configs.map((c) => c.name));
  for (const name of CATPAW_BUILTIN_TOOLS) {
    if (!declared.has(name)) configs.push({ name, enable: false });
  }
  return configs;
}

/**
 * Convert an OpenAI-style history into 妙手 message entries.
 *
 * Roles: user/assistant/tool are legal ("客户端只能发送 user、tool 或 assistant").
 * tool_calls on an assistant become a sibling `tool_use` block on that same
 * assistant message (the gateway's own shape), and OpenAI `role:"tool"` turns
 * become `tool_result` blocks — consecutive results fold into ONE `tool`
 * message, because two adjacent `tool` messages are a 400 upstream.
 */
export function toMiaoshouMessages(messages) {
  const out = [];
  for (const m of messages || []) {
    if (!m || typeof m !== "object") continue;
    if (m.role === "system" || m.role === "developer") continue;

    if (m.role === "tool") {
      const toolCallId = m.tool_call_id || m.toolCallId;
      if (!toolCallId) continue;
      const block = {
        type: "tool_result",
        toolCallId,
        toolName: m.name || m.toolName || "tool",
        toolResult: textOf(m.content),
      };
      // One result per OpenAI message, but 妙手 forbids two adjacent `tool`
      // messages, so a parallel round folds into the message already open.
      const prev = out[out.length - 1];
      if (prev?.type === "tool") {
        prev.content.push(block);
        continue;
      }
      out.push({
        type: "tool",
        messageId: freshId(),
        finished: true,
        content: [block],
      });
      continue;
    }

    if (m.role !== "user" && m.role !== "assistant") continue;

    const content = [];
    const text = textOf(m.content);
    const images = m.role === "user" ? imagePartsOf(m.content) : [];
    if (text) content.push({ type: "text", text });
    content.push(...images);

    const calls = Array.isArray(m.tool_calls) ? m.tool_calls : [];
    for (const call of calls) {
      const name = call?.function?.name;
      if (!name) continue;
      content.push({
        type: "tool_use",
        toolCallId: call.id || freshId(),
        toolName: name,
        toolParams: typeof call.function.arguments === "string" ? call.function.arguments : JSON.stringify(call.function.arguments || {}),
      });
    }

    // A message that carries only tool_use has no text node upstream; keep the
    // (possibly empty) text block out rather than sending `text: ""`.
    if (!content.length) continue;
    out.push({ type: m.role, messageId: freshId(), finished: true, content });
  }
  return out;
}

// OpenAI clients end an agentic turn with role:"tool" messages and no trailing
// user turn; 妙手 rejects a message list whose last entry is `tool` ("消息列表的
// 最后一条必须是 user 类型"). A one-line user nudge after the results is what the
// gateway's own agent loop does, and the model answers from the replayed
// tool_result (measured 2026-11-05).
const TOOL_CONTINUATION_PROMPT = "请根据上面的工具结果继续回答。";

/**
 * Split a converted history into (replayed history, prompt turn).
 *
 * The round call needs a list ending in user, so the trailing user turn is
 * lifted out of the replay and sent as the round's last message. A history that
 * ends in tool results (OpenAI clients never resend a new user turn after the
 * tool round) gets a synthetic user prompt appended; the tool messages stay in
 * the replay, which is where the model reads its results from.
 */
export function planTurn(converted) {
  const history = converted.slice();
  // A trailing assistant text has no slot in this API: the gateway only replays
  // user/assistant/tool turns and always generates the next assistant message.
  // Dropping it keeps the list ending in a role the server accepts.
  while (history.length && history[history.length - 1].type === "assistant") history.pop();
  if (!history.length) return { replay: [], prompt: null };
  const last = history[history.length - 1];
  if (last.type === "tool") {
    return {
      replay: history,
      prompt: {
        type: "user",
        messageId: freshId(),
        finished: true,
        content: [{ type: "text", text: TOOL_CONTINUATION_PROMPT }],
      },
    };
  }
  if (last.type === "user") return { replay: history.slice(0, -1), prompt: last };
  return { replay: history, prompt: null };
}

// ── SSE frame parsing ────────────────────────────────────────────────────

/**
 * One `data:` frame = the whole assistant message so far. Yield the parsed
 * objects; callers diff cumulative text against what they already sent.
 */
async function* readFrames(body, signal) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      if (signal?.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        let parsed = null;
        try {
          parsed = JSON.parse(payload);
        } catch {
          continue;
        }
        if (parsed) yield parsed;
      }
    }
  } finally {
    try {
      reader.cancel().catch(() => {});
    } catch {
      /* already released */
    }
  }
}

function framePayload(frame) {
  return frame?.message || frame?.data?.message || null;
}

function blockText(block) {
  if (!block || typeof block !== "object") return "";
  if (block.type === "text") return typeof block.text === "string" ? block.text : "";
  return "";
}

function blockReasoning(block) {
  if (!block || typeof block !== "object") return "";
  return typeof block.reasoningContent === "string" ? block.reasoningContent : "";
}

function blockToolUses(block) {
  if (!block || block.type !== "tool_use") return null;
  if (typeof block.toolName !== "string" || !block.toolName) return null;
  return {
    id: block.toolCallId || freshId(),
    name: block.toolName,
    args: typeof block.toolParams === "string" ? block.toolParams : JSON.stringify(block.toolParams || {}),
  };
}

// ── Upstream error shapes ────────────────────────────────────────────────

// 1003010001 = passport auth failed (measured on a dead token).
const PASSPORT_AUTH_FAILED = 1003010001;

/**
 * The failure object carried by a response body. 妙手 reports business errors as an
 * HTTP 200 envelope — {success:false, code:400, unifyCode:1005010001, msg:"…"} —
 * and the same failure inside an SSE frame as {error:{code, unifyCode, message}}
 * (measured 2026-11-05: calling /turn without the status=running event gives
 * `data:{"conversationId":…,"error":{"code":400,"unifyCode":1005010001,
 * "message":"会话未在执行中…"}}`). Unwrap both so one mapping sees the real code.
 */
function errorOf(payload) {
  if (!payload || typeof payload !== "object") return {};
  return payload.error && typeof payload.error === "object" ? payload.error : payload;
}

function errorMessage(status, payload) {
  const err = errorOf(payload);
  const msg = err.message || err.msg || payload?.msg || payload?.message;
  if (typeof msg === "string" && msg) return msg;
  return `妙手 returned HTTP ${status}`;
}

function isAuthFailure(status, payload) {
  if (status === HTTP_STATUS.UNAUTHORIZED || status === HTTP_STATUS.FORBIDDEN) return true;
  const err = errorOf(payload);
  // A dead passport token also arrives in-band as HTTP 200 + code 401.
  return err.unifyCode === PASSPORT_AUTH_FAILED || Number(err.code) === HTTP_STATUS.UNAUTHORIZED;
}

/**
 * Status this lane reports for a failed upstream call.
 *
 * A request-scoped refusal has to keep its 4xx. accountFallback's ERROR_RULES cool
 * a connection down on ANY unmatched status, and 502 is unmatched, so flattening
 * "消息列表的最后一条必须是 user 类型" onto 502 both hides the cause from the client
 * and parks a healthy Passport session for 30s.
 */
function upstreamStatus(httpStatus, payload) {
  if (isAuthFailure(httpStatus, payload)) return HTTP_STATUS.UNAUTHORIZED;
  if (httpStatus >= HTTP_STATUS.BAD_REQUEST) return httpStatus;
  const code = Number(errorOf(payload).code);
  return Number.isInteger(code) && code >= HTTP_STATUS.BAD_REQUEST && code < 600
    ? code
    : HTTP_STATUS.BAD_GATEWAY;
}

function openaiError(status, message, payload) {
  const err = errorOf(payload);
  return {
    ...buildErrorBody(status, message).error,
    code: err.unifyCode ?? err.code ?? status,
    status,
  };
}

function jsonError(status, message, payload) {
  return new Response(JSON.stringify({ error: openaiError(status, message, payload) }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Read a response as text and, when it parses, the JSON envelope inside it. */
async function readBody(res) {
  const text = (await res.text().catch(() => "")).trim();
  try {
    return { text, json: text ? JSON.parse(text) : null };
  } catch {
    return { text, json: null };
  }
}

/**
 * proxyAwareFetch + connectTimeoutGuard (same guard BaseExecutor uses for every
 * other lane). `awaitBody` keeps the ceiling active until the small JSON body is
 * fully read (round/event); with it off the guard covers only the wait for
 * response headers, so a long SSE turn is never cut by REQUEST_TIMEOUT_MS
 * mid-stream — body reads stay governed by the client signal in readFrames.
 *
 * A guard timeout throws (not AbortError), so chatCore files it as a provider
 * 502 with the timeout message and accountFallback cools the connection down
 * instead of reading it as a client cancellation (499).
 */
async function guardedFetch(url, init, proxyOptions, signal, { awaitBody = true } = {}) {
  const guard = connectTimeoutGuard(signal, REQUEST_TIMEOUT_MS);
  try {
    const res = await proxyAwareFetch(url, { ...init, signal: guard.signal }, proxyOptions);
    if (!awaitBody) return res;
    const { text, json } = await readBody(res);
    return { res, text, json };
  } catch (error) {
    if (guard.timedOut) throw new Error(`妙手 upstream timed out after ${REQUEST_TIMEOUT_MS}ms waiting for ${url}`);
    throw error;
  } finally {
    guard.clear();
  }
}

/** Human-readable cause for a failed upstream call (envelope msg, else raw body). */
function failureMessage(status, json, text) {
  if (json) return errorMessage(status, json);
  return text ? text.slice(0, 200) : `妙手 returned HTTP ${status}`;
}

/**
 * Every 妙手 conversation endpoint answers this envelope, including failures —
 * {success:false, code:400, msg:"…"} still arrives over HTTP 200.
 */
const callFailed = (res, json) => !res.ok || json?.success === false;

// ── Executor ─────────────────────────────────────────────────────────────

function modelEntryOf(model) {
  const meta = getModelMeta("ms", model);
  return meta && Number.isFinite(meta.modelType) ? { ...meta, modelType: Number(meta.modelType) } : null;
}

export class MiaoshouExecutor extends BaseExecutor {
  constructor(provider = "miaoshou") {
    super(provider);
  }

  buildUrl() {
    return TURN_URL;
  }

  buildHeaders(credentials) {
    return authHeaders(extractMiaoshouToken(credentials));
  }

  // BaseExecutor would POST the OpenAI body; this lane makes three calls of its
  // own, so execute() is replaced wholesale.
  async execute({ model, body, stream, credentials, signal, log, proxyOptions = null }) {
    const token = extractMiaoshouToken(credentials);
    if (!token) {
      return {
        response: jsonError(HTTP_STATUS.UNAUTHORIZED, "妙手: missing X-Passport-Token cookie — reconnect the account"),
        url: TURN_URL,
        headers: {},
        transformedBody: { error: "missing_credential" },
        responseFormat: "openai",
      };
    }

    const entry = modelEntryOf(model);
    if (!entry) {
      return {
        response: jsonError(HTTP_STATUS.BAD_REQUEST, `妙手: unknown model "${String(model || "").slice(0, 60)}"`),
        url: TURN_URL,
        headers: {},
        transformedBody: { error: "unknown_model" },
        responseFormat: "openai",
      };
    }

    const messages = Array.isArray(body?.messages) ? body.messages : [];
    const systemPrompt = collectSystemPrompt(messages);
    const converted = toMiaoshouMessages(messages);
    if (!converted.length) {
      return {
        response: jsonError(HTTP_STATUS.BAD_REQUEST, "妙手: request contained no user message"),
        url: TURN_URL,
        headers: {},
        transformedBody: { error: "empty_prompt" },
        responseFormat: "openai",
      };
    }
    const { replay, prompt } = planTurn(converted);
    if (!prompt) {
      return {
        response: jsonError(HTTP_STATUS.BAD_REQUEST, "妙手: request contained no user message"),
        url: TURN_URL,
        headers: {},
        transformedBody: { error: "empty_prompt" },
        responseFormat: "openai",
      };
    }

    const conversationId = freshId();
    // /turn/stop requires a non-empty turnRequestId (measured: empty → 400). Mint
    // one per turn and echo it on stop so an abandoned stream can actually cancel.
    const turnRequestId = freshId();
    const headers = authHeaders(token);
    // `permissionMode` is the desktop app's own value, forwarded verbatim: it
    // tells 妙手's server-side agent not to pause for an approval prompt. Nothing
    // here can be executed on this machine by it — a `fromClient:true` tool is
    // handed back to the OpenAI client, and the built-in belt that COULD run
    // something server-side is switched off in `toolConfigs` below.
    const baseRound = {
      conversationId,
      messages: [...replay, prompt],
      modelType: entry.modelType,
      source: MIAOSHOU_SOURCE,
      mode: MIAOSHOU_MODE,
      toolVersion: MIAOSHOU_TOOL_VERSION,
      permissionMode: "unsafeBypassPermissions",
      repositories: [],
      memoryEnabled: false,
      initialPromptContext: { currentDate: new Date().toISOString().slice(0, 10) },
      rulesMessage: "",
      goal: null,
      agentType: "main",
      mcpServers: [],
      enableTodos: true,
      ...(systemPrompt ? { systemPromptContext: { systemPrompt } } : {}),
    };
    const toolConfigs = toolConfigsWithBuiltinsOff(body?.tools);

    // 1) round
    const { res: roundRes, text: roundText, json: roundJson } = await guardedFetch(
      ROUND_URL,
      {
        method: "POST",
        headers,
        body: JSON.stringify(baseRound),
      },
      proxyOptions,
      signal,
    );
    if (callFailed(roundRes, roundJson)) {
      const status = upstreamStatus(roundRes.status, roundJson);
      const message = failureMessage(roundRes.status, roundJson, roundText);
      log?.warn?.("MIAOSHOU", `round failed: ${roundRes.status}/${status} ${message.slice(0, 200)}`);
      return {
        response: jsonError(status, message, roundJson),
        url: ROUND_URL,
        headers: {},
        transformedBody: { error: "round_failed", status: roundRes.status },
        responseFormat: "openai",
      };
    }

    // 2) flip the server-side status to running — /turn refuses otherwise
    const {
      res: runningRes,
      text: runningText,
      json: runningJson,
    } = await guardedFetch(
      EVENT_URL,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          conversationId,
          eventType: "conversation",
          data: { status: "running" },
        }),
      },
      proxyOptions,
      signal,
    );
    if (callFailed(runningRes, runningJson)) {
      const status = upstreamStatus(runningRes.status, runningJson);
      const message = `妙手: could not start the turn (${failureMessage(runningRes.status, runningJson, runningText)})`;
      log?.warn?.("MIAOSHOU", `status=running failed: ${runningRes.status}/${status} ${message.slice(0, 200)}`);
      return {
        response: jsonError(status, message, runningJson),
        url: EVENT_URL,
        headers: {},
        transformedBody: { error: "running_failed", status: runningRes.status },
        responseFormat: "openai",
      };
    }

    // 3) turn — SSE
    const turnBody = {
      conversationId,
      turnRequestId,
      message: prompt,
      toolConfigs,
      todos: [],
      toolVersion: MIAOSHOU_TOOL_VERSION,
      source: MIAOSHOU_SOURCE,
      modelType: entry.modelType,
      mode: MIAOSHOU_MODE,
      permissionMode: "unsafeBypassPermissions",
      rulesMessage: "",
      goal: null,
      initialPromptContext: baseRound.initialPromptContext,
      userPromptContext: { userTextInput: textOf(prompt.content) },
      stream: true,
      ...(systemPrompt ? { systemPromptContext: { systemPrompt } } : {}),
    };
    // Headers-only guard: the SSE body may legitimately stream for minutes, so
    // the ceiling is cleared as soon as /turn answers (see guardedFetch).
    const turnRes = await guardedFetch(
      TURN_URL,
      {
        method: "POST",
        // /turn is the one endpoint that wants the SSE Accept.
        headers: authHeaders(token, { stream: true }),
        body: JSON.stringify(turnBody),
      },
      proxyOptions,
      signal,
      { awaitBody: false },
    );

    // Only a failing response is read as a body — an ok one has to stay unread
    // for the SSE reader below.
    const turnErr = turnRes.ok ? { text: "", json: null } : await readBody(turnRes);
    if (callFailed(turnRes, turnErr.json)) {
      const status = upstreamStatus(turnRes.status, turnErr.json);
      const message = failureMessage(turnRes.status, turnErr.json, turnErr.text);
      log?.warn?.("MIAOSHOU", `turn failed: ${turnRes.status}/${status} ${message.slice(0, 200)}`);
      await reportDone(conversationId, token, proxyOptions, false);
      return {
        response: jsonError(status, message, turnErr.json),
        url: TURN_URL,
        headers: {},
        transformedBody: { error: "turn_failed", status: turnRes.status },
        responseFormat: "openai",
      };
    }

    const replyModel = String(body?.model || model || entry.id);
    const ctx = { model: replyModel, conversationId, turnRequestId, token, proxyOptions, clientSignal: signal, log };
    if (stream) {
      return {
        response: new Response(streamResponse(turnRes.body, ctx), { status: 200, headers: SSE_HEADERS_NO_BUFFER }),
        url: TURN_URL,
        headers: SSE_HEADERS_NO_BUFFER,
        transformedBody: turnBody,
        // The chunks this executor emits are OpenAI chat chunks, so chatCore must
        // translate the response from OpenAI regardless of the registry format.
        responseFormat: "openai",
      };
    }

    // The upstream only speaks SSE (measured), so a non-streaming caller — the
    // one client that can force this path is deepseek-tui, which cannot parse
    // SSE — gets the same frames folded into one completion. Awaiting here means
    // a failed turn can still be reported with its real status code instead of
    // HTTP 200 wrapping an error body.
    const { status, body: jsonBody } = await jsonBodyResponse(turnRes.body, ctx);
    return {
      response: new Response(JSON.stringify(jsonBody), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
      url: TURN_URL,
      headers: { "Content-Type": "application/json" },
      transformedBody: turnBody,
      responseFormat: "openai",
    };
  }

  // Auth failures arrive as real 401s here. No refreshCredentials override:
  // BaseExecutor's `false` is the honest answer for a Passport cookie session,
  // and it lets refreshWithRetry fail the dead token immediately instead of
  // sleeping through three attempts that can never mint a new one.
}

// Mark the server-side conversation terminal. Best-effort: the turn already
// finished streaming, and a failure here only leaves the gateway's status at
// "running" for a conversation nobody will revisit (each turn mints a new id).
async function reportDone(conversationId, token, proxyOptions, completed) {
  try {
    await proxyAwareFetch(EVENT_URL, {
      method: "POST",
      headers: authHeaders(token, { stream: false }),
      body: JSON.stringify({
        conversationId,
        eventType: "conversation",
        data: { status: completed ? "completed" : "canceled" },
      }),
      // Own ceiling, never the client signal: on abort the client signal is
      // already dead, and the "canceled" bookkeeping is exactly what must still
      // go out then (measured hang: awaiting an aborted-signal fetch here).
      signal: AbortSignal.timeout(TERMINAL_TIMEOUT_MS),
    }, proxyOptions);
  } catch {
    /* best-effort */
  }
}

// Ask the gateway to stop generating (client disconnected mid-stream). Without
// this the upstream keeps the turn alive and bills for tokens nobody reads.
async function stopTurn(conversationId, turnRequestId, token, proxyOptions) {
  if (!turnRequestId) return;
  try {
    await proxyAwareFetch(TURN_STOP_URL, {
      method: "POST",
      headers: authHeaders(token, { stream: false }),
      body: JSON.stringify({ conversationId, turnRequestId }),
      signal: AbortSignal.timeout(TERMINAL_TIMEOUT_MS),
    }, proxyOptions);
  } catch {
    /* best-effort */
  }
}

function newResponseId(prefix) {
  return `chatcmpl-${prefix}-${Date.now()}-${randomUUID().slice(0, 8)}`;
}

/**
 * 妙手 reports `prompt_tokens` as the UNCACHED prompt only and keeps cache hits
 * in `cache_read_tokens` separately (measured: 171 + 19456 cached on a warm
 * session; 19627 + 0 on a cold one). OpenAI's `prompt_tokens` is cache-INCLUSIVE
 * and `cached_tokens` is a subset, so fold the two back together here — passing
 * the upstream split through would under-report input tokens on every warm turn.
 */
function usageOf(frame) {
  const usage = frame?.contextInfo?.usage || frame?.message?.usage;
  if (!usage || typeof usage !== "object") return null;
  const uncached = Number(usage.prompt_tokens) || 0;
  const cached = Number(usage.cache_read_tokens) || 0;
  const completion = Number(usage.completion_tokens) || 0;
  const prompt = uncached + cached;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    ...(cached > 0 ? { prompt_tokens_details: { cached_tokens: cached } } : {}),
  };
}

/**
 * Streaming path. Frames are cumulative, so each frame is diffed against what
 * was already emitted: text/reasoning by length, tool_use by first sighting.
 * Finish once a `finished` frame arrives (then a short drain for late frames)
 * or the body closes.
 */
function streamResponse(upstreamBody, { model, conversationId, turnRequestId, token, proxyOptions, clientSignal, log }) {
  const encoder = new TextEncoder();
  const id = newResponseId("ms");
  const created = Math.floor(Date.now() / 1000);

  // Upstream bookkeeping fires from BOTH start()'s finally and the consumer's
  // cancel() — a client disconnect triggers both paths. One flag each (scoped
  // to the stream, shared by both callbacks) so a turn is never stopped or
  // marked terminal twice.
  let terminalSent = false;
  let stopSent = false;
  const markTerminal = (completed) => {
    if (terminalSent) return;
    terminalSent = true;
    reportDone(conversationId, token, proxyOptions, completed);
  };
  const stopUpstream = () => {
    if (stopSent) return;
    stopSent = true;
    stopTurn(conversationId, turnRequestId, token, proxyOptions);
  };

  return new ReadableStream(
    {
      async start(controller) {
        let closed = false;
        let roleSent = false;
        let sentText = 0;
        let sentReasoning = 0;
        // id → OpenAI tool_calls index. Set at first sighting so arg-delta frames
        // are an O(1) map lookup, not a spread+indexOf over the whole belt.
        const toolIndexById = new Map();
        let usage = null;
        // Tool arguments stream CUMULATIVELY too (measured: "", then `{"city": "`,
        // then the full JSON on the same toolCallId), so each tool_use block is
        // diffed and only the unseen tail is sent as a delta.
        const sentArgs = new Map();
        // `ended` = this stream has been finalised; `upstreamDone` = the last
        // frame already declared `finished:true`. They must not share a flag:
        // finalising on a frame that already set it would return early and
        // leave the response body open forever (measured hang, 2026-11-05).
        let ended = false;
        let upstreamDone = false;

        const chunk = (delta, finishReason = null, extra = {}) => {
          if (closed) return;
          try {
            controller.enqueue(
              encoder.encode(
                sseChunk({
                  id,
                  object: "chat.completion.chunk",
                  created,
                  model,
                  choices: [{ index: 0, delta, finish_reason: finishReason, logprobs: null }],
                  ...extra,
                }),
              ),
            );
          } catch {
            closed = true;
          }
        };

        const ensureRole = () => {
          if (roleSent) return;
          roleSent = true;
          chunk({ role: "assistant", content: "" });
        };

        const finish = (reason = null) => {
          if (closed || ended) return;
          ended = true;
          // 妙手 always reports a plain stop; a turn that produced tool_use must
          // finish as "tool_calls" or OpenAI clients never run the tool.
          const finishReason = reason || (toolIndexById.size > 0 ? "tool_calls" : "stop");
          ensureRole();
          chunk({}, finishReason, usage ? { usage } : {});
          if (!closed) {
            try {
              controller.enqueue(encoder.encode(SSE_DONE));
            } catch {
              /* client gone */
            }
          }
          if (!closed) {
            try {
              controller.close();
            } catch {
              /* already closed */
            }
          }
          closed = true;
        };

        // HTTP 200 is already committed, so a failure that arrives after the
        // stream opened can only be reported in-band: the repo-wide frame for
        // that is a chunk with NO choices plus a top-level `error`, which
        // stream.js files as an error and openai-to-claude / openai-responses
        // render as `event: error` / `response.failed`. A non-standard
        // finish_reason ("error") is not an OpenAI enum value and reads as a
        // normally-completed turn to strict clients.
        const fail = (message, status, payload) => {
          if (closed || ended) return;
          ended = true;
          ensureRole();
          try {
            controller.enqueue(
              encoder.encode(sseChunk({ id, object: "chat.completion.chunk", created, model, choices: [], error: openaiError(status, message, payload) })),
            );
            controller.enqueue(encoder.encode(SSE_DONE));
            controller.close();
          } catch {
            /* client gone */
          }
          closed = true;
        };

        try {
          for await (const frame of readFrames(upstreamBody, clientSignal)) {
            if (frame?.error) {
              const status = upstreamStatus(200, frame);
              const message = errorMessage(200, frame);
              log?.warn?.("MIAOSHOU", `in-band error: ${message.slice(0, 200)}`);
              fail(message, status, frame);
              return;
            }

            const message = framePayload(frame);
            if (!message) {
              const late = usageOf(frame);
              if (late) usage = late;
              continue;
            }

            const blocks = Array.isArray(message.content) ? message.content : [];
            let text = "";
            let reasoning = "";
            for (const block of blocks) {
              text += blockText(block);
              reasoning += blockReasoning(block);
              const tool = blockToolUses(block);
              if (tool) {
                if (!toolIndexById.has(tool.id)) {
                  toolIndexById.set(tool.id, toolIndexById.size);
                  sentArgs.set(tool.id, "");
                  ensureRole();
                  chunk({
                    tool_calls: [
                      {
                        index: toolIndexById.get(tool.id),
                        id: tool.id,
                        type: "function",
                        function: { name: tool.name, arguments: "" },
                      },
                    ],
                  });
                }
                const already = sentArgs.get(tool.id) || "";
                if (tool.args.length > already.length && tool.args.startsWith(already)) {
                  sentArgs.set(tool.id, tool.args);
                  chunk({
                    tool_calls: [
                      {
                        index: toolIndexById.get(tool.id),
                        function: { arguments: tool.args.slice(already.length) },
                      },
                    ],
                  });
                } else if (tool.args !== already && !tool.args.startsWith(already)) {
                  // A revised (not extended) prefix cannot be undone in OpenAI
                  // deltas, so what already went out stays wrong — say so loudly
                  // instead of truncating silently.
                  log?.warn?.(
                    "MIAOSHOU",
                    `tool args revised, not extended (id=${tool.id}): sent ${already.length} chars, frame has ${tool.args.length}`,
                  );
                }
              }
            }

            if (reasoning.length > sentReasoning) {
              ensureRole();
              chunk({ reasoning_content: reasoning.slice(sentReasoning) });
              sentReasoning = reasoning.length;
            }
            if (text.length > sentText) {
              ensureRole();
              chunk({ content: text.slice(sentText) });
              sentText = text.length;
            }

            const frameUsage = usageOf(frame);
            if (frameUsage) usage = frameUsage;
            if (message.finished === true) upstreamDone = true;
          }
          if (upstreamDone) log?.debug?.("MIAOSHOU", "turn ended after a finished frame");
          finish();
        } catch (error) {
          if (clientSignal?.aborted) {
            stopUpstream();
            finish();
            return;
          }
          log?.warn?.("MIAOSHOU", `stream failed: ${error?.message || error}`);
          fail(error?.message || String(error), HTTP_STATUS.BAD_GATEWAY);
        } finally {
          markTerminal(!clientSignal?.aborted);
        }
      },
      cancel() {
        // start()'s finally runs too once the read loop unwinds — the flags above
        // guarantee only the first of the two paths fires anything upstream.
        stopUpstream();
        markTerminal(false);
      },
    },
    { highWaterMark: 16384 },
  );
}

/**
 * Non-streaming path: fold the cumulative SSE frames (the upstream only speaks
 * SSE, measured) into one completion. Resolves with the status to answer with,
 * so a failed turn is not filed as an HTTP 200 that wraps an error body.
 */
async function jsonBodyResponse(upstreamBody, { model, conversationId, turnRequestId, token, proxyOptions, clientSignal, log }) {
  let text = "";
  let reasoning = "";
  // toolCallId → {id, name, args}. Frames are cumulative, so the LAST frame
  // holds each tool's complete arguments; recording at first sighting would
  // freeze the partial prefix (measured: args arrive "" → `{"city": ` → full).
  const toolsById = new Map();
  let usage = null;
  let failure = null;
  let failureStatus = HTTP_STATUS.BAD_GATEWAY;
  let failurePayload = null;

  try {
    for await (const frame of readFrames(upstreamBody, clientSignal)) {
      if (frame?.error) {
        failure = errorMessage(200, frame);
        failureStatus = upstreamStatus(200, frame);
        failurePayload = frame;
        break;
      }
      const message = framePayload(frame);
      if (!message) {
        const late = usageOf(frame);
        if (late) usage = late;
        continue;
      }
      const blocks = Array.isArray(message.content) ? message.content : [];
      // Join this frame's blocks exactly like streamResponse does — a message can
      // carry several text blocks, and last-block-wins would drop the others.
      let frameText = "";
      let frameReasoning = "";
      for (const block of blocks) {
        frameText += blockText(block);
        frameReasoning += blockReasoning(block);
        const tool = blockToolUses(block);
        if (tool) {
          const entry = toolsById.get(tool.id) || { id: tool.id, name: tool.name, args: "" };
          entry.name = tool.name || entry.name;
          entry.args = tool.args;
          toolsById.set(tool.id, entry);
        }
      }
      if (frameText) text = frameText;
      if (frameReasoning) reasoning = frameReasoning;
      const frameUsage = usageOf(frame);
      if (frameUsage) usage = frameUsage;
    }
  } catch (error) {
    failure = error?.message || String(error);
  } finally {
    reportDone(conversationId, token, proxyOptions, !failure);
    if (failure) {
      log?.warn?.("MIAOSHOU", `non-stream turn failed: ${String(failure).slice(0, 200)}`);
    }
  }

  const toolCalls = [...toolsById.values()].map((tool) => ({
    id: tool.id,
    type: "function",
    function: { name: tool.name, arguments: tool.args },
  }));

  if (failure) {
    return { status: failureStatus, body: { error: openaiError(failureStatus, String(failure), failurePayload) } };
  }
  return {
    status: 200,
    body: {
      id: newResponseId("ms"),
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            // OpenAI clients expect null (not "") when the turn is a pure
            // tool call; an empty string reads as "assistant said nothing".
            content: text || (toolCalls.length ? null : ""),
            ...(reasoning ? { reasoning_content: reasoning } : {}),
            ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
          },
          finish_reason: toolCalls.length ? "tool_calls" : "stop",
          logprobs: null,
        },
      ],
      usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    },
  };
}

export const __internal__ = {
  extractMiaoshouToken,
  toMiaoshouMessages,
  toToolConfigs,
  toolConfigsWithBuiltinsOff,
  planTurn,
  collectSystemPrompt,
  modelEntryOf,
  upstreamStatus,
  errorOf,
  // Streaming paths — pinned by tests/unit/miaoshou-provider.test.js (cumulative
  // frame diffing, tool-arg deltas, usage folding, in-band error frames).
  streamResponse,
  jsonBodyResponse,
  usageOf,
};

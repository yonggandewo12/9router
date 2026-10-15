import { saveRequestUsage, appendRequestLog, saveRequestDetail } from "@/lib/usageDb.js";
import { COLORS } from "../../utils/stream.js";
import { canonicalizeUsage } from "../../utils/usageTracking.js";
import { HTTP_STATUS } from "../../config/runtimeConfig.js";

const OPTIONAL_PARAMS = [
  "temperature", "top_p", "top_k",
  "max_tokens", "max_completion_tokens",
  "thinking", "reasoning", "enable_thinking",
  "presence_penalty", "frequency_penalty",
  "seed", "stop", "tools", "tool_choice",
  "response_format", "prediction", "store", "metadata",
  "n", "logprobs", "top_logprobs", "logit_bias",
  "user", "parallel_tool_calls"
];

export function extractRequestConfig(body, stream) {
  const config = { messages: body.messages || [], model: body.model, stream };
  for (const param of OPTIONAL_PARAMS) {
    if (body[param] !== undefined) config[param] = body[param];
  }
  return config;
}

export function extractUsageFromResponse(responseBody) {
  if (!responseBody || typeof responseBody !== "object") return null;

  // Claude format
  // Note: OpenAI Responses usage ({input_tokens, input_tokens_details:{cached_tokens}})
  // also matches this branch. Its prompt is cache-INCLUSIVE and its cache rides in
  // input_tokens_details, so emit it as cached_tokens — the convention
  // canonicalizeUsage() passes through without folding. Reading it here keeps
  // cache accounting correct for /v1/responses and codex traffic.
  if (responseBody.usage?.input_tokens !== undefined) {
    return {
      prompt_tokens: responseBody.usage.input_tokens || 0,
      completion_tokens: responseBody.usage.output_tokens || 0,
      cached_tokens: responseBody.usage.cached_tokens ?? responseBody.usage.input_tokens_details?.cached_tokens,
      cache_read_input_tokens: responseBody.usage.cache_read_input_tokens,
      cache_creation_input_tokens: responseBody.usage.cache_creation_input_tokens
    };
  }

  // OpenAI format
  if (responseBody.usage?.prompt_tokens !== undefined) {
    return {
      prompt_tokens: responseBody.usage.prompt_tokens || 0,
      completion_tokens: responseBody.usage.completion_tokens || 0,
      cached_tokens: responseBody.usage.cached_tokens ?? responseBody.usage.prompt_tokens_details?.cached_tokens,
      reasoning_tokens: responseBody.usage.completion_tokens_details?.reasoning_tokens
    };
  }

  // Gemini format. Antigravity / gemini-cli wrap the payload in { response: {...} }.
  const usageMetadata = responseBody.usageMetadata || responseBody.response?.usageMetadata;
  if (usageMetadata) {
    return {
      prompt_tokens: usageMetadata.promptTokenCount || 0,
      completion_tokens: usageMetadata.candidatesTokenCount || 0,
      cached_tokens: usageMetadata.cachedContentTokenCount || 0,
      reasoning_tokens: usageMetadata.thoughtsTokenCount || 0
    };
  }

  // Ollama format: prompt_eval_count/eval_count at top level (not nested under usage).
  // prompt_eval_cached_count is a cache-read subset of prompt_eval_count (cache-INCLUSIVE).
  if (responseBody.done === true &&
      (responseBody.prompt_eval_count !== undefined || responseBody.eval_count !== undefined)) {
    const prompt = responseBody.prompt_eval_count || 0;
    const completion = responseBody.eval_count || 0;
    const cached = responseBody.prompt_eval_cached_count || 0;
    return {
      prompt_tokens: prompt,
      completion_tokens: completion,
      total_tokens: prompt + completion,
      cached_tokens: cached
    };
  }

  return null;
}

export function buildRequestDetail(base, overrides = {}) {
  return {
    provider: base.provider || "unknown",
    model: base.model || "unknown",
    connectionId: base.connectionId || undefined,
    timestamp: new Date().toISOString(),
    latency: base.latency || { ttft: 0, total: 0 },
    tokens: base.tokens || { prompt_tokens: 0, completion_tokens: 0 },
    request: base.request,
    providerRequest: base.providerRequest || null,
    providerResponse: base.providerResponse || null,
    response: base.response || {},
    pxpipe: base.pxpipe || undefined,
    status: base.status || "success",
    ...overrides
  };
}

// Build the "done" summary: duration, ttft, local prep split, in/out tokens with cache breakdown
export function formatDoneLine({ usage, latency }) {
  const u = usage || {};
  const inTok = u.prompt_tokens ?? u.input_tokens ?? 0;
  const outTok = u.completion_tokens ?? u.output_tokens ?? 0;
  const cacheRead = u.cache_read_input_tokens ?? u.cached_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0;
  const cacheCreate = u.cache_creation_input_tokens ?? 0;
  let inStr = `IN ${inTok}`;
  if (cacheRead || cacheCreate) {
    const parts = [];
    if (cacheRead) parts.push(`↻${cacheRead}`);
    if (cacheCreate) parts.push(`+${cacheCreate}`);
    inStr += ` (CACHE ${parts.join(" ")})`;
  }
  const ttftStr = latency?.ttft ? ` · TTFT ${latency.ttft}ms` : "";
  // PREP = everything the router did before the upstream call; subtracting it from
  // TTFT separates "provider is slow" from "we are slow".
  let prepStr = "";
  if (Number.isFinite(latency?.prep)) {
    const seg = [
      latency.media ? `m${latency.media}` : "",
      latency.translate ? `t${latency.translate}` : "",
      latency.savers ? `s${latency.savers}` : "",
    ].filter(Boolean).join("/");
    prepStr = ` · PREP ${latency.prep}ms${seg ? `(${seg})` : ""}`;
  }
  return `DONE ${latency?.total ?? 0}ms${ttftStr}${prepStr} · ${inStr} · OUT ${outTok}`;
}

export function saveUsageStats({ provider, model, tokens, connectionId, apiKey, endpoint, label = "USAGE", silent = false, status }) {
  const hasTokens = Boolean(tokens) && typeof tokens === "object";
  const inTokens = hasTokens ? (tokens.input_tokens ?? tokens.prompt_tokens ?? 0) : 0;
  const outTokens = hasTokens ? (tokens.output_tokens ?? tokens.completion_tokens ?? 0) : 0;

  // A failure that died before any token came back is exactly the row the operator
  // needs, so an explicit status outranks the empty-usage filter; without it only
  // the console line would ever mention the turn.
  const failed = Boolean(status);
  if (!failed && inTokens === 0 && outTokens === 0) return;

  if (!silent) {
    const time = new Date().toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const accountSuffix = connectionId ? ` | account=${connectionId.slice(0, 8)}...` : "";
    console.log(`${COLORS.green}[${time}] 📊 [${label}] ${provider.toUpperCase()} | in=${inTokens} | out=${outTokens}${accountSuffix}${COLORS.reset}`);
  }

  // Canonicalize to one storage convention (prompt_tokens cache-inclusive) so
  // cached/cache-creation tokens survive to cost calc + stats. See canonicalizeUsage.
  // The fallback covers the failure path, where there is no usage object at all.
  const normalized = canonicalizeUsage(tokens) || { prompt_tokens: inTokens, completion_tokens: outTokens };

  saveRequestUsage({
    provider: provider || "unknown",
    model: model || "unknown",
    tokens: normalized,
    timestamp: new Date().toISOString(),
    connectionId: connectionId || undefined,
    apiKey: apiKey || undefined,
    endpoint: endpoint || null,
    // The usage row is what the recent-logs line and the Usage panel's dot read
    // (appendRequestLog is a no-op since the SQLite migration), so a turn that
    // failed in-band has to say so here or it is filed as "ok" everywhere.
    status: status || undefined
  }).catch(() => {});
}

// A failed upstream attempt spent no tokens, and every other record of it is
// conditional: appendRequestLog is a no-op stub and saveRequestDetail returns
// early when observability is off. usageHistory is the one surface that is always
// on — the recent-logs line and the Usage panel's dot both read it — so failures
// have to be filed here or they never appear anywhere.
export function saveFailureUsage({ provider, model, connectionId, apiKey, endpoint, status }) {
  // 499 is our own "the client hung up" marker. A cancelled turn is not a provider
  // failure, and the streaming path already keeps it out of the failure column —
  // filing it here would paint the Usage panel red for someone who hit stop.
  if (Number(status) === HTTP_STATUS.CLIENT_CLOSED_REQUEST) return;
  saveUsageStats({
    provider, model, tokens: null, connectionId, apiKey, endpoint,
    silent: true, status: `FAILED ${status}`
  });
}

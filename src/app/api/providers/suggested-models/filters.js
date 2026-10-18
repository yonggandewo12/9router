import { normalizeNousFreeModels } from "open-sse/services/nous.js";

// Free OpenCode models that don't use the "-free" id suffix
const KNOWN_FREE_OPENCODE_MODELS = ["big-pickle"];

// Ids /zen/v1/models still lists but that no longer answer. Re-check from the
// deployment network before pruning this set — it is the fallback for hosts without
// the opencode CLI, where the intersection below cannot run.
// deepseek-v4-flash-free: "Model is unavailable" (2026-09-02); the live id is now
// deepseek-v4.1-flash-free, which the CLI does serve.
// jev-1.13-free: every call failed (500 on 2026-09-22, 451 "Endpoint is
// unavailable" on /zen/v1/systemone on 2026-10-15).
// muse-spark-1.2-contributor-free: opencode 1.19.0's own `models opencode` list
// omits it and a real run answers UnknownError (2026-10-15).
const DEAD_FREE_OPENCODE_MODELS = new Set([
  "deepseek-v4-flash-free",
  "jev-1.13-free",
  "muse-spark-1.2-contributor-free",
]);

// Deliberately NOT in the set above: nemotron-3.5-lightning-free. On 2026-10-18
// the HTTP free lane accepted it and then sent nothing — headers, then silence
// past 90s, three runs in a row, while super-vl/longcat/space-bunny answered the
// same body in 2-5s. The model is not dead: `opencode run -m
// opencode/nemotron-3.5-lightning-free` answers normally, so hosts with the CLI
// (which execute() prefers) are fine and hiding it would cost them a working
// model. The stall is specific to /inference/v1, and it is not the only one — see
// the missing first-chunk ceiling in open-sse/executors/base.js.

export const FILTERS = {
  "openrouter-free": (models) =>
    models
      .filter(
        (m) =>
          m.pricing?.prompt === "0" &&
          m.pricing?.completion === "0" &&
          m.context_length >= 200000
      )
      .map((m) => ({ id: m.id, name: m.name, contextLength: m.context_length }))
      .sort((a, b) => b.contextLength - a.contextLength),

  "opencode-free": (models) =>
    models
      .filter((m) => (m.id?.endsWith("-free") || KNOWN_FREE_OPENCODE_MODELS.includes(m.id)) && !DEAD_FREE_OPENCODE_MODELS.has(m.id))
      .map((m) => ({ id: m.id, name: m.id })),

  // Go subscription catalogue — every /models id is selectable; the endpoint lane
  // per model is resolved by the family regex (see open-sse/providers/models/helpers.js)
  "opencode-go": (models) =>
    (Array.isArray(models) ? models : [])
      .filter((m) => typeof m?.id === "string")
      .map((m) => ({ id: m.id, name: m.id })),

  // MiniMax Code (mcode) live catalog: {providers:[{providerId:"minimax",
  // config:{models:{<id>:{name, limit, modalities, thinking_config}}}}]} —
  // arrives wrapped in a single-element array (see route normalization).
  "minimax-code": (raw) => {
    const env = Array.isArray(raw) ? raw[0] : raw;
    const p = (Array.isArray(env?.providers) ? env.providers : []).find((x) => x?.providerId === "minimax");
    const ms = p?.config?.models;
    if (!ms || typeof ms !== "object") return [];
    return Object.entries(ms)
      .filter(([id, m]) => typeof id === "string" && id.trim() !== "" && m && typeof m === "object")
      .map(([id, m]) => ({ id, name: m?.name || id, contextLength: Number(m?.limit?.context) || undefined }))
      .sort((a, b) => (b.contextLength || 0) - (a.contextLength || 0));
  },

  "airforce-free": (models) =>
    (Array.isArray(models) ? models : [])
      .filter((m) => (m.tier === "free" || m.id?.endsWith(":free")) && m.supports_chat === true && (!m.media_type || m.media_type === "chat" || m.media_type === "text"))
      .map((m) => ({ id: m.id, name: m.name || m.id, contextLength: m.context_length }))
      .sort((a, b) => String(a.id).localeCompare(String(b.id))),

  "nous-free": normalizeNousFreeModels,
};

// ZcodeExecutor — ZCode Start Plan (zcode-plan) inference.
//
// The gateway rejects any request whose system prompt differs from the official
// ZCode agent prompt with HTTP 405 + {code:3012,"request has been blocked due to
// unusual activity"} — measured 2026-10-23: dropping tools, metadata or every
// fingerprint header still passes, but a short/synthetic system prompt does not.
// Bisected further 2026-10-24: the gate COUNTS system blocks — the official pair
// plus at most ONE extra block passes; a 4th block is rejected no matter what it
// contains or where cache_control sits. So client system content is folded into
// a single appended block. Requests that already carry the prompt (a real ZCode
// client pointed at this router) are forwarded untouched.
import { DefaultExecutor } from "./default.js";
import { ZCODE_SYSTEM_BLOCKS } from "../shared/zcode/systemPrompt.js";

const ZCODE_PROMPT_MARKER = "You are an interactive ZCode agent";

// Scan blocks instead of joining them: agent system prompts run to 100KB and
// this runs on every request.
function hasZcodePrompt(system) {
  const textOf = (block) =>
    typeof block === "string" ? block : typeof block?.text === "string" ? block.text : "";
  if (typeof system === "string") return system.includes(ZCODE_PROMPT_MARKER);
  if (!Array.isArray(system)) return false;
  return system.some((block) => textOf(block).includes(ZCODE_PROMPT_MARKER));
}

// The gate tolerates the official pair plus AT MOST one extra block. A client
// system that merely QUOTES the marker (e.g. in a custom prompt) is not the
// official layout; forwarded untouched it would exceed the block budget and
// answer 3012. Only a system already within the budget is passed through.
function isOfficialLayout(system) {
  if (typeof system === "string") return system.includes(ZCODE_PROMPT_MARKER);
  if (!Array.isArray(system)) return false;
  return system.length <= 3 && hasZcodePrompt(system);
}

// Client system → one text block. The gate counts system blocks: the official
// pair plus AT MOST one extra passes; a 4th block answers 3012 regardless of
// content or cache_control placement (measured 2026-10-24, bisected live).
// anchorClaudeCache has already pinned the client's LAST system block by the
// time this runs, so the merged block inherits that breakpoint — marker count
// is preserved exactly (N client markers collapse into the 1 we emit), keeping
// the system prefix cacheable without ever exceeding the 4-marker budget.
function clientSystemAsOneBlock(system) {
  if (typeof system === "string") return { text: system, cacheControl: null };
  if (!Array.isArray(system)) return null;
  let cacheControl = null;
  const parts = [];
  for (const block of system) {
    if (typeof block === "string") {
      if (block) parts.push(block);
      continue;
    }
    if (typeof block?.text === "string" && block.text) parts.push(block.text);
    if (block?.cache_control) cacheControl = block.cache_control;
  }
  if (!parts.length) return null;
  return { text: parts.join("\n\n"), cacheControl };
}

export function withZcodeSystemPrompt(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  if (isOfficialLayout(body.system)) return body;
  const merged = clientSystemAsOneBlock(body.system);
  if (merged) {
    return {
      ...body,
      system: [
        ...ZCODE_SYSTEM_BLOCKS,
        {
          type: "text",
          text: merged.text,
          ...(merged.cacheControl ? { cache_control: { ...merged.cacheControl } } : {}),
        },
      ],
    };
  }
  // No usable client text, but a cache_control was still anchored on one of the
  // empty blocks — keep the (last seen) breakpoint on the last official block
  // instead of dropping it entirely.
  let orphanedCacheControl = null;
  if (Array.isArray(body.system)) {
    for (const b of body.system) {
      if (b?.cache_control) orphanedCacheControl = b.cache_control;
    }
  }
  if (!orphanedCacheControl) {
    return { ...body, system: [...ZCODE_SYSTEM_BLOCKS] };
  }
  const blocks = ZCODE_SYSTEM_BLOCKS.map((b, i) =>
    i === ZCODE_SYSTEM_BLOCKS.length - 1 ? { ...b, cache_control: { ...orphanedCacheControl } } : b
  );
  return { ...body, system: blocks };
}

export class ZcodeExecutor extends DefaultExecutor {
  constructor() {
    super("zcode");
  }

  transformRequest(model, body, stream, credentials) {
    return withZcodeSystemPrompt(super.transformRequest(model, body, stream, credentials));
  }
}

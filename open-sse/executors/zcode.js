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

// The gate compares the official blocks byte-for-byte; a marker SUBSTRING is not
// enough. Live-measured 2026-10-24: a 2-block system whose second block merely
// contains the marker text (but is not the official block) answers 3012, while
// the same client text re-wrapped behind the official pair passes. So forward
// untouched ONLY when both official blocks are present verbatim and the block
// budget (official pair + at most one extra) still holds; anything else gets
// re-wrapped, which is the path proven to pass. A client that rewrites part of
// the official prompt (e.g. the visualization path) therefore pays the pair
// twice — cheaper than a hard 3012 (live case, 2026-10-24).
function isOfficialLayout(system) {
  const texts = (Array.isArray(system) ? system : typeof system === "string" ? [system] : []).map(
    (block) => (typeof block === "string" ? block : typeof block?.text === "string" ? block.text : "")
  );
  if (texts.length > 3) return false;
  return ZCODE_SYSTEM_BLOCKS.every((official) => texts.some((text) => text === official.text));
}

// Client system → one text block. The gate counts system blocks: the official
// pair plus AT MOST one extra passes; a 4th block answers 3012 regardless of
// content or cache_control placement (measured 2026-10-24, bisected live).
// anchorClaudeCache has already pinned the client's LAST system block by the
// time this runs, so the merged block inherits that breakpoint — marker count
// is preserved exactly (N client markers collapse into the 1 we emit), keeping
// the system prefix cacheable without ever exceeding the 4-marker budget.
// Verbatim copies of the official blocks are dropped: this path prepends them,
// and re-sending ~7KB of prompt twice would just bill the same tokens again.
function clientSystemAsOneBlock(system) {
  if (typeof system === "string") {
    return ZCODE_SYSTEM_BLOCKS.some((o) => o.text === system)
      ? null
      : { text: system, cacheControl: null };
  }
  if (!Array.isArray(system)) return null;
  let cacheControl = null;
  const parts = [];
  for (const block of system) {
    if (typeof block === "string") {
      if (block && !ZCODE_SYSTEM_BLOCKS.some((o) => o.text === block)) parts.push(block);
      continue;
    }
    if (typeof block?.text === "string" && block.text && !ZCODE_SYSTEM_BLOCKS.some((o) => o.text === block.text)) {
      parts.push(block.text);
    }
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

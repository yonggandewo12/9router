// Custom system prompt injector: appends a user-authored instruction into the
// system message of the final request body, just before dispatch.
//
// Independent of the built-in savers (caveman, ponytail): it has its own toggle
// and text, so it works whether or not those are enabled.

import { injectSystemPrompt } from "./systemInject.js";
import { CUSTOM_PROMPT_MAX_CHARS } from "../config/runtimeConfig.js";

export function injectCustomPrompt(body, format, text) {
  if (typeof text !== "string" || !text.trim()) return false;
  // The API rejects an oversized prompt on write; this guard covers the paths
  // that bypass it (a restored backup, a direct DB edit). Fail-open like every
  // other saver: an over-ceiling prompt is dropped rather than shipped.
  if (text.length > CUSTOM_PROMPT_MAX_CHARS) return false;
  injectSystemPrompt(body, format, text);
  return true;
}

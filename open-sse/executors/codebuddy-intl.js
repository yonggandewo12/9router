import { DefaultExecutor } from "./default.js";
import { refreshCodebuddyIntlToken } from "../services/tokenRefresh/providers.js";
import { applyReasoningFloor, recordRetirement } from "../services/codebuddyModels.js";

const PROVIDER_ID = "codebuddy-intl";

/**
 * CodeBuddyIntlExecutor — talks to https://www.codebuddy.ai/v2/chat/completions
 *
 * Same OpenAI-compatible-but-stream-only gateway behavior as codebuddy-cn:
 * non-stream requests are rejected, and reasoning is surfaced only when the
 * request carries the IDE's OpenAI-style reasoning params. Force stream and
 * mirror reasoning_summary exactly like CodeBuddyExecutor.
 */
export class CodeBuddyIntlExecutor extends DefaultExecutor {
  constructor() {
    super("codebuddy-intl");
  }

  // See CodeBuddyExecutor: without this a 401 could not refresh at all,
  // because DefaultExecutor's refresher table knows neither CodeBuddy host.
  async refreshCredentials(credentials, log, proxyOptions = null) {
    if (!credentials?.refreshToken) return false;
    return refreshCodebuddyIntlToken(credentials.refreshToken, log, proxyOptions);
  }

  transformRequest(model, body, stream, credentials) {
    const transformed = super.transformRequest(model, body, stream, credentials);
    transformed.stream = true;

    const eff = transformed.reasoning_effort;
    if (eff === "none" || eff === "off") {
      delete transformed.reasoning_effort;
    } else if (eff) {
      transformed.reasoning_summary = "auto";
    }
    // Same gateway family as codebuddy-cn: ids that refuse a request carrying no
    // reasoning_effort would otherwise be dead ends for plain clients.
    applyReasoningFloor(PROVIDER_ID, model, transformed);

    // CodeBuddy rejects plain OpenAI shape (11101 invalid request): needs a
    // leading system prompt + user content as typed blocks, not a bare string.
    const source = Array.isArray(transformed.messages) ? transformed.messages : [];
    transformed.messages = [{ role: "system", content: "You are CodeBuddy Code." }];
    for (const message of source) {
      if (!message || typeof message !== "object" || ["system", "developer"].includes(message.role)) continue;
      if (message.role === "user" && typeof message.content === "string") {
        transformed.messages.push({ ...message, content: [{ type: "text", text: message.content }] });
      } else {
        transformed.messages.push({ ...message });
      }
    }

    // Same gateway family as cn: tool_choice is a plain string on the gateway's
    // Go struct, so the OpenAI object form is refused (400/11101). Downgrade to
    // "required" to keep the must-call-a-tool intent (see codebuddy-cn.js).
    if (transformed.tool_choice && typeof transformed.tool_choice === "object") {
      transformed.tool_choice = "required";
    }

    return transformed;
  }
  parseError(response, bodyText) {
    if (bodyText) {
      try {
        const data = JSON.parse(bodyText);
        const msg = data?.msg || data?.message || data?.error?.message || "";
        // Same retirement learning as codebuddy-cn — the gateway names the model in the
        // error text, and the intl catalog is a different table, so the verdict has to be
        // recorded under this provider's own id.
        recordRetirement(PROVIDER_ID, data);
        // 11115 = prompt past this model's real ceiling; surface 413 (oversized
        // request) rather than a generic 400 the client might retry. Mirrors cn.
        if (String(data?.code ?? "") === "11115") {
          return { status: 413, message: msg || "CodeBuddy prompt is too long for this model (11115)" };
        }
        if (data?.code === 6004 || /超出频率限制|frequency limit|限额/i.test(msg)) {
          let resetsAtMs = null;
          const match = msg.match(/(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})(?:\s*UTC\+?([0-9:]+))?/i);
          if (match) {
            const dp = match[1];
            const tp = match[2];
            const tz = match[3]
              ? (match[3].includes(":") ? (match[3].startsWith("+") ? match[3] : `+${match[3]}`) : `+${match[3].padStart(2, "0")}:00`)
              : "+08:00";
            const dt = new Date(`${dp}T${tp}${tz}`);
            if (!isNaN(dt.getTime())) resetsAtMs = dt.getTime();
          }
          return {
            status: 429,
            message: msg || "CodeBuddy frequency limit (6004)",
            resetsAtMs,
          };
        }
      } catch {}
    }
    return super.parseError(response, bodyText);
  }
}

export default CodeBuddyIntlExecutor;

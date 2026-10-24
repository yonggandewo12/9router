// A5 (cases #7/#9/#10): lock hardcode->config no-op values.
import { describe, it, expect } from "vitest";
import {
  OPENAI_COMPAT_BASE,
  ANTHROPIC_COMPAT_BASE,
  ANTHROPIC_API_VERSION,
} from "../../open-sse/providers/shared.js";
import { DEFAULT_MAX_TOKENS, DEFAULT_MIN_TOKENS } from "../../open-sse/config/runtimeConfig.js";
import opencode from "../../open-sse/providers/registry/opencode.js";
import antigravity from "../../open-sse/providers/registry/antigravity.js";
import { OpenCodeExecutor } from "../../open-sse/executors/opencode.js";

describe("compat base URLs / version", () => {
  it("OPENAI_COMPAT_BASE", () => {
    expect(OPENAI_COMPAT_BASE).toBe("https://api.openai.com/v1");
  });
  it("ANTHROPIC_COMPAT_BASE", () => {
    expect(ANTHROPIC_COMPAT_BASE).toBe("https://api.anthropic.com/v1");
  });
  it("ANTHROPIC_API_VERSION", () => {
    expect(ANTHROPIC_API_VERSION).toBe("2023-06-01");
  });
});

describe("default token limits", () => {
  it("max/min", () => {
    expect(DEFAULT_MAX_TOKENS).toBe(64000);
    expect(DEFAULT_MIN_TOKENS).toBe(32000);
  });
});

describe("provider baseUrl const (full path, no trailing slash)", () => {
  it("opencode no trailing slash", () => {
    expect(opencode.transport.baseUrl).toBe("https://opencode.ai");
  });
});

// 429 was 6 after the June registry migration; the maintainer lowered it to 3 in
// 3f9382de ("Fix AG, Kiro, Xiaomi Provider"); it has been 3 since.
describe("antigravity retry (429=3, 503=3)", () => {
  it("429 attempts = 3", () => {
    expect(antigravity.transport.retry["429"].attempts).toBe(3);
  });
  it("503 attempts = 3", () => {
    expect(antigravity.transport.retry["503"].attempts).toBe(3);
  });
});

describe("OpenCode Free endpoint routing", () => {
  // 1.2-contributor-free was retired from the curated list (opencode 1.19.0's CLI
  // dropped it) but stays a valid family-matched id, so routing is asserted for both.
  const MUSE = "muse-spark-1.3-contributor-free";

  it("declares the Responses format on the curated Muse Spark model", () => {
    expect(opencode.transport.format).toBeUndefined();
    expect(opencode.models.find((m) => m.id === MUSE)?.targetFormat).toBe("openai-responses");
    expect(opencode.models.map((m) => m.id)).not.toContain("muse-spark-1.2-contributor-free");
    expect(opencode.models.map((m) => m.id)).not.toContain("jev-1.13-free");
  });

  it("routes Muse Spark to /responses and every other model to /chat/completions", () => {
    const executor = new OpenCodeExecutor();
    expect(executor.buildUrl(MUSE)).toBe("https://opencode.ai/inference/v1/responses");
    expect(executor.buildUrl(`${MUSE}(xhigh)`)).toBe("https://opencode.ai/inference/v1/responses");
    expect(executor.buildUrl("muse-spark-1.3-contributor-free")).toBe("https://opencode.ai/inference/v1/responses");
    expect(executor.buildUrl("muse-spark-1.4-contributor-free")).toBe("https://opencode.ai/inference/v1/responses");
    expect(executor.buildUrl("muse-spark-2.0-contributor-free(xhigh)")).toBe("https://opencode.ai/inference/v1/responses");
    expect(executor.buildUrl("big-pickle")).toBe("https://opencode.ai/inference/v1/chat/completions");
    expect(executor.buildUrl("hy3-free")).toBe("https://opencode.ai/inference/v1/chat/completions");
    // Family-matched passthrough ids are translated to a Responses body by chatCore
    // (getModelTargetFormat), so the URL has to follow the same rule — a hardcoded
    // model list here sent `input` to /chat/completions and upstream rejected it.
    expect(executor.buildUrl("gpt-5.6-luna")).toBe("https://opencode.ai/inference/v1/responses");
    expect(executor.buildUrl("grok-4.6(xhigh)")).toBe("https://opencode.ai/inference/v1/responses");
    const body = { input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }], max_tokens: 128 };
    executor.transformRequest("gpt-5.6-luna", body, true, {});
    expect(body.store).toBe(false);
    expect(body.max_output_tokens).toBe(128);
  });

  it("normalizes Chat token/thinking fields only for the Responses model", () => {
    const executor = new OpenCodeExecutor();
    const muse = { max_tokens: 4096, reasoning_effort: "high" };
    executor.transformRequest(MUSE, muse, true, {});
    expect(muse.max_output_tokens).toBe(4096);
    expect(muse.max_tokens).toBeUndefined();
    expect(muse.reasoning).toEqual({ effort: "high", summary: "auto" });

    const chat = { max_tokens: 4096, reasoning_effort: "high" };
    executor.transformRequest("big-pickle", chat, true, {});
    expect(chat.max_tokens).toBe(4096);
    expect(chat.max_output_tokens).toBeUndefined();
    expect(chat.reasoning_effort).toBe("high");
  });
});

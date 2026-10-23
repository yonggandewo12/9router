// ZCode Start Plan — the zcode-plan lane only accepts the official ZCode
// agent system prompt (else HTTP 405 {code:3012}); everything else — tools,
// metadata, fingerprint headers — is optional. These tests pin the transport
// wiring and the prompt gate.
import { describe, it, expect } from "vitest";

import { PROVIDERS, PROVIDER_MODELS, PROVIDER_OAUTH } from "open-sse/providers/index.js";
import { withZcodeSystemPrompt, ZcodeExecutor } from "open-sse/executors/zcode.js";
import { getExecutor } from "open-sse/executors/index.js";
import { ZCODE_SYSTEM_BLOCKS } from "open-sse/shared/zcode/systemPrompt.js";

const LANE = "https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages";
// What a real ZCode client puts in front of the long agent instructions.
const MARKER_LINE = ZCODE_SYSTEM_BLOCKS[1].text.split("\n").filter(Boolean)[0];

describe("zcode provider wiring", () => {
  it("targets the zcode-plan anthropic lane with bearer auth", () => {
    expect(PROVIDERS.zcode.baseUrl).toBe(LANE);
    expect(PROVIDERS.zcode.format).toBe("claude");
    expect(PROVIDERS.zcode.auth).toMatchObject({
      combined: true,
      header: "Authorization",
      scheme: "bearer",
    });
  });

  it("exposes only the models the Start Plan allows", () => {
    expect(PROVIDER_MODELS.zcode.map((m) => m.id)).toEqual(["GLM-5.3-Flash", "GLM-5.3"]);
  });

  it("reuses the ZCode CLI polling OAuth", () => {
    expect(PROVIDER_OAUTH.zcode.cliInitUrl).toBe("https://zcode.z.ai/api/v1/oauth/cli/init");
    expect(PROVIDER_OAUTH.zcode.cliPollUrl).toBe("https://zcode.z.ai/api/v1/oauth/cli/poll");
    expect(PROVIDER_OAUTH.zcode.refresh).toBeUndefined();
  });
});

describe("zcode system-prompt gate", () => {
  // The upstream gate only ever sees these bytes, so the constant itself is
  // pinned here — a dropped/reworded block answers 3012 at runtime and no
  // other test in the suite would notice.
  it("carries both official blocks, unmodified", () => {
    expect(ZCODE_SYSTEM_BLOCKS).toHaveLength(2);
    expect(ZCODE_SYSTEM_BLOCKS[0]).toEqual({
      type: "text",
      text: "You are ZCode, an interactive coding agent",
    });
    expect(ZCODE_SYSTEM_BLOCKS[1].text).toContain("You are an interactive ZCode agent");
    expect(ZCODE_SYSTEM_BLOCKS[1].text.length).toBeGreaterThan(2500);
    // Machine-specific values must never be baked into a shipped constant.
    for (const block of ZCODE_SYSTEM_BLOCKS) {
      expect(block.text).not.toMatch(/\/(Users|home|var\/folders)\//);
    }
  });

  it("prepends the official prompt when the request has none", () => {
    const out = withZcodeSystemPrompt({ messages: [{ role: "user", content: "hi" }] });
    expect(out.system).toEqual(ZCODE_SYSTEM_BLOCKS);
  });

  it("keeps the client's system prompt after the injected one", () => {
    const out = withZcodeSystemPrompt({ system: "be terse", messages: [] });
    expect(out.system).toHaveLength(ZCODE_SYSTEM_BLOCKS.length + 1);
    expect(out.system.slice(0, -1)).toEqual(ZCODE_SYSTEM_BLOCKS);
    expect(out.system.at(-1)).toEqual({ type: "text", text: "be terse" });
  });

  // The 3012 gate counts system blocks: official pair + AT MOST one extra.
  // Bisected live 2026-10-24: 3 blocks pass, a 4th is rejected regardless of
  // content or cache_control. Multi-block client systems must collapse to one,
  // and the cache breakpoint anchorClaudeCache put on the client's last system
  // block must survive the merge — otherwise the system prefix stops caching.
  it("collapses a multi-block client system into a single appended block", () => {
    const out = withZcodeSystemPrompt({
      system: [
        { type: "text", text: "You are Codex, an agent." },
        { type: "text", text: "Second guidance block." },
        { type: "text", text: "Third guidance block.", cache_control: { type: "ephemeral", ttl: "1h" } },
      ],
      messages: [],
    });
    expect(out.system).toHaveLength(ZCODE_SYSTEM_BLOCKS.length + 1);
    expect(out.system.slice(0, -1)).toEqual(ZCODE_SYSTEM_BLOCKS);
    expect(out.system.at(-1).text).toBe(
      "You are Codex, an agent.\n\nSecond guidance block.\n\nThird guidance block."
    );
    expect(out.system.at(-1).cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  it("drops cache_control when the client system carried none", () => {
    const out = withZcodeSystemPrompt({ system: "be terse", messages: [] });
    expect(out.system.at(-1).cache_control).toBeUndefined();
  });

  it("leaves a real ZCode system prompt untouched", () => {
    const body = {
      system: [{ type: "text", text: "You are an interactive ZCode agent that helps" }],
      messages: [],
    };
    expect(withZcodeSystemPrompt(body)).toBe(body);
  });

  it("returns non-object bodies as-is", () => {
    expect(withZcodeSystemPrompt(null)).toBe(null);
    expect(withZcodeSystemPrompt("raw")).toBe("raw");
  });

  it("is selected for the zcode provider", () => {
    expect(new ZcodeExecutor().getProvider()).toBe("zcode");
  });

  // Without this the registry could fall back to DefaultExecutor and every
  // request would hit the 3012 gate while the unit tests stayed green.
  it("is dispatched by getExecutor", () => {
    expect(getExecutor("zcode")).toBeInstanceOf(ZcodeExecutor);
  });

  // The gate lives on the executor path (transformRequest), not on the helper —
  // a helper-only test would stay green if the executor stopped calling it.
  it("injects through the executor's transformRequest", () => {
    const out = new ZcodeExecutor().transformRequest(
      "GLM-5.3-Flash",
      { model: "GLM-5.3-Flash", max_tokens: 32, messages: [{ role: "user", content: "hi" }] },
      true,
      { accessToken: "tok" }
    );
    expect(out.system.slice(0, ZCODE_SYSTEM_BLOCKS.length)).toEqual(ZCODE_SYSTEM_BLOCKS);
    expect(out.max_tokens).toBe(32);
  });

  it("does not double-inject through the executor's transformRequest", () => {
    const body = {
      model: "GLM-5.3",
      max_tokens: 32,
      system: [{ type: "text", text: `You are ZCode, an interactive coding agent\n${MARKER_LINE}` }],
      messages: [{ role: "user", content: "hi" }],
    };
    const out = new ZcodeExecutor().transformRequest("GLM-5.3", body, true, { accessToken: "tok" });
    expect(out.system).toHaveLength(1);
  });

  // Malformed blocks (non-string text) must not crash the request path — they
  // are dropped from the merged client block; the lane still gets its prompt.
  it("tolerates malformed system blocks", () => {
    const out = withZcodeSystemPrompt({
      system: [{ type: "text", text: 42 }, null, "plain string block"],
      messages: [],
    });
    expect(out.system).toHaveLength(ZCODE_SYSTEM_BLOCKS.length + 1);
    expect(out.system.at(-1)).toEqual({ type: "text", text: "plain string block" });
    expect(withZcodeSystemPrompt({ system: [{ type: "text" }], messages: [] }).system).toEqual(
      ZCODE_SYSTEM_BLOCKS
    );
  });
});

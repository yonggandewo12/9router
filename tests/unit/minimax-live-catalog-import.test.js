/**
 * Live-catalog import path for MiniMax (73441fb2).
 * Locks the cross-file contract: the models route emits "<providerId>/<id>"
 * and the provider page strips exactly `${providerId}/` before writing custom
 * rows — a prefix drift would silently break one-click import.
 */

import { describe, it, expect } from "vitest";
import {
  createOpenAIModelsConfig,
  PROVIDER_MODELS_CONFIG,
} from "../../src/app/api/providers/[id]/models/route.js";

describe("createOpenAIModelsConfig providerPrefix", () => {
  it("namespaces ids when a prefix is given", () => {
    const parsed = createOpenAIModelsConfig("https://x/v1/models", "minimax-cn")
      .parseResponse({ data: [{ id: "MiniMax-M2.7-highspeed", display_name: "M2.7 HS" }] });
    expect(parsed[0].id).toBe("minimax-cn/MiniMax-M2.7-highspeed");
    expect(parsed[0].name).toBe("M2.7 HS");
  });

  it("falls back to the bare id for the name", () => {
    const parsed = createOpenAIModelsConfig("https://x/v1/models", "minimax")
      .parseResponse({ data: [{ id: "MiniMax-M3" }] });
    expect(parsed[0].name).toBe("MiniMax-M3");
  });

  it("leaves ids untouched when no prefix is configured", () => {
    const parsed = createOpenAIModelsConfig("https://x/v1/models")
      .parseResponse({ data: [{ id: "gpt-x" }] });
    expect(parsed[0].id).toBe("gpt-x");
  });

  it("passes models without an id through unchanged", () => {
    const junk = { name: "no-id" };
    const parsed = createOpenAIModelsConfig("https://x/v1/models", "minimax")
      .parseResponse({ data: [junk] });
    expect(parsed[0]).toBe(junk);
  });
});

describe("MiniMax live-catalog wiring", () => {
  it("keeps the two regions on separate endpoints and prefixes", () => {
    expect(PROVIDER_MODELS_CONFIG.minimax.url).toBe("https://api.minimax.io/v1/models");
    expect(PROVIDER_MODELS_CONFIG["minimax-cn"].url).toBe("https://api.minimaxi.com/v1/models");
    const ids = PROVIDER_MODELS_CONFIG["minimax-cn"].parseResponse({ data: [{ id: "MiniMax-M3" }] });
    expect(ids[0].id).toBe("minimax-cn/MiniMax-M3");
  });

  it("page-side strip reverses the route-side prefix for both aliases", () => {
    for (const providerId of ["minimax", "minimax-cn"]) {
      const emitted = PROVIDER_MODELS_CONFIG[providerId]
        .parseResponse({ data: [{ id: "MiniMax-M2.5-highspeed" }] })[0].id;
      const prefix = `${providerId}/`;
      const cleaned = emitted.startsWith(prefix) ? emitted.slice(prefix.length) : emitted;
      expect(cleaned).toBe("MiniMax-M2.5-highspeed");
    }
  });
});

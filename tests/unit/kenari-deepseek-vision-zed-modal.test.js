/**
 * Tests for two independent frontend/capabilities fixes:
 *
 * #4293 — deepseek-v4-1-flash (hyphen) has vision=false
 *   Kenari exposes the model under the ID "deepseek-v4-1-flash" (dash instead
 *   of dot).  The capabilities table only had "deepseek-v4.1-flash" (dot), so
 *   the hyphenated variant fell through to the generic *deepseek* pattern which
 *   has vision:false.  Fix: add "deepseek-v4-1-flash" as an alias with the same
 *   vision:true entry.
 *
 * #4244 — Zed missing from SelectModelModal LIVE_CATALOG_PROVIDERS
 *   The hardcoded list ["cursor","cline","clinepass"] omitted "zed", so the
 *   Zed provider card was never fetched and never shown in the Combo picker.
 *   Fix: add "zed" to the list (and wire up the corresponding state/hook/ternary).
 */

import { describe, it, expect, beforeAll } from "vitest";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";

// ── #4293 deepseek-v4-1-flash vision capability ───────────────────────────

describe("deepseek-v4-1-flash capabilities (#4293)", () => {
  it("reports vision:true for the hyphenated deepseek-v4-1-flash id (Kenari variant)", () => {
    // Any provider that uses the hyphenated id should get vision:true
    const caps = getCapabilitiesForModel("kenari", "deepseek-v4-1-flash");
    expect(caps.vision).toBe(true);
  });

  it("still reports vision:true for the dotted deepseek-v4.1-flash id", () => {
    const caps = getCapabilitiesForModel("ollama", "deepseek-v4.1-flash");
    expect(caps.vision).toBe(true);
  });

  it("still reports reasoning:true for deepseek-v4-1-flash", () => {
    const caps = getCapabilitiesForModel("kenari", "deepseek-v4-1-flash");
    expect(caps.reasoning).toBe(true);
  });

  it("reports the correct contextWindow (1M) for deepseek-v4-1-flash", () => {
    const caps = getCapabilitiesForModel("kenari", "deepseek-v4-1-flash");
    expect(caps.contextWindow).toBe(1000000);
  });
});

// ── #4244 + cbcn/hy4free: one live-catalog list for both surfaces ─────────
// ModelSelectModal.js is JSX so we cannot import it in Vitest without a
// JSX transform.  Read the source text instead, and import the shared constant
// the picker is required to derive its list from.

import fs from "fs";
import { LIVE_CATALOG_PROVIDERS } from "../../src/shared/constants/providers.js";

describe("ModelSelectModal resolves its live catalogs from the shared constant", () => {
  let src;
  beforeAll(() => {
    const fileUrl = new URL("../../src/shared/components/ModelSelectModal.js", import.meta.url);
    src = fs.readFileSync(fileUrl, "utf-8");
  });

  it("lists every provider whose account catalog the picker must fetch", () => {
    // Zed was missing in #4244; CodeBuddy's live-only ids (hy4free, space-bunny,
    // step-5-preview) were invisible here while the provider page showed them.
    for (const id of ["cursor", "zed", "codebuddy-cn", "codebuddy-intl"]) {
      expect([...LIVE_CATALOG_PROVIDERS]).toContain(id);
    }
  });

  it("unions the shared constant instead of forking a provider list", () => {
    expect(src).toContain("SHARED_LIVE_CATALOG_PROVIDERS");
    expect(src).toMatch(/const LIVE_CATALOG_PROVIDERS\s*=\s*\[\.\.\.new Set\(\[\.\.\.SHARED_LIVE_CATALOG_PROVIDERS/);
    // cline/ClinePass have resolvers the shared set does not list yet
    expect(src).toContain('"cline", "clinepass"');
  });

  it("looks the catalog up by provider id, with no per-provider hook or ternary", () => {
    expect(src).toContain("liveModelsByProvider[providerId]");
    expect(src).not.toMatch(/providerId === "cursor" \? cursorModels/);
    expect(src).not.toContain("useLiveProviderModels(");
  });
});

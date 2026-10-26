// The combo/LLM model selector used to list every connected provider's chat
// models when no kindFilter was set, ignoring serviceKinds — that is how three
// gemini-web chat models (provider since removed) ended up in "add
// models to combo". muse-web, grok-web and the parked perplexity-web still
// declare chat models without declaring "llm", so the rule still matters.
//
// The rule lives in listsProviderCatalog(); ModelSelectModal.js is JSX so the
// picker wiring itself is only covered by the source tripwires at the bottom.

import { describe, it, expect, beforeAll } from "vitest";
import fs from "fs";
import { parse } from "@babel/parser";
import {
  AI_PROVIDERS,
  providerSupportsKind,
  listsProviderCatalog,
  getProvidersByKind,
} from "@/shared/constants/providers.js";

describe("providerSupportsKind", () => {
  it("rejects image-only providers for the LLM list", () => {
    expect(providerSupportsKind("muse-web", "llm")).toBe(false);
  });

  it("keeps image-only providers selectable for their own kind", () => {
    expect(providerSupportsKind("muse-web", "image")).toBe(true);
  });

  it("keeps LLM-capable web providers (chatgpt-web) in the LLM list", () => {
    expect(providerSupportsKind("chatgpt-web", "llm")).toBe(true);
  });

  it("treats providers without serviceKinds as LLM", () => {
    expect(providerSupportsKind("gemini-cli", "llm")).toBe(true);
  });

  it("treats unknown/custom provider ids as LLM", () => {
    expect(providerSupportsKind("openai-compatible-chat-deadbeef", "llm")).toBe(true);
  });

  it("treats an empty serviceKinds as parked: no kind matches", () => {
    // perplexity-web declares serviceKinds: [] to stay out of dashboard lists.
    expect(providerSupportsKind("perplexity-web", "llm")).toBe(false);
    expect(providerSupportsKind("perplexity-web", "image")).toBe(false);
  });

  it("honours hiddenKinds", () => {
    // No registry entry makes hiddenKinds reachable today (huggingface hides a
    // "tts" kind it never declares), so probe the rule with a synthetic
    // provider instead of asserting a value that passes either way.
    AI_PROVIDERS.__probe = { id: "__probe", serviceKinds: ["llm", "image"], hiddenKinds: ["image"] };
    try {
      expect(providerSupportsKind("__probe", "llm")).toBe(true);
      expect(providerSupportsKind("__probe", "image")).toBe(false);
      expect(listsProviderCatalog("__probe", "image")).toBe(false);
    } finally {
      delete AI_PROVIDERS.__probe;
    }
  });

  it("handles a missing/undefined provider id without throwing", () => {
    expect(providerSupportsKind(undefined, "llm")).toBe(true);
    expect(providerSupportsKind("", "llm")).toBe(true);
  });
});

describe("getProvidersByKind (shared rule, other consumers)", () => {
  const ids = (kind) => getProvidersByKind(kind).map((p) => p.id);

  it("still lists media-only providers under their own kind", () => {
    expect(ids("image")).toContain("muse-web");
    expect(ids("image")).toContain("grok-web");
  });

  it("excludes media-only and parked providers from the llm list", () => {
    const llm = ids("llm");
    expect(llm).not.toContain("muse-web");
    expect(llm).not.toContain("perplexity-web");
    expect(llm).toContain("chatgpt-web");
  });

  it("keeps hidden providers out of every kind list", () => {
    for (const kind of ["llm", "image", "tts", "stt"]) {
      expect(ids(kind)).not.toContain("sambanova");
    }
  });
});

describe("listsProviderCatalog (what a picker may list from the registry)", () => {
  it("hides a media-only provider's chat catalog from the LLM picker", () => {
    expect(listsProviderCatalog("muse-web", null)).toBe(false);
  });

  it("shows that same catalog in the picker for its declared kind", () => {
    expect(listsProviderCatalog("muse-web", "image")).toBe(true);
  });

  it("hides a parked provider (serviceKinds: []) from every picker", () => {
    expect(listsProviderCatalog("perplexity-web", null)).toBe(false);
    expect(listsProviderCatalog("perplexity-web", "image")).toBe(false);
  });

  it("keeps LLM-capable web providers in the LLM picker", () => {
    expect(listsProviderCatalog("chatgpt-web", null)).toBe(true);
  });

  it("keeps unknown/custom provider ids in the LLM picker", () => {
    expect(listsProviderCatalog("openai-compatible-chat-deadbeef", null)).toBe(true);
  });
});

describe("ModelSelectModal wires the catalog rule into both grouping branches", () => {
  let src;
  beforeAll(() => {
    const fileUrl = new URL("../../src/shared/components/ModelSelectModal.js", import.meta.url);
    src = fs.readFileSync(fileUrl, "utf-8");
  });

  it("routes the gate through listsProviderCatalog", () => {
    expect(src).toMatch(/const listsKind = \(providerId\) => listsProviderCatalog\(providerId, kindFilter\)/);
  });

  it("gates the passthrough branch's hardcoded catalog", () => {
    expect(src).toMatch(/const hardcoded = listsKind\(providerId\)\s*\n?\s*\? getModelsByProviderId\(providerId\)/);
  });

  it("gates the regular branch's hardcoded/live catalog", () => {
    expect(src).toMatch(/const hardcodedModels = !listsKind\(providerId\)/);
  });

  it("still filters connections by kind when a kindFilter is set", () => {
    expect(src).toMatch(/if \(!kindFilter\) return activeOnly;/);
    expect(src).toMatch(/providerSupportsKind\(p\.provider, kindFilter\)/);
  });

  // The assertions above are text matches, so they cannot see a syntax error —
  // wrapping these chains in a ternary produced exactly one (a `.filter()` left
  // dangling after `: [];`) with every regex still green.
  it("is still valid JSX", () => {
    expect(() => parse(src, { sourceType: "module", plugins: ["jsx"] })).not.toThrow();
  });
});

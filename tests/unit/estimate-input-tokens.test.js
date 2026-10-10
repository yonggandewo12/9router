/**
 * estimateInputTokens runs on the stream tail for every provider that doesn't
 * report usage. It used to JSON.stringify the whole request body and divide by 4,
 * which is fine for prose and ruinous for images: a 1MB base64 screenshot became
 * ~250K "prompt tokens", inflating both the cost record and the client's view of
 * how full its context window is.
 */
import { describe, expect, it } from "vitest";

import { estimateInputTokens } from "../../open-sse/utils/usageTracking.js";

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function base64(chars) {
  let out = "";
  for (let i = 0; i < chars; i++) out += BASE64_ALPHABET[i % 64];
  return out;
}

describe("estimateInputTokens", () => {
  it("prices prose at roughly four characters per token", () => {
    const text = "the quick brown fox jumps over the lazy dog. ".repeat(200); // 9000 chars, whitespace-heavy
    const tokens = estimateInputTokens({ model: "gpt-5", messages: [{ role: "user", content: text }] });
    expect(tokens).toBeGreaterThan(2100);
    expect(tokens).toBeLessThan(2600);
  });

  it("ignores the size of a base64 image payload", () => {
    const oneMb = base64(1_000_000);
    const tokens = estimateInputTokens({
      messages: [{ role: "user", content: [{ type: "text", text: "what is in this picture?" }, {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: oneMb },
      }] }],
    });
    // One vision allowance plus the short prompt — not a quarter of a megabyte.
    expect(tokens).toBeLessThan(2000);
    expect(tokens).toBeGreaterThan(1000);
  });

  it("treats a data: URL as one image too", () => {
    const dataUrl = `data:image/png;base64,${base64(500_000)}`;
    const asImage = estimateInputTokens({ input: [{ type: "image_url", image_url: { url: dataUrl } }] });
    expect(asImage).toBeLessThan(2000);
  });

  it("treats Gemini inlineData as one media item", () => {
    const tokens = estimateInputTokens({
      contents: [{ role: "user", parts: [{ inlineData: { mimeType: "image/png", data: base64(800_000) } }] }],
    });
    expect(tokens).toBeLessThan(2000);
  });

  it("scales with the number of images", () => {
    const payload = base64(200_000);
    const shot = { type: "image", source: { type: "base64", media_type: "image/png", data: payload } };
    const one = estimateInputTokens({ messages: [{ role: "user", content: [shot] }] });
    const three = estimateInputTokens({ messages: [{ role: "user", content: [shot, shot, shot] }] });
    expect(three - one).toBeGreaterThan(1500);
  });

  // The allowance is for a payload the provider DECODES. Long text the model actually
  // reads — minified JSON, a single-line code blob, a bare base64 dump in a tool
  // result — has no whitespace either, and pricing it as one image under-bills ~50x.
  it("counts long whitespace-free text as text, not as media", () => {
    const minified = `{"k":"${"v".repeat(200_000)}"}`;
    const asText = estimateInputTokens({ messages: [{ role: "tool", content: minified }] });
    expect(asText).toBeGreaterThan(40_000);

    const notBase64 = `data:text/plain,${"x".repeat(100_000)}`;
    expect(estimateInputTokens({ messages: [{ role: "user", content: notBase64 }] })).toBeGreaterThan(20_000);
  });

  it("still counts structured config that has no payload", () => {
    const empty = estimateInputTokens({ model: "gpt-5" });
    const withTools = estimateInputTokens({
      model: "gpt-5",
      tools: [{ type: "function", function: { name: "search", description: "Search the web", parameters: { type: "object" } } }],
    });
    expect(withTools).toBeGreaterThan(empty);
  });

  it("returns 0 for a non-object body", () => {
    expect(estimateInputTokens(null)).toBe(0);
    expect(estimateInputTokens("hello")).toBe(0);
  });
});

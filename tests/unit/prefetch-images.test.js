import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { fetchImageMock } = vi.hoisted(() => ({
  fetchImageMock: vi.fn(),
}));

vi.mock("../../open-sse/translator/concerns/image.js", async (orig) => {
  const actual = await orig();
  return { ...actual, fetchImageAsBase64: fetchImageMock };
});

import { prefetchRemoteImages } from "../../open-sse/translator/concerns/prefetch.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

function inlineImageMock() {
  fetchImageMock.mockImplementation(async () => ({ url: "data:image/png;base64,QUJD", mimeType: "image/png" }));
}

beforeEach(() => { fetchImageMock.mockReset(); inlineImageMock(); });
afterEach(() => { vi.restoreAllMocks(); });

describe("prefetchRemoteImages", () => {
  it("no-op for targets that accept remote URLs (openai)", async () => {
    const body = { messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://x/a.png" } }] }] };
    const n = await prefetchRemoteImages(body, FORMATS.OPENAI, FORMATS.OPENAI);
    expect(n).toBe(0);
    expect(body.messages[0].content[0].image_url.url).toBe("https://x/a.png");
  });

  it("openai source -> ollama target: converts remote URL to base64", async () => {
    const body = { messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://x/a.png" } }] }] };
    const n = await prefetchRemoteImages(body, FORMATS.OPENAI, FORMATS.OLLAMA);
    expect(n).toBe(1);
    expect(body.messages[0].content[0].image_url.url.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("skips data URI (already inline)", async () => {
    const body = { messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,xx" } }] }] };
    const n = await prefetchRemoteImages(body, FORMATS.OPENAI, FORMATS.OLLAMA);
    expect(n).toBe(0);
    expect(fetchImageMock).not.toHaveBeenCalled();
  });

  it("gemini source -> gemini target: fileData URL -> inlineData base64", async () => {
    const body = { contents: [{ role: "user", parts: [
      { fileData: { mimeType: "image/png", fileUri: "https://x/a.png" } },
    ] }] };
    const n = await prefetchRemoteImages(body, FORMATS.GEMINI, FORMATS.GEMINI);
    expect(n).toBe(1);
    expect(body.contents[0].parts[0].inlineData).toBeTruthy();
    expect(body.contents[0].parts[0].fileData).toBeUndefined();
  });

  it("claude source -> kiro target: source.url -> base64", async () => {
    const body = { messages: [{ role: "user", content: [
      { type: "image", source: { type: "url", url: "https://x/a.png" } },
    ] }] };
    const n = await prefetchRemoteImages(body, FORMATS.CLAUDE, FORMATS.KIRO);
    expect(n).toBe(1);
    expect(body.messages[0].content[0].source.type).toBe("base64");
  });

  it("openai source -> commandcode target: converts remote URL to base64", async () => {
    const body = { messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://x/a.png" } }] }] };
    const n = await prefetchRemoteImages(body, FORMATS.OPENAI, FORMATS.COMMANDCODE);
    expect(n).toBe(1);
    expect(body.messages[0].content[0].image_url.url.startsWith("data:image/png;base64,")).toBe(true);
    expect(fetchImageMock).toHaveBeenCalled();
  });

  it("fetches a batch of remote images concurrently, bounded to 4 at a time", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    fetchImageMock.mockImplementation(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return { url: "data:image/png;base64,QUJD", mimeType: "image/png" };
    });

    const urls = ["a", "b", "c", "d", "e", "f", "g"].map((n) => `https://x/${n}.png`);
    const body = { messages: [{ role: "user", content: urls.map((url) => ({ type: "image_url", image_url: { url } })) }] };

    const n = await prefetchRemoteImages(body, FORMATS.OPENAI, FORMATS.OLLAMA);

    expect(n).toBe(urls.length);
    expect(maxInFlight).toBe(4);
    for (const block of body.messages[0].content) {
      expect(block.image_url.url.startsWith("data:")).toBe(true);
    }
  });

  it("claude source -> commandcode target: source.url -> base64", async () => {
    const body = { messages: [{ role: "user", content: [
      { type: "image", source: { type: "url", url: "https://x/a.png" } },
    ] }] };
    const n = await prefetchRemoteImages(body, FORMATS.CLAUDE, FORMATS.COMMANDCODE);
    expect(n).toBe(1);
    expect(body.messages[0].content[0].source.type).toBe("base64");
  });
});

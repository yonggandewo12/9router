// Web-login capture readiness.
//
// Two published-build bugs lived here: the lazy runtime resolution crash is
// covered in lazy-runtime.test.js; this file covers the capture itself — the
// DeepSeek sign-in page writes {"value":null,...} to localStorage before the
// user logs in, and treating that envelope as a token ended the capture and
// closed the browser within a second ("userToken is invalid or expired").
import { describe, it, expect } from "vitest";

import { getWebLoginConfig, unwrapLocalStorageToken } from "open-sse/services/webLoginConfig.js";
import { harvest } from "open-sse/services/webLogin.js";

const PLACEHOLDER = '{"value":null,"__version":"0"}';
const REAL_TOKEN = "b".repeat(48);

function fakeContext({ localStorage = {}, url = "https://chat.deepseek.com/sign_in" } = {}) {
  return {
    cookies: async () => [
      { name: "smidV2", value: "x", domain: ".deepseek.com" },
      { name: "other", value: "y", domain: ".example.com" },
    ],
    pages: () => [
      {
        url: () => url,
        evaluate: async (_fn, names) => {
          const out = {};
          for (const name of names) if (localStorage[name] !== undefined) out[name] = localStorage[name];
          return out;
        },
      },
    ],
  };
}

describe("unwrapLocalStorageToken", () => {
  it("returns null for the pre-login placeholder", () => {
    expect(unwrapLocalStorageToken(PLACEHOLDER)).toBeNull();
    expect(unwrapLocalStorageToken('{"value":""}')).toBeNull();
    expect(unwrapLocalStorageToken('{"__version":"0"}')).toBeNull();
    expect(unwrapLocalStorageToken("")).toBeNull();
    expect(unwrapLocalStorageToken(undefined)).toBeNull();
  });

  it("unwraps a real envelope and passes raw tokens through", () => {
    expect(unwrapLocalStorageToken(JSON.stringify({ value: REAL_TOKEN, __version: "0" }))).toBe(REAL_TOKEN);
    expect(unwrapLocalStorageToken(REAL_TOKEN)).toBe(REAL_TOKEN);
  });
});

describe("deepseek-web validateToken", () => {
  const config = getWebLoginConfig("deepseek-web");

  it("rejects the placeholder that every visitor gets", () => {
    expect(config.validateToken(PLACEHOLDER)).toBe(false);
  });

  it("accepts a wrapped or raw real token", () => {
    expect(config.validateToken(JSON.stringify({ value: REAL_TOKEN }))).toBe(true);
    expect(config.validateToken(REAL_TOKEN)).toBe(true);
  });
});

describe("harvest readiness", () => {
  const config = getWebLoginConfig("deepseek-web");

  it("stays unready while only the placeholder is present", async () => {
    const found = await harvest(fakeContext({ localStorage: { userToken: PLACEHOLDER } }), config);
    expect(found.ready).toBe(false);
  });

  it("becomes ready and carries the unwrapped token once a session exists", async () => {
    const found = await harvest(
      fakeContext({ localStorage: { userToken: JSON.stringify({ value: REAL_TOKEN, __version: "0" }) } }),
      config
    );
    expect(found.ready).toBe(true);
    expect(found.localStorageValues.userToken).toContain(REAL_TOKEN);
  });

  it("still scopes cookies to the provider domain", async () => {
    const found = await harvest(fakeContext({ localStorage: { userToken: REAL_TOKEN } }), config);
    expect(found.cookieHeader).toBe("smidV2=x");
  });
});

// Web-login capture readiness.
//
// Two published-build bugs lived here: the lazy runtime resolution crash is
// covered in lazy-runtime.test.js; this file covers the capture itself — the
// DeepSeek sign-in page writes {"value":null,...} to localStorage before the
// user logs in, and treating that envelope as a token ended the capture and
// closed the browser within a second ("userToken is invalid or expired").
import { describe, it, expect } from "vitest";

import { getWebLoginConfig, unwrapLocalStorageToken, listWebLoginProviders } from "open-sse/services/webLoginConfig.js";
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

describe("joyagent web login", () => {
  // Jar shapes captured live on 2026-11-06 from a real headed-Chromium login:
  // an anonymous visitor gets only the qid_* analytics cookies, and ptKey /
  // jwaAccessToken appear on joyagent.jd.com only once the passport flow ends.
  const GUEST = [
    { name: "qid_uid", value: "3c85f690", domain: ".jd.com" },
    { name: "qid_sc", value: "1793926660634", domain: ".jd.com" },
    { name: "qid_ad", value: "211.61", domain: "joyagent.jd.com" },
  ];
  const LOGGED_IN = [
    ...GUEST,
    { name: "thor", value: "ABC", domain: ".jd.com" },
    { name: "pin", value: "jd_AcWZTZQJocwB", domain: ".jd.com" },
    { name: "unick", value: "jd_test", domain: ".jd.com" },
    { name: "DeviceSeq", value: "d-1", domain: "passport.jd.com" },
    { name: "ptKey", value: "jca_E9t3WR7CA-oit73yhf26707LBnOFUJPzCB60K3P7hK0", domain: "joyagent.jd.com" },
    { name: "jwaAccessToken", value: "jwa_sUVZJL8qzcQQeySJ", domain: "joyagent.jd.com" },
  ];
  const jarContext = (cookies) => ({ cookies: async () => cookies, pages: () => [] });
  const config = getWebLoginConfig("joyagent");

  it("is offered in the dashboard's Login-via-Browser list", () => {
    // The button whitelist is derived from this table's keys, so a missing
    // row silently degrades the lane to paste-the-cookie-header.
    expect(listWebLoginProviders()).toContain("joyagent");
    expect(config).toBeTruthy();
    expect(config.loginUrl).toBe("https://joyagent.jd.com/app/#/chat");
  });

  it("waits for ptKey, which an anonymous visitor never has", async () => {
    expect(await harvest(jarContext(GUEST), config)).toMatchObject({ ready: false });
    expect((await harvest(jarContext(LOGGED_IN), config)).ready).toBe(true);
  });

  it("scopes the jar to .jd.com so the passport tier survives alongside ptKey", async () => {
    // The gateway authenticates the passport cookies on their own (measured),
    // so dropping them would trade a year-long session for the ~7-day ptKey.
    const found = await harvest(jarContext(LOGGED_IN), config);
    expect(found.cookieHeader).toContain("thor=ABC");
    expect(found.cookieHeader).toContain("pin=jd_AcWZTZQJocwB");
    expect(found.cookieHeader).toContain("DeviceSeq=d-1");
    expect(found.cookieHeader).toContain("ptKey=jca_");
    // Analytics-only cookies are kept too: harvest filters by domain, not name.
    expect(found.cookieHeader).toContain("qid_uid=3c85f690");
  });

  it("keeps the credential a Cookie header rather than a single value", async () => {
    const found = await harvest(jarContext(LOGGED_IN), config);
    expect(found.cookieHeader).toMatch(/^[^=;]+=[^;]*(; [^=;]+=[^;]*)+$/);
    expect(config.credentialFrom).toBeUndefined();
  });
});

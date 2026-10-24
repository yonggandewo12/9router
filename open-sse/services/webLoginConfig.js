// Per-provider login-capture configs for web-cookie providers.
//
// Each entry describes how to log the user in through a real (headed) browser
// window and what to harvest afterwards — pattern of OmniRoute's
// tokenExtractionConfig: open loginUrl, poll until every required token is
// present, then turn the browser context into a connection credential.

/** @typedef {{ type: "cookie" | "localStorage", name: string }} TokenSource */

/**
 * localStorage values may be wrapped as {"value":"<token>","__version":"0"}.
 * The login page writes that envelope with `value: null` before the user has
 * signed in, so presence of the key means nothing — unwrap it and return null
 * unless the inner value is a non-empty string.
 */
export function unwrapLocalStorageToken(raw) {
  if (typeof raw !== "string" || !raw.trim()) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Not JSON — the raw value is the token.
    return raw;
  }
  // A JSON object is the storage envelope, never a token: only its `value`
  // counts, and only when it is a non-empty string.
  if (parsed && typeof parsed === "object") {
    return typeof parsed.value === "string" && parsed.value.trim() ? parsed.value : null;
  }
  return raw;
}

export const WEB_LOGIN_CONFIGS = {
  "grok-web": {
    loginUrl: "https://grok.com/",
    cookieDomain: ".grok.com",
    // sso appears on login; sso-rw follows. cf_clearance/__cf_bm ride along
    // when Cloudflare challenges the fresh profile — capture them all.
    tokenSources: [{ type: "cookie", name: "sso" }],
  },
  "chatgpt-web": {
    loginUrl: "https://chatgpt.com/",
    cookieDomain: ".chatgpt.com",
    // NextAuth splits large session tokens into `.0`, `.1`, … chunks.
    tokenSources: [{ type: "cookie", name: "__Secure-next-auth.session-token" }],
  },
  "gemini-web": {
    loginUrl: "https://gemini.google.com/",
    cookieDomain: ".google.com",
    // PSID alone identifies the session; PSIDTS rotates and is often absent.
    tokenSources: [
      { type: "cookie", name: "__Secure-1PSID" },
      { type: "cookie", name: "__Secure-1PSIDTS", optional: true },
    ],
  },
  "muse-web": {
    loginUrl: "https://muse.ai/",
    cookieDomain: ".muse.ai",
    // hatch_sess identifies the login; the rest rotate and only enrich the jar.
    tokenSources: [
      { type: "cookie", name: "hatch_sess" },
      { type: "cookie", name: "hatch_gw", optional: true },
      { type: "cookie", name: "hatch_vml", optional: true },
      { type: "cookie", name: "hatch_native_auth_device", optional: true },
    ],
  },
  // deepseek-web stores its credential in localStorage, not a cookie.
  // Stored as JSON {"value":"<base64-token>","__version":"0"} or raw token.
  // The sign-in page writes {"value":null,...} to every visitor, so a bare
  // length check on the envelope would end the capture before login happens.
  "deepseek-web": {
    loginUrl: "https://chat.deepseek.com/sign_in",
    cookieDomain: ".deepseek.com",
    tokenSources: [{ type: "localStorage", name: "userToken" }],
    // The executor expects the raw token value, not a cookie header.
    credentialFrom: "localStorageValue",
    validateToken: (value) => {
      const token = unwrapLocalStorageToken(value);
      return typeof token === "string" && token.trim().length >= 20;
    },
  },
  "uc-web": {
    loginUrl: "https://uncensored.com/",
    cookieDomain: ".uncensored.com",
    // Clerk hands every anonymous visitor a `__client` cookie, so its presence
    // alone would end the capture before the browser window even paints.
    // `__client_uat` only becomes a real timestamp once a session exists.
    tokenSources: [
      { type: "cookie", name: "__client" },
      {
        type: "cookie",
        name: "__client_uat",
        validateCookie: (value) => Number(value) > 0,
      },
    ],
  },
};

export function getWebLoginConfig(providerId) {
  return WEB_LOGIN_CONFIGS[providerId] || null;
}

export function listWebLoginProviders() {
  return Object.keys(WEB_LOGIN_CONFIGS);
}

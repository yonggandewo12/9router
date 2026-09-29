import { DEVECO_CONFIG } from "../constants/oauth.js";
import {
  buildAuthorizeUrl,
  createLoginState,
  exchangeCodeForCredentials,
  toDevecoCredentialPatch,
} from "open-sse/shared/deveco/auth.js";

// 华为 DevEco Code — HUAWEI ID browser login, reproduced:
//   1) Browser opens {base}/console/DevEcoIDE/apply?port=<loopback>&appid=1008&code=<state>
//   2) Portal page POSTs http://127.0.0.1:<port>/callback with
//      tempToken/siteId/code in the x-www-form-urlencoded body
//   3) GET /authrouter/auth/api/temptoken/check?tempToken=… → jwtToken
//   4) GET /authrouter/auth/api/jwToken/check (header jwtToken) → accessToken
// Token TTL ~30 min; refresh re-reads the SAME endpoint with refresh:"true"
// (the jwtToken itself is the long-lived ~30-day credential, live-verified
// 2026-09-29: it survives access-token rotation and returns a fresh accessToken).
const deveco = {
  config: DEVECO_CONFIG,
  flowType: "authorization_code",
  callbackPath: "/callback",
  // The CLI mints a 32-hex loginState and demands the callback echoes it as
  // `code` (the portal carries no `state` slot) — generateAuthData's state is
  // what we bind on.
  buildAuthUrl: (config, redirectUri, state) => {
    // The callback proxy listens on an ephemeral port and hands its callbackUrl
    // back through redirect_uri; the portal redirects to that exact port, so
    // the authorize URL's `port=` MUST be read from it, never defaulted.
    let port = null;
    try {
      port = new URL(redirectUri).port || null;
    } catch { /* fall through to the config default below */ }
    if (!port) {
      throw new Error(`DevEco login needs a loopback redirect_uri carrying the callback port, got: ${redirectUri}`);
    }
    return buildAuthorizeUrl(Number(port), state || createLoginState());
  },
  exchangeToken: async (config, code, _redirectUri, _verifier, state) => {
    const raw = String(code || "").trim();
    const query = raw.includes("?") ? raw.slice(raw.indexOf("?") + 1) : raw;
    const params = new URLSearchParams(query);

    // CSRF: the official server rejects a callback whose `code` is not its own
    // pending loginState; mirror that here (manual-paste exchanges without a
    // session carry no state and skip the check).
    const cbCode = params.get("code");
    if (state && cbCode && cbCode !== state) {
      throw new Error("DevEco callback code/state mismatch");
    }

    const tempToken = params.get("tempToken");
    if (!tempToken) throw new Error("DevEco callback carried no tempToken — complete the HUAWEI ID sign-in first");

    const siteId = params.get("siteId");
    if (siteId && siteId !== "1") {
      throw new Error("DevEco: unsupported account region (only CN mainland accounts are supported)");
    }

    return exchangeCodeForCredentials(tempToken);
  },
  postExchange: async () => ({ account: null, userInfo: null }),
  mapTokens: (tokens, _extra) => {
    const patch = toDevecoCredentialPatch(tokens);
    return {
      ...patch,
      email: tokens.userId || undefined,
      displayName: tokens.userName || undefined,
    };
  },
};

export default deveco;

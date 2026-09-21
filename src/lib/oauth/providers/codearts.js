import { CODEARTS_CONFIG } from "../constants/oauth.js";
import {
  buildAuthorizeUrl,
  createDpopKeyPair,
  createTicketId,
  exchangeCodeForCredentials,
  exchangeSecretForCredentials,
  toCodeartsCredentialPatch,
} from "open-sse/shared/codearts/auth.js";
import { fetchCodeartsCurrentUser } from "open-sse/shared/codearts/api.js";

// 华为云码道 (CodeArts) — the official CLI's browser login, reproduced:
//   1) mint PKCE verifier + ticket_id + an EC P-256 DPoP keypair
//   2) Browser opens ${portalBase}/authorize?client_id=CodeArts_Tui&port=…
//      &code_challenge=…&code_challenge_method=SHA-256&ticket_id=…
//   3) Redirect → http://127.0.0.1:<port>/oauth/callback?code=<32>
//   4) POST ${stsBase}/v1/oauth2/tokens (form + DPoP proof) → temporary Huawei
//      AK/SK + security_token (~1h) + a long-lived refresh_token
//   5) GET ${apiBase}/snap-manager/v1/current/user (SDK-HMAC-SHA256) → identity
// Inference never uses a bearer token: CodeartsExecutor signs each request with
// the AK/SK, so the DPoP keypair must be persisted alongside them — STS demands
// the same key on every refresh.
const codearts = {
  config: CODEARTS_CONFIG,
  flowType: "authorization_code_pkce",
  callbackPath: CODEARTS_CONFIG.callbackPath,
  // base64url(96 bytes) = the 128-char verifier the CLI presents to STS.
  pkceVerifierBytes: 96,
  prepareConfig: async (config) => ({
    ...config,
    // ticket_id binds the pending login at the portal; the exchange ignores it.
    ticketId: createTicketId(),
    // Re-minted by the exchange-time prepareConfig(), which is fine: the
    // authorize URL carries no key material, only the proof does.
    dpopKeyPair: createDpopKeyPair(),
  }),
  // The portal has no `state` slot and its callback echoes none, so the loopback
  // proxy matches its single pending session instead.
  buildAuthUrl: (config, redirectUri, _state, codeChallenge) => buildAuthorizeUrl({
    redirectUri,
    codeChallenge,
    ticketId: config.ticketId,
    locale: config.locale,
    portalBase: config.portalBase,
  }),
  // `code` is the raw callback URL the proxy captured; `redirectUri` and
  // `codeVerifier` come from the session that opened the browser, because
  // exchangeTokens() re-runs prepareConfig() and anything minted here belongs to
  // a different login attempt.
  exchangeToken: async (config, code, redirectUri, codeVerifier, _state, meta) => {
    // The proxy hands over the raw callback (`/oauth/callback?code=…`); a manual
    // paste may be just the query, or the bare code.
    const raw = String(code || "").trim();
    const query = raw.includes("?") ? raw.slice(raw.indexOf("?") + 1) : (raw.includes("=") ? raw : "");
    const params = new URLSearchParams(query);
    const secret = params.get("secret");
    const authCode = params.get("code") || (query ? "" : raw);
    if (!secret && !authCode) throw new Error("CodeArts callback carried neither an authorization code nor a login secret");
    const creds = secret
      // A portal session that is already signed in answers with `secret` +
      // `redirect` and no code; the ticket endpoint returns the same AK/SK.
      ? await exchangeSecretForCredentials({ ticketId: meta?.ticketId, secret, keyPair: config.dpopKeyPair, apiBase: config.apiBase })
      : await exchangeCodeForCredentials({
        code: authCode,
        codeVerifier,
        redirectUri,
        keyPair: config.dpopKeyPair,
        stsBase: config.stsBase,
      });
    return { ...creds, dpopKeyPair: config.dpopKeyPair };
  },
  postExchange: async (tokens) => {
    // Best-effort: the whole payload is what refresh replays as
    // `x-agent-user-account`, but losing it must not throw away a good login.
    try {
      const account = await fetchCodeartsCurrentUser({
        accessToken: tokens.securityToken,
        providerSpecificData: {
          accessKeyId: tokens.accessKeyId,
          secretAccessKey: tokens.secretAccessKey,
          securityToken: tokens.securityToken,
        },
      });
      return { account, userInfo: account };
    } catch (error) {
      console.log("[CodeArts] current/user failed:", error?.message || error);
      return { account: null, userInfo: null };
    }
  },
  mapTokens: (tokens, extra) => {
    const account = extra?.account;
    const patch = toCodeartsCredentialPatch({ ...tokens, accountId: account ? JSON.stringify(account) : "" });
    return {
      ...patch,
      email: account?.user_name || undefined,
      displayName: account?.display_name || account?.user_name || undefined,
      providerSpecificData: {
        ...patch.providerSpecificData,
        ...(account?.user_id ? { userId: account.user_id } : {}),
        ...(account?.domain_id ? { domainId: account.domain_id } : {}),
      },
    };
  },
};

export default codearts;

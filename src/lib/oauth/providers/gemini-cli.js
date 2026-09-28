import { GEMINI_CONFIG, getOAuthClientMetadata } from "../constants/oauth.js";
import { proxyAwareFetch } from "open-sse/utils/proxyFetch.js";

const geminiCli = {
  config: GEMINI_CONFIG,
  flowType: "authorization_code",
  buildAuthUrl: (config, redirectUri, state) => {
    const params = new URLSearchParams({
      client_id: config.clientId,
      response_type: "code",
      redirect_uri: redirectUri,
      scope: config.scopes.join(" "),
      state: state,
      access_type: "offline",
      prompt: "consent",
    });
    return `${config.authorizeUrl}?${params.toString()}`;
  },
  exchangeToken: async (config, code, redirectUri, codeVerifier, state, meta = {}) => {
    const response = await proxyAwareFetch(config.tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code: code,
        redirect_uri: redirectUri,
      }),
    }, meta.proxyOptions || null);

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Token exchange failed: ${error}`);
    }

    return await response.json();
  },
  postExchange: async (tokens, meta = {}) => {
    const proxyOptions = meta.proxyOptions || null;
    // Fetch user info
    const userInfoRes = await proxyAwareFetch(`${GEMINI_CONFIG.userInfoUrl}?alt=json`, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    }, proxyOptions);
    const userInfo = userInfoRes.ok ? await userInfoRes.json() : {};

    // Fetch project ID
    let projectId = "";
    try {
      const projectRes = await proxyAwareFetch(
        "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${tokens.access_token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            metadata: getOAuthClientMetadata(),
            mode: 1,
          }),
        },
        proxyOptions
      );
      if (projectRes.ok) {
        const data = await projectRes.json();
        projectId = data.cloudaicompanionProject?.id || data.cloudaicompanionProject || "";
      }
    } catch (e) {
      console.log("Failed to fetch project ID:", e);
    }

    return { userInfo, projectId };
  },
  mapTokens: (tokens, extra) => ({
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresIn: tokens.expires_in,
    scope: tokens.scope,
    email: extra?.userInfo?.email,
    projectId: extra?.projectId,
  }),
};

export default geminiCli;

// Conversation cleanup for the chatgpt-web HTTP lanes.
//
// Every /f/conversation POST persists a real conversation in the account's
// history — the same thing the web UI shows in the sidebar. An API consumer
// would bury that history in one thread per turn, so both HTTP lanes delete
// what they created once the answer (or the image bytes) are safely in hand.
// DeepSeek web does the same with chat_session/delete.
//
// Best effort on purpose: the turn has already succeeded by the time this runs,
// so a failed cleanup must never surface as a failed request. The status is
// logged at debug so a live run can confirm the endpoint still exists.

import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { connectTimeoutGuard } from "../../utils/fetchTimeout.js";
import { FETCH_CONNECT_TIMEOUT_MS } from "../../config/runtimeConfig.js";

/**
 * @returns {Promise<boolean>} true when the upstream accepted the delete.
 */
export async function deleteChatGptWebConversation({
  baseUrl,
  accessToken,
  cookie,
  userAgent,
  conversationId,
  proxyOptions = null,
  log = null,
  timeoutMs = FETCH_CONNECT_TIMEOUT_MS,
}) {
  if (!conversationId) return false;
  // No caller signal: a client that hung up still leaves a conversation behind.
  const guard = connectTimeoutGuard(null, timeoutMs);
  try {
    const res = await proxyAwareFetch(
      `${baseUrl}/backend-api/conversation/${encodeURIComponent(conversationId)}/delete`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "User-Agent": userAgent,
          Accept: "application/json",
          "Content-Type": "application/json",
          ...(cookie ? { Cookie: cookie } : {}),
        },
        body: "{}",
        signal: guard.signal,
      },
      proxyOptions
    );
    log?.debug?.("CGPT-WEB", `conversation delete HTTP ${res.status}`);
    return res.ok;
  } catch (error) {
    // A dead proxy, a timeout or a retired endpoint: the answer already shipped.
    log?.debug?.("CGPT-WEB", `conversation delete failed: ${error?.message || error}`);
    return false;
  } finally {
    guard.clear();
  }
}

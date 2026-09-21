// Huawei Cloud AK/SK request signing ("SDK-HMAC-SHA256").
//
// CodeArts' snap-access gateway rejects bearer auth; every call must be signed
// with the temporary AK/SK + security token minted by the OAuth login. It looks
// like AWS SigV4 but is its own scheme:
//   Authorization: SDK-HMAC-SHA256 Access=<ak>, SignedHeaders=a;b;c, Signature=<hex>
//   stringToSign  = SDK-HMAC-SHA256\n<X-Sdk-Date>\nhex(sha256(canonicalRequest))
//   signing key   = the raw secret (no derived key chain)
//
// Two details that break the signature when guessed wrong, both confirmed
// against live traffic on 2026-09-20:
//   - canonical URI always ends with "/" ("/api/v2/chat/completions/" on the wire)
//   - SignedHeaders is a lowercase ";"-joined list of exactly the headers signed;
//     the gateway re-computes over those names only, so content-type/host are
//     optional as long as sender and signature agree.
import crypto from "node:crypto";

const ALGORITHM = "SDK-HMAC-SHA256";
const EMPTY_BODY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

const UNRESERVED = new Set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~");

/** RFC 3986 percent-encoding (Huawei's table: only A-Za-z0-9-._~ survive). */
export function uriEncode(value) {
  const str = typeof value === "string" ? value : String(value ?? "");
  let out = "";
  for (const char of str) {
    if (UNRESERVED.has(char)) {
      out += char;
      continue;
    }
    for (const byte of Buffer.from(char, "utf8")) {
      out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    }
  }
  return out;
}

/** `YYYYMMDDTHHmmssZ` — must match X-Sdk-Date in the signature and on the wire. */
export function formatSdkDate(date = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}`
    + `T${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}Z`;
}

export function canonicalUri(pathname) {
  const encoded = String(pathname || "").split("/").map(uriEncode).join("/");
  if (!encoded) return "/";
  return encoded.endsWith("/") ? encoded : `${encoded}/`;
}

/** Code-point order, the byte order the gateway sorts in — `localeCompare` would
 *  reorder "B" vs "a" and vary with the ICU build the host ships. */
function byCodePoint(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function canonicalQuery(queryParams) {
  // Sort by encoded key, then by value, so the canonical form does not depend on
  // the order the query happened to be assembled in.
  const keys = [...(queryParams || [])]
    .map(([k, v]) => [uriEncode(k), v])
    .sort((a, b) => (a[0] === b[0] ? byCodePoint(String(a[1] ?? ""), String(b[1] ?? "")) : byCodePoint(a[0], b[0])));
  const parts = [];
  for (const [key, raw] of keys) {
    const values = Array.isArray(raw) ? [...raw].sort(byCodePoint) : [raw ?? ""];
    for (const value of values) parts.push(`${key}=${uriEncode(value)}`);
  }
  return parts.join("&");
}

function canonicalHeaders(headers) {
  return Object.entries(headers)
    .map(([key, value]) => [key.toLowerCase(), String(value)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .reduce((acc, [key, value]) => `${acc}${key}:${value}\n`, "");
}

function sha256Hex(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/**
 * Sign one request.
 * @param {object} opts
 * @param {string} opts.accessKeyId   temporary AK from the OAuth token exchange
 * @param {string} opts.secretAccessKey matching SK
 * @param {string} [opts.securityToken] session token, sent as X-Security-Token
 * @param {string} opts.method        HTTP method
 * @param {string} opts.url           absolute URL (query included)
 * @param {string} [opts.body]        exact string that will be written to the wire
 * @param {object} [opts.headers]     headers to sign (and send)
 * @param {Date}   [opts.date]        injectable clock for tests
 * @returns {Record<string, string>} headers to pass to fetch
 */
export function signHuaweiRequest({ accessKeyId, secretAccessKey, securityToken, method, url, body, headers = {}, date = new Date() }) {
  if (!accessKeyId || !secretAccessKey) throw new Error("CodeArts signing requires accessKeyId + secretAccessKey");
  const target = new URL(url);
  const sdkDate = formatSdkDate(date);

  const signed = { ...headers };
  for (const key of Object.keys(signed)) {
    const lower = key.toLowerCase();
    if (lower !== key) {
      signed[lower] = signed[key];
      delete signed[key];
    }
  }
  signed.host = target.host;
  signed["x-sdk-date"] = sdkDate;
  if (securityToken) signed["x-security-token"] = securityToken;

  const signedHeaders = Object.keys(signed).sort().join(";");
  const payloadHash = signed["x-sdk-content-sha256"]
    || (body == null || body === "" ? EMPTY_BODY_SHA256 : sha256Hex(body));

  const canonicalRequest = [
    String(method).toUpperCase(),
    canonicalUri(target.pathname),
    canonicalQuery([...target.searchParams]),
    canonicalHeaders(signed),
    signedHeaders,
    payloadHash,
  ].join("\n");

  const stringToSign = [ALGORITHM, sdkDate, sha256Hex(canonicalRequest)].join("\n");
  const signature = crypto.createHmac("sha256", secretAccessKey).update(stringToSign).digest("hex");

  return {
    ...signed,
    Authorization: `${ALGORITHM} Access=${accessKeyId}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

export const __internal__ = { ALGORITHM, EMPTY_BODY_SHA256, canonicalHeaders, sha256Hex };

// Shared SSE primitives (no imports → safe for executors + stream.js)
export const SSE_DONE = "data: [DONE]\n\n";

export const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  "Connection": "keep-alive"
};

// Variant for web-cookie executors behind nginx (disable proxy buffering)
export const SSE_HEADERS_NO_BUFFER = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  "X-Accel-Buffering": "no"
};

// Variant for client-facing SSE responses (adds permissive CORS).
// X-Accel-Buffering + no-transform are load-bearing, not decoration: this proxy
// is routinely sat behind nginx/Caddy/cloudflared, and a buffered or gzipped SSE
// stream turns token-by-token output into one lump at the end — the client sees
// no first token until the generation is whole.
export const SSE_HEADERS_CORS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache, no-transform",
  "X-Accel-Buffering": "no",
  "Connection": "keep-alive",
  "Access-Control-Allow-Origin": "*"
};

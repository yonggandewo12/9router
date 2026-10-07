// Debug logging utility — only active in dev mode (NODE_ENV !== "production")
// Outputs are tagged with [DBG:tag] for easy grep/filter
const isDev = process.env.NODE_ENV !== "production";

// Same output as toLocaleTimeString("en-US", {hour12:false, 2-digit}) but
// without building an Intl formatter per line — streamHandler calls this every
// 20 chunks while a response streams.
function ts() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function dbg(tag, msg) {
  if (!isDev) return;
  console.log(`[${ts()}] 🐛 [DBG:${tag}] ${msg}`);
}

export const isDebugEnabled = isDev;

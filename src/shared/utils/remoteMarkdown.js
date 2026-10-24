// Remote markdown → HTML for dangerouslySetInnerHTML sinks.
//
// The changelog is fetched from GitHub at runtime, so its content is not
// trusted by the page that renders it. marked passes raw HTML through
// verbatim, which means a single upstream `<img onerror=…>` would execute
// with the dashboard's origin and its session cookie. This helper escapes
// raw-HTML tokens and drops script-bearing URLs, and leaves everything else
// to marked's own renderer.
const ESCAPE_MAP = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const UNSAFE_URL = /^\s*(?:javascript|data|vbscript):/i;

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ESCAPE_MAP[c]);
}

// A blocked link keeps its visible label. marked hands nested tokens (an image
// inside a link, formatted text) to the renderer as a token array, not a string.
function linkLabel(token) {
  const { text } = token || {};
  if (typeof text === "string") return escapeHtml(text);
  if (Array.isArray(text)) return escapeHtml(text.map((t) => t?.text ?? "").join(""));
  return "";
}

export function renderRemoteMarkdown(marked, markdown) {
  marked.setOptions({ gfm: true, breaks: true });
  marked.use({
    renderer: {
      html: (token) => escapeHtml(typeof token === "string" ? token : token?.text),
      // Returning false invokes marked's built-in link rendering.
      link: (token) => (UNSAFE_URL.test(String(token?.href ?? "")) ? linkLabel(token) : false),
    },
  });
  return marked.parse(markdown);
}

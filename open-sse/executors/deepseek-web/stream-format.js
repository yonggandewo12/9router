// Pure DeepSeek stream content/citation formatting.

export function isThinkingModel(model) {
  const m = model.toLowerCase();
  return m.includes("think") || m.includes("r1") || m.includes("reason");
}

export function isSearchModel(model) {
  const m = model.toLowerCase();
  return m.includes("search") || m.includes("fold");
}

// DeepSeek occasionally leaks its own status markers into the content stream,
// but only as a fragment of their own (or at its very start). Stripping every
// occurrence would also eat the word from genuine answers ("the build FINISHED"),
// so match the marker only where the leak actually appears.
export function cleanDeepSeekToken(text) {
  return text
    .replace(/^FINISHED\s*/, "")
    // Longest alternative first: "SEARCH" matching the prefix of "SEARCHING"
    // would leave "ING …" in the user's content.
    .replace(/^(WEB_SEARCH|SEARCHING|SEARCH)\s*/i, "");
}

export function formatStreamContent(raw, model) {
  let text = cleanDeepSeekToken(raw);
  if (!isSearchModel(model)) return text;
  if (model.toLowerCase().includes("search-silent")) {
    return text.replace(/\[citation:(\d+)\]/g, "");
  }
  return text.replace(/\[citation:(\d+)\]/g, "[$1]");
}

export function appendSearchCitations(searchResults, model) {
  if (searchResults.length === 0 || model.toLowerCase().includes("search-silent")) {
    return "";
  }
  return searchResults
    .filter((r) => r.cite_index)
    .sort((a, b) => (a.cite_index || 0) - (b.cite_index || 0))
    .map((r) => `[${r.cite_index}]: [${r.title}](${r.url})`)
    .join("\n");
}

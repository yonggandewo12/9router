// Provider definitions
import REGISTRY from "open-sse/providers/registry/index.js";
import { RISK_NOTICE } from "@/shared/constants/providersDisplay.js";

const MEDIA_ENTRY_KEYS = [
  "serviceKinds", "ttsConfig", "sttConfig", "embeddingConfig",
  "imageConfig", "imageToTextConfig", "videoConfig", "musicConfig",
  "searchViaChat", "searchConfig", "fetchConfig", "credentialFallback", "systemoneConfig",
  "modelsFetcher", "mediaPriority", "hiddenKinds",
];

// Build provider UI object from registry entry
function buildProviderEntry(r) {
  const mediaFields = {};
  if (r.media) Object.assign(mediaFields, r.media);
  for (const k of MEDIA_ENTRY_KEYS) {
    if (r[k] !== undefined) mediaFields[k] = r[k];
  }
  const display = { ...(r.display || {}) };
  if (display.deprecationNotice === "RISK_NOTICE") display.deprecationNotice = RISK_NOTICE;
  return {
    ...display,
    id: r.id,
    alias: r.uiAlias || r.alias,
    ...(r.hidden ? { hidden: true } : {}),
    ...mediaFields,
    ...(r.priority !== undefined ? { priority: r.priority } : {}),
    ...(r.hasFree ? { hasFree: true } : {}),
    ...(r.thinkingConfig ? { thinkingConfig: r.thinkingConfig } : {}),
    ...(r.regions ? { regions: r.regions, defaultRegion: r.defaultRegion } : {}),
    ...(r.hasProviderSpecificData ? { hasProviderSpecificData: true } : {}),
    ...(r.noAuth ? { noAuth: true } : {}),
    ...(r.passthroughModels ? { passthroughModels: true } : {}),
    ...(r.hasOAuth ? { hasOAuth: true } : {}),
    ...(r.authModes ? { authModes: r.authModes } : {}),
    ...(r.authType ? { authType: r.authType } : {}),
    ...(r.authHint ? { authHint: r.authHint } : {}),
    ...(r.apiKeyOptionalWith ? { apiKeyOptionalWith: r.apiKeyOptionalWith } : {}),
    ...(r.credentialForm ? { credentialForm: r.credentialForm } : {}),
  };
}

const byCategory = (cat) => Object.fromEntries(
  REGISTRY.filter(r => r.category === cat).map(r => [r.id, buildProviderEntry(r)])
);

export const FREE_PROVIDERS = byCategory("free");
export const FREE_TIER_PROVIDERS = byCategory("freeTier");

// Thinking config definitions
// options: list of selectable modes ("auto" = no override from server)
// defaultMode: fallback when user hasn't configured
// extended: claude-style thinking (thinking.type + budget_tokens) — used by most providers
// effort: openai-style reasoning_effort — only openai + codex
export const THINKING_CONFIG = {
  extended: {
    options: ["auto", "on", "off"],
    defaultMode: "auto",
    defaultBudgetTokens: 10000
  },
  effort: {
    options: ["auto", "none", "low", "medium", "high"],
    defaultMode: "auto"
  }
};

export const OAUTH_PROVIDERS = byCategory("oauth");
export const APIKEY_PROVIDERS = byCategory("apikey");

// Web Cookie Providers (use browser session cookie instead of API key)
export const WEB_COOKIE_PROVIDERS = byCategory("webCookie");

// Media provider kinds — each kind maps to a route and endpoint config
export const MEDIA_PROVIDER_KINDS = [
  { id: "embedding",   label: "Embedding",      icon: "data_array",        endpoint: { method: "POST", path: "/v1/embeddings" } },
  { id: "image",       label: "Text to Image",  icon: "brush",             endpoint: { method: "POST", path: "/v1/images/generations" } },
  { id: "imageToText", label: "Image to Text",  icon: "image_search",      endpoint: { method: "POST", path: "/v1/images/understanding" } },
  { id: "tts",         label: "Text To Speech", icon: "record_voice_over", endpoint: { method: "POST", path: "/v1/audio/speech" } },
  { id: "stt",         label: "Speech To Text", icon: "mic",               endpoint: { method: "POST", path: "/v1/audio/transcriptions" } },
  { id: "webSearch",   label: "Web Search",     icon: "travel_explore",    endpoint: { method: "POST", path: "/v1/search" } },
  { id: "webFetch",    label: "Web Fetch",      icon: "language",          endpoint: { method: "POST", path: "/v1/web/fetch" } },
  { id: "video",       label: "Video",          icon: "movie",             endpoint: { method: "POST", path: "/v1/videos/generations" } },
  { id: "music",       label: "Music",          icon: "music_note",        endpoint: { method: "POST", path: "/v1/audio/music" } },
  { id: "systemone",   label: "System One",     icon: "psychology",        endpoint: { method: "POST", path: "/v1/systemone" }, isNew: true },
];

export const OPENAI_COMPATIBLE_PREFIX = "openai-compatible-";
export const ANTHROPIC_COMPATIBLE_PREFIX = "anthropic-compatible-";
export const CUSTOM_EMBEDDING_PREFIX = "custom-embedding-";

export function isOpenAICompatibleProvider(providerId) {
  return typeof providerId === "string" && providerId.startsWith(OPENAI_COMPATIBLE_PREFIX);
}

export function isAnthropicCompatibleProvider(providerId) {
  return typeof providerId === "string" && providerId.startsWith(ANTHROPIC_COMPATIBLE_PREFIX);
}

export function isCustomEmbeddingProvider(providerId) {
  return typeof providerId === "string" && providerId.startsWith(CUSTOM_EMBEDDING_PREFIX);
}

// All providers (combined)
export const AI_PROVIDERS = { ...FREE_PROVIDERS, ...FREE_TIER_PROVIDERS, ...OAUTH_PROVIDERS, ...APIKEY_PROVIDERS, ...WEB_COOKIE_PROVIDERS };

// Auth methods
export const AUTH_METHODS = {
  oauth: { id: "oauth" },
  apikey: { id: "apikey" },
  cookie: { id: "cookie" },
};

// Helper: Get provider by alias
export function getProviderByAlias(alias) {
  for (const provider of Object.values(AI_PROVIDERS)) {
    if (provider.alias === alias || provider.id === alias) {
      return provider;
    }
  }
  return null;
}

// Helper: Get provider ID from alias
export function resolveProviderId(aliasOrId) {
  const provider = getProviderByAlias(aliasOrId);
  return provider?.id || aliasOrId;
}

// Helper: Get alias from provider ID
export function getProviderAlias(providerId) {
  const provider = AI_PROVIDERS[providerId];
  return provider?.alias || providerId;
}

// Alias to ID mapping (for quick lookup)
export const ALIAS_TO_ID = Object.values(AI_PROVIDERS).reduce((acc, p) => {
  acc[p.alias] = p.id;
  return acc;
}, {});

// ID to Alias mapping
export const ID_TO_ALIAS = Object.values(AI_PROVIDERS).reduce((acc, p) => {
  acc[p.id] = p.alias;
  return acc;
}, {});

// Every name a built-in provider can be addressed by: registry id, registry
// alias, the UI short alias, and the extra aliases[] spellings. Built from
// REGISTRY because buildProviderEntry drops aliases[], and because AI_PROVIDERS
// keeps only one alias per provider (uiAlias wins over alias).
const RESERVED_PROVIDER_NAMES = new Set();
for (const entry of REGISTRY) {
  for (const name of [entry.id, entry.alias, entry.uiAlias, ...(entry.aliases || [])]) {
    if (name) RESERVED_PROVIDER_NAMES.add(name);
  }
}

export function isReservedProviderName(name) {
  return RESERVED_PROVIDER_NAMES.has(name);
}

// Whether a provider may be offered for a service kind. Single source for the
// lists that filter by kind (media pages, model pickers).
// - Unknown ids (openai/anthropic-compatible nodes) default to LLM.
// - An empty serviceKinds means parked: the registry declares no kind, so the
//   provider stays out of every dashboard list while its connection and code
//   remain (perplexity-web). /v1/models keeps its own default for those.
// - Media-only providers (muse-web, grok-web) declare no "llm" while still
//   carrying chat models: those stay routable by name, unlisted.
export function providerSupportsKind(providerId, kind) {
  const provider = AI_PROVIDERS[providerId];
  const kinds = provider?.serviceKinds || ["llm"];
  if (!kinds.includes(kind)) return false;
  if (provider?.hiddenKinds?.includes(kind)) return false;
  return true;
}

// Whether a provider's static registry catalog belongs in a model list.
// kindFilter null means the LLM/combo selector. A provider that does not
// declare that kind (media-only chat models, or a parked provider with no
// kinds at all) stays routable by name but lists nothing of its own — while
// the aliases/custom models the user added under it remain pickable.
export function listsProviderCatalog(providerId, kindFilter = null) {
  return providerSupportsKind(providerId, kindFilter || "llm");
}

// Helper: Get providers by service kind (e.g. "tts", "embedding", "image")
// Providers without serviceKinds default to ["llm"]
export function getProvidersByKind(kind) {
  return Object.values(AI_PROVIDERS)
    .filter((p) => !p.hidden && providerSupportsKind(p.id, kind))
    .sort((a, b) => (a.priority ?? a.mediaPriority ?? 999) - (b.priority ?? b.mediaPriority ?? 999));
}

// Derive từ registry features flags
export const USAGE_SUPPORTED_PROVIDERS = REGISTRY
  .filter(r => r.features?.usage)
  .map(r => r.id);

export const USAGE_APIKEY_PROVIDERS = REGISTRY
  .filter(r => r.features?.usageApikey)
  .map(r => r.id);

export default {
  id: "opencode",
  priority: 40,
  hasFree: true,
  alias: "oc",
  uiAlias: "oc",
  display: {
    name: "OpenCode Free",
    icon: "terminal",
    color: "#E87040",
    textIcon: "OC",
  },
  category: "free",
  noAuth: true,
  transport: {
    baseUrl: "https://opencode.ai",
    headers: {
      "x-opencode-client": "desktop",
    },
    forceStream: true,
    noAuth: true,
    quirks: {
      forceAutoToolChoiceModels: ["muse-spark-1.3-contributor-free"],
    },
  },
  models: [
    // Endpoint formats differ per model, so declare non-chat models explicitly.
    { id: "muse-spark-1.3-contributor-free", name: "Muse Spark 1.3 Contributor Free", targetFormat: "openai-responses" },
    // Retired, verified 2026-10-15 against opencode 1.19.0 + live upstream:
    // union-alpha — gone from their list, "/zen/v1/messages" says "not supported"
    // (kept out since v0.5.87).
    // muse-spark-1.2-contributor-free — still listed by /zen/v1/models but the
    // official CLI no longer offers it (`opencode models opencode` omits it and a
    // real run answers UnknownError), and the spoofed HTTP lane is hard-gated 403.
    // It was also the first entry, i.e. getDefaultModel("oc") → a dead default.
    // jev-1.13-free — POST /zen/v1/systemone answers 451 "Endpoint is unavailable".
  ],
  serviceKinds: ["llm", "systemone"],
  systemoneConfig: {
    baseUrl: "https://opencode.ai/zen/v1/systemone",
    headers: {
      "x-opencode-client": "desktop",
      "User-Agent": "opencode/1.18.31",
    },
  },
  modelsFetcher: { url: "https://opencode.ai/zen/v1/models", type: "opencode-free" },
  passthroughModels: true,
};

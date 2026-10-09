export default {
  id: "poolside",
  priority: 60,
  alias: "poolside",
  aliases: [
    "ps",
  ],
  uiAlias: "ps",
  display: {
    name: "Poolside",
    icon: "water_drop",
    color: "#0EA5E9",
    textIcon: "PS",
    website: "https://poolside.ai",
    notice: {
      apiKeyUrl: "https://platform.poolside.ai/api-keys",
    },
  },
  category: "freeTier",
  authType: "apikey",
  authModes: ["apikey"],
  transport: {
    baseUrl: "https://inference.poolside.ai/v1/chat/completions",
    validateUrl: "https://inference.poolside.ai/v1/models",
  },
  models: [
    // The gateway's model ids are vendor-prefixed, and /v1/models strips a
    // leading `${providerId}/` from registry ids — so without upstreamModelId
    // the advertised `ps/laguna-*` forwards a stripped id and the gateway 404s
    // with "please check the model you provided".
    { id: "laguna-s-2.1", name: "Laguna S 2.1", upstreamModelId: "poolside/laguna-s-2.1" },
    { id: "laguna-xs-2.1", name: "Laguna XS 2.1", upstreamModelId: "poolside/laguna-xs-2.1" },
  ],
};

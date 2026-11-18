export default {
  id: "nvidia",
  priority: 20,
  hasFree: true,
  alias: "nvidia",
  display: {
    name: "NVIDIA NIM",
    icon: "developer_board",
    color: "#76B900",
    textIcon: "NV",
    website: "https://developer.nvidia.com/nim",
    notice: {
      text: "Free access for NVIDIA Developer Program members (prototyping & testing).",
      apiKeyUrl: "https://build.nvidia.com/settings/api-keys",
    },
  },
  category: "freeTier",
  authType: "apikey",
  authModes: ["apikey"],
  transport: {
    baseUrl: "https://integrate.api.nvidia.com/v1/chat/completions",
    validateUrl: "https://integrate.api.nvidia.com/v1/models",
    timeoutMs: 90000,
    quirks: {
      dropClientMetadata: true,
    },
  },
  models: [
    { id: "nemotron-3.5-lightning-30b-a3b", upstreamModelId: "nvidia/nemotron-3.5-lightning-30b-a3b", name: "Nemotron 3.5 Lightning" },
    { id: "nemotron-3.5-bolt-e4b", upstreamModelId: "nvidia/nemotron-3.5-bolt-e4b", name: "Nemotron 3.5 Bolt" },
    { id: "nemotron-3-nano-omni-30b-a3b-reasoning", upstreamModelId: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning", name: "Nemotron 3 Nano Omni" },
    { id: "poolside/laguna-xs-2.1", name: "Laguna XS 2.1" },
    { id: "meta/llama-guard-4-12b", name: "Llama Guard 4 12B" },
    { id: "riva-translate-4b-instruct-v2", upstreamModelId: "nvidia/riva-translate-4b-instruct-v2", name: "Riva Translate 4B v2" },
    { id: "meta/llama-3.3-70b-instruct", name: "Llama 3.3 70B Instruct" },
    { id: "minimaxai/minimax-m2.7", name: "MiniMax M2.7" },
    { id: "minimaxai/minimax-m3", name: "MiniMax M3" },
    { id: "z-ai/glm-5.2", name: "GLM 5.2" },
    { id: "deepseek-ai/deepseek-v4-pro", name: "DeepSeek V4 Pro" },
    { id: "deepseek-ai/deepseek-v4-flash", name: "DeepSeek V4 Flash" },
    { id: "moonshotai/kimi-k2.6", name: "Kimi K2.6" },
    // NVIDIA's own ids carry a `nvidia/` vendor prefix, which /v1/models strips
    // (it removes a leading `${providerId}/`) — so the registry id is the bare
    // form and the wire id is declared explicitly, exactly like poolside's
    // `poolside/laguna-*`.
    { id: "nemotron-3-ultra-550b-a55b", upstreamModelId: "nvidia/nemotron-3-ultra-550b-a55b", name: "Nemotron 3 Ultra" },
    { id: "nv-embedqa-e5-v5", upstreamModelId: "nvidia/nv-embedqa-e5-v5", name: "NV EmbedQA E5 v5", kind: "embedding" },
    { id: "parakeet-ctc-1.1b-asr", upstreamModelId: "nvidia/parakeet-ctc-1.1b-asr", name: "Parakeet CTC 1.1B", params: ["language"], kind: "stt" },
    { id: "fastpitch", name: "FastPitch", kind: "tts" },
    { id: "tacotron2", name: "Tacotron2", kind: "tts" },
  ],
  serviceKinds: ["llm","tts","embedding"],
  ttsConfig: {
    baseUrl: "https://integrate.api.nvidia.com/v1/audio/speech",
    authType: "apikey",
    authHeader: "bearer",
    format: "nvidia-tts",
  },
  embeddingConfig: { baseUrl: "https://integrate.api.nvidia.com/v1/embeddings", authType: "apikey", authHeader: "bearer" },
};

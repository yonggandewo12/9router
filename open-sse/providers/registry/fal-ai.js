export default {
  id: "fal-ai",
  priority: 90,
  hasFree: true,
  alias: "fal-ai",
  aliases: [
    "fal",
  ],
  uiAlias: "fal",
  display: {
    name: "Fal.ai",
    icon: "image",
    color: "#2563EB",
    textIcon: "FL",
    website: "https://fal.ai",
    notice: {
      apiKeyUrl: "https://fal.ai/dashboard/keys",
    },
  },
  category: "apikey",
  authType: "apikey",
  transport: null,
  models: [
    // Fal's queue URLs are `queue.fal.run/<fal model id>` and their ids carry the
    // `fal-ai/` vendor prefix, so the prefix belongs in baseUrl: /v1/models strips
    // a leading `${providerId}/` from registry ids, and the image path forwards
    // the resolved id verbatim — with the prefix on the id, the advertised
    // `fal/flux/schnell` built `queue.fal.run/flux/schnell` and 404'd.
    { id: "flux/schnell", name: "FLUX Schnell", params: ["n","size"], kind: "image" },
    { id: "flux/dev", name: "FLUX Dev", params: ["n","size"], kind: "image" },
    { id: "flux-pro/v1.1", name: "FLUX Pro v1.1", params: ["n","size"], kind: "image" },
    { id: "flux-pro/v1.1-ultra", name: "FLUX Pro v1.1 Ultra", params: ["n","size"], kind: "image" },
    { id: "recraft-v3", name: "Recraft V3", params: ["n","size","style"], kind: "image" },
    { id: "ideogram/v2", name: "Ideogram V2", params: ["n","size","style"], kind: "image" },
    { id: "stable-diffusion-v35-large", name: "SD 3.5 Large", params: ["n","size"], kind: "image" },
  ],
  serviceKinds: ["image"],
  imageConfig: { baseUrl: "https://queue.fal.run/fal-ai" },
};

// Chat requests now pass through isRoutableProvider before the account loop
// (upstream v0.5.112), so a provider id this gate does not recognise is a 404 —
// including every provider this fork adds. The gate exists to stop a removed id
// from falling through to DefaultExecutor and shipping its stored credential to
// api.openai.com, so it must stay strict; what it must never do is reject a
// provider we actually ship.
import { describe, expect, it } from "vitest";

import registry from "../../open-sse/providers/registry/index.js";
import { PROVIDERS } from "../../open-sse/config/providers.js";
import { isRoutableProvider } from "../../open-sse/handlers/chatCore.js";
import aliasBaseline from "../__baseline__/alias-baseline.json";

describe("isRoutableProvider covers what this fork ships", () => {
  it("accepts every registry provider that declares an llm service kind", () => {
    const llmCapable = registry
      .filter((p) => Array.isArray(p.serviceKinds) && p.serviceKinds.includes("llm"))
      .map((p) => p.id);
    expect(llmCapable.length).toBeGreaterThan(20);
    expect(llmCapable.filter((id) => !isRoutableProvider(id))).toEqual([]);
  });

  it("accepts every alias token that points at a chat-capable provider", () => {
    const chatCapable = new Set([
      ...Object.keys(PROVIDERS),
      ...registry.filter((p) => Array.isArray(p.serviceKinds) ? p.serviceKinds.includes("llm") : false).map((p) => p.id),
    ]);
    // The alias baseline is the authoritative token → id table a client can land on.
    const broken = Object.entries(aliasBaseline.aliasToId)
      .filter(([, id]) => id && chatCapable.has(id) && !isRoutableProvider(id));
    expect(broken).toEqual([]);
  });

  it("accepts every registry id that has a transport, and every web-cookie lane", () => {
    const withTransport = Object.keys(PROVIDERS).filter((id) => !isRoutableProvider(id));
    expect(withTransport).toEqual([]);
    for (const id of ["chatgpt-web", "deepseek-web", "zcode", "codebuddy-cn", "minimax-cn"]) {
      expect(isRoutableProvider(id), `${id} must be routable`).toBe(true);
    }
  });

  it("still rejects an id the executor layer cannot resolve", () => {
    // The whole point of the gate: a row naming a provider that no longer exists.
    expect(isRoutableProvider("gemini-web")).toBe(false);
    expect(isRoutableProvider("definitely-not-a-provider")).toBe(false);
  });

  it("keeps a System One-only provider out of the chat lane", () => {
    // nace/drex answers the /v1/systemone protocol, not chat completions. It has no
    // chat transport, so letting it through would hand its key to DefaultExecutor —
    // i.e. to api.openai.com. The systemone route owns it instead.
    const nace = registry.find((p) => p.id === "nace");
    expect(nace.models.every((m) => m.kind === "systemone")).toBe(true);
    expect(isRoutableProvider("nace")).toBe(false);
  });
});

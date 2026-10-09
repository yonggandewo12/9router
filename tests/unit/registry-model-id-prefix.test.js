// /v1/models advertises `${alias}/${strippedId}`, where strippedId drops a leading
// `${outputAlias}/`, `${staticAlias}/` or `${providerId}/` from the registry id.
// A registry id that carries its own provider prefix therefore advertises the bare
// form, routing looks the bare form up, never finds the prefixed entry, and forwards
// a bare id upstream (404/400). The wire prefix belongs in `upstreamModelId` (or in
// the adapter's baseUrl), never in `id`.
import { describe, it, expect } from "vitest";
import registry from "../../open-sse/providers/registry/index.js";
import { getModelUpstreamId } from "../../open-sse/config/providerModels.js";

describe("registry model id prefix invariant", () => {
  it("has no model id prefixed by its own provider id or alias", () => {
    const offenders = [];
    for (const r of registry) {
      const prefixes = [...new Set([r.id, r.alias, ...(r.aliases || [])].filter(Boolean))];
      for (const m of r.models || []) {
        if (typeof m.id !== "string") continue;
        for (const p of prefixes) {
          if (m.id.startsWith(`${p}/`)) offenders.push(`${r.id}: ${m.id} (prefix ${p}/)`);
        }
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("resolves every advertised id to a non-empty wire id", () => {
    let checked = 0;
    for (const r of registry) {
      const alias = r.alias || r.id;
      for (const m of r.models || []) {
        if (typeof m.id !== "string" || !m.id) continue;
        const wire = getModelUpstreamId(alias, m.id);
        expect(wire, `${alias}/${m.id} resolved to nothing`).toBeTruthy();
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(500);
  });
});

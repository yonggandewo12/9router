import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { PROVIDER_ID_TO_ALIAS as SERVER_TABLE } from "../../open-sse/config/providerModels.js";

// The CLI package is CJS and cannot import open-sse, so modelSelector.js keeps a
// hand-copied id→alias table. A stale copy hides a connected provider's models
// from `9router-proxy connect`: /v1/models reports owned_by = alias, while the
// picker's active-provider set is built from connection provider ids.
const CLI_FILE = new URL("../../cli/src/cli/utils/modelSelector.js", import.meta.url);

function readCliTable() {
  const src = readFileSync(CLI_FILE, "utf8");
  const start = src.indexOf("const PROVIDER_ID_TO_ALIAS = {");
  if (start === -1) throw new Error("PROVIDER_ID_TO_ALIAS not found in modelSelector.js");
  const end = src.indexOf("\n};", start);
  return new Function(`return (${src.slice(src.indexOf("{", start), end + 2)});`)();
}

describe("CLI provider alias copy vs server table", () => {
  const cli = readCliTable();
  // Identity mappings need no CLI entry: the picker falls back to the raw id.
  const aliased = Object.entries(SERVER_TABLE).filter(([id, alias]) => alias !== id);

  it("covers every provider whose alias differs from its id", () => {
    const missing = aliased
      .filter(([id]) => cli[id] === undefined)
      .map(([id, alias]) => `${id} -> ${alias}`);
    expect(missing).toEqual([]);
  });

  it("has no wrong or stale entries", () => {
    const bad = Object.entries(cli)
      .filter(([id, alias]) => SERVER_TABLE[id] !== alias)
      .map(([id, alias]) => `${id}: cli=${alias} server=${SERVER_TABLE[id]}`);
    expect(bad).toEqual([]);
  });

  it("still lists the aliases the merge added", () => {
    for (const [id, alias] of [["bedrock", "br"], ["bedrock-xai", "brx"], ["minimax-code", "mm"], ["minimax-code-global", "mmg"]]) {
      expect(cli[id], `${id} missing from the CLI alias table`).toBe(alias);
    }
  });
});

import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { makeKv } from "../helpers/kvStore.js";

const aliasKv = makeKv("modelAliases");
const customKv = makeKv("customModels");
const mitmKv = makeKv("mitmAlias");

// modelAliases: key=alias, value="provider/model"
// Every reader treats the value as a string (ModelSelectModal does
// .startsWith() on each entry), so the legacy {provider, model} form that the
// lowdb migration and the import path can write verbatim is normalised here —
// and a value that cannot name a model is dropped instead of throwing in the
// middle of whoever renders the list.
export async function getModelAliases() {
  const rows = await aliasKv.getAll();
  const out = {};
  for (const [alias, value] of Object.entries(rows)) {
    const target = aliasTarget(value);
    if (target) out[alias] = target;
  }
  return out;
}

// resolveModelAliasFromMap honours both "provider/model" and {provider, model};
// this is the same recognisation, reduced to a string.
function aliasTarget(value) {
  if (typeof value === "string") return value.trim();
  if (value && typeof value === "object" && value.provider && value.model) return `${value.provider}/${value.model}`;
  return "";
}

// Both PUT routes write through here, so the type check happens once on the way
// in rather than in every reader.
export async function setModelAlias(alias, model) {
  if (typeof alias !== "string" || !alias.trim() || typeof model !== "string" || !model.trim()) {
    throw new Error(`invalid model alias ${JSON.stringify(alias)} → ${JSON.stringify(model)}`);
  }
  await aliasKv.set(alias.trim(), model.trim());
}

export async function deleteModelAlias(alias) {
  await aliasKv.remove(alias);
}

// customModels: key=`${providerAlias}|${id}|${type}`, value=full model object
function customKey(providerAlias, id, type) {
  return `${providerAlias}|${id}|${type}`;
}

export async function getCustomModels() {
  const all = await customKv.getAll();
  return Object.values(all);
}

// Atomic upsert inside transaction to prevent duplicate races.
// Re-adding an existing model updates caps/name/transport without resetting omitted fields.
export async function addCustomModel({ providerAlias, id, type = "llm", name, caps, transport }) {
  const k = customKey(providerAlias, id, type);
  const db = await getAdapter();
  let added = false;
  db.transaction(() => {
    const row = db.get(`SELECT value FROM kv WHERE scope = 'customModels' AND key = ?`, [k]);
    if (row) {
      const prev = parseJson(row.value) || {};
      const next = { ...prev, ...(name ? { name } : {}), ...(caps ? { caps } : {}), ...(transport ? { transport } : {}) };
      db.run(`UPDATE kv SET value = ? WHERE scope = 'customModels' AND key = ?`, [stringifyJson(next), k]);
      return;
    }
    const value = stringifyJson({ providerAlias, id, type, name: name || id, ...(caps ? { caps } : {}), ...(transport ? { transport } : {}) });
    db.run(`INSERT INTO kv(scope, key, value) VALUES('customModels', ?, ?)`, [k, value]);
    added = true;
  });
  return added;
}

export async function deleteCustomModel({ providerAlias, id, type = "llm" }) {
  await customKv.remove(customKey(providerAlias, id, type));
}

// Cascade for a dying provider/connection/node. A node answers to two names —
// its raw id (what the dashboard stores) and its prefix (what /v1/models
// advertises, and what a client therefore copies back into a custom model or an
// alias) — so both have to be matched or the rows the cascade exists to remove
// survive under the other spelling.
//
// customModels keys are prefixed with the provider name, so deleting the owner
// must delete its rows too: otherwise the combo picker keeps showing ghost
// groups for dead connections. JS-side prefix filter (not LIKE) because names
// can contain LIKE wildcards.
export async function deleteCustomModelsByProvider(providerNames) {
  const names = [providerNames].flat().filter(Boolean);
  if (!names.length) return 0;
  const db = await getAdapter();
  let removed = 0;
  db.transaction(() => {
    const rows = db.all(`SELECT key FROM kv WHERE scope = 'customModels'`);
    for (const { key } of rows) {
      if (!names.some((name) => key.startsWith(`${name}|`))) continue;
      db.run(`DELETE FROM kv WHERE scope = 'customModels' AND key = ?`, [key]);
      removed++;
    }
  });
  return removed;
}

// modelAliases are canonical {alias → "provider/model"} (every reader filters by
// value — ModelSelectModal, /api/v1/models). A dying node must also drop the
// shortcuts that resolve through it, or they dangle and fail at request time.
export async function deleteModelAliasesForProvider(providerNames) {
  const names = [providerNames].flat().filter(Boolean);
  if (!names.length) return 0;
  const db = await getAdapter();
  let removed = 0;
  db.transaction(() => {
    const rows = db.all(`SELECT key, value FROM kv WHERE scope = 'modelAliases'`);
    for (const { key, value } of rows) {
      const target = aliasTarget(parseJson(value, ""));
      if (!names.some((name) => target.startsWith(`${name}/`))) continue;
      db.run(`DELETE FROM kv WHERE scope = 'modelAliases' AND key = ?`, [key]);
      removed++;
    }
  });
  return removed;
}

// mitmAlias: key=toolName, value=mappings object
export async function getMitmAlias(toolName) {
  if (toolName) {
    const v = await mitmKv.get(toolName);
    return v || {};
  }
  return await mitmKv.getAll();
}

export async function setMitmAliasAll(toolName, mappings) {
  await mitmKv.set(toolName, mappings || {});
}

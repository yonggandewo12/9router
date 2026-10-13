import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { makeKv } from "../helpers/kvStore.js";

const aliasKv = makeKv("modelAliases");
const customKv = makeKv("customModels");
const mitmKv = makeKv("mitmAlias");

// modelAliases: key=alias, value=modelString
export async function getModelAliases() {
  return await aliasKv.getAll();
}

export async function setModelAlias(alias, model) {
  await aliasKv.set(alias, model);
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

// Cascade for a dying provider/connection/node: customModels keys are prefixed
// with the providerAlias, so deleting the owner must delete its rows too —
// otherwise the combo picker keeps showing ghost groups for dead connections.
// JS-side prefix filter (not LIKE) because aliases can contain LIKE wildcards.
export async function deleteCustomModelsByProvider(providerAlias) {
  if (!providerAlias) return 0;
  const prefix = `${providerAlias}|`;
  const db = await getAdapter();
  let removed = 0;
  db.transaction(() => {
    const rows = db.all(`SELECT key FROM kv WHERE scope = 'customModels'`);
    for (const { key } of rows) {
      if (!key.startsWith(prefix)) continue;
      db.run(`DELETE FROM kv WHERE scope = 'customModels' AND key = ?`, [key]);
      removed++;
    }
  });
  return removed;
}

// modelAliases are canonical {alias → "providerId/model"} (every reader filters
// by value — ModelSelectModal, /api/v1/models). A dying node must also drop the
// shortcuts that resolve through it, or they dangle and fail at request time.
export async function deleteModelAliasesForProvider(providerId) {
  if (!providerId) return 0;
  const prefix = `${providerId}/`;
  const db = await getAdapter();
  let removed = 0;
  db.transaction(() => {
    const rows = db.all(`SELECT key, value FROM kv WHERE scope = 'modelAliases'`);
    for (const { key, value } of rows) {
      if (!String(parseJson(value, "")).startsWith(prefix)) continue;
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

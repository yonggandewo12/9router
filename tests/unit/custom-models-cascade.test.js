// deleteCustomModelsByProvider — the cascade that keeps the combo picker from
// showing ghost groups after a provider node/connection is deleted.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-cascade-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("customModels provider cascade", () => {
  it("removes only the dying alias's rows", async () => {
    const ghost = "openai-compatible-chat-71d63a37-a50b-460d-a9cd-52813bae5dfc";
    await db.addCustomModel({ providerAlias: ghost, id: "gpt-5.4", type: "llm" });
    await db.addCustomModel({ providerAlias: ghost, id: "gpt-5.5", type: "llm" });
    await db.addCustomModel({ providerAlias: "ollama", id: "llama-3", type: "llm" });

    expect(await db.deleteCustomModelsByProvider(ghost)).toBe(2);
    const left = await db.getCustomModels();
    expect(left.map((m) => `${m.providerAlias}/${m.id}`)).toEqual(["ollama/llama-3"]);
  });

  it("treats LIKE wildcards in an alias literally", async () => {
    await db.addCustomModel({ providerAlias: "a_b", id: "m1", type: "llm" });
    await db.addCustomModel({ providerAlias: "axb", id: "m2", type: "llm" });
    expect(await db.deleteCustomModelsByProvider("a_b")).toBe(1);
    const left = (await db.getCustomModels()).find((m) => m.providerAlias === "axb");
    expect(left?.id).toBe("m2");
  });

  it("empty alias is a no-op (never wipes the scope)", async () => {
    expect(await db.deleteCustomModelsByProvider("")).toBe(0);
    expect((await db.getCustomModels()).length).toBeGreaterThan(0);
  });

  it("drops model aliases and disabledModels keyed on the dying node", async () => {
    const dead = "openai-compatible-chat-deadbeef-0000-0000-0000-000000000000";
    await db.setModelAlias("fast-glm", `${dead}/glm-4.7`);
    await db.setModelAlias("keep-me", "ollama/llama-3");
    await db.disableModels(dead, ["glm-4.7"]);
    await db.disableModels("ollama", ["llama-2"]);

    expect(await db.deleteModelAliasesForProvider(dead)).toBe(1);
    expect(await db.getModelAliases()).toEqual({ "keep-me": "ollama/llama-3" });

    await db.enableModels(dead, []);
    const disabled = await db.getDisabledModels();
    expect(disabled[dead]).toBeUndefined();
    expect(disabled.ollama).toEqual(["llama-2"]);
  });

  it("PUT /api/models stores the canonical {alias → provider/model} direction", async () => {
    const route = await import("@/app/api/models/route.js");
    const res = await route.PUT(new Request("http://x/api/models", {
      method: "PUT",
      body: JSON.stringify({ model: "ark/glm-5.3", alias: "glm-fast" }),
      headers: { "content-type": "application/json" },
    }));
    expect((await res.json()).success).toBe(true);
    expect(await db.getModelAliases()).toMatchObject({ "glm-fast": "ark/glm-5.3" });

    // stealing another model's alias is refused
    const clash = await route.PUT(new Request("http://x/api/models", {
      method: "PUT",
      body: JSON.stringify({ model: "other/model", alias: "glm-fast" }),
      headers: { "content-type": "application/json" },
    }));
    expect(clash.status).toBe(400);
  });

  it("cascade drops the legacy {provider, model} alias form too", async () => {
    const dead = "openai-compatible-chat-legacy-form";
    const { getAdapter } = await import("@/lib/db/driver.js");
    const adapter = await getAdapter();
    adapter.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('modelAliases', ?, ?)`,
      ["legacy-target", JSON.stringify({ provider: dead, model: "glm-4.7" })]);

    expect(await db.deleteModelAliasesForProvider(dead)).toBe(1);
    expect(await db.getModelAliases()).not.toHaveProperty("legacy-target");
  });

  // ModelSelectModal calls .startsWith() on every value; one non-string row
  // blanks the whole picker, so the repo is the place that says no.
  it("refuses an alias or target that readers cannot treat as a string", async () => {
    await expect(db.setModelAlias("bad", { provider: "ark", model: "glm" })).rejects.toThrow();
    await expect(db.setModelAlias(" ", "ark/glm")).rejects.toThrow();
    expect(await db.getModelAliases()).not.toHaveProperty("bad");
  });

  // setModelAlias guards the write path, but migrate.js and the import path
  // INSERT alias values verbatim, so the read path has to be the one that
  // guarantees a string — ModelSelectModal calls .startsWith() on every value.
  it("hands readers a string for rows the migration wrote verbatim", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const adapter = await getAdapter();
    const put = (key, value) => adapter.run(
      `INSERT OR REPLACE INTO kv(scope, key, value) VALUES('modelAliases', ?, ?)`, [key, JSON.stringify(value)]);

    await put("legacy-object", { provider: "ark", model: "glm-5.3" });
    await put("no-model-here", { provider: "ark" });
    await put("not-an-object", 42);

    const aliases = await db.getModelAliases();
    expect(aliases["legacy-object"]).toBe("ark/glm-5.3");
    expect(aliases).not.toHaveProperty("no-model-here");
    expect(aliases).not.toHaveProperty("not-an-object");

    await db.deleteModelAlias("legacy-object");
    await db.deleteModelAlias("no-model-here");
    await db.deleteModelAlias("not-an-object");
  });

  it("PUT /api/models/alias follows the same rule as PUT /api/models", async () => {
    const route = await import("@/app/api/models/alias/route.js");
    const put = (body) => route.PUT(new Request("http://x/api/models/alias", {
      method: "PUT",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }));

    expect((await put({ model: "other/model", alias: "glm-fast" })).status).toBe(400);
    expect((await put({ model: "ark/first", alias: "repaint" })).status).toBe(200);
    // the name is now a bound shortcut: same target is idempotent, moving it to
    // another model goes through delete + create like the sibling route does
    expect((await put({ model: "ark/first", alias: "repaint" })).status).toBe(200);
    expect((await put({ model: "ark/second", alias: "repaint" })).status).toBe(400);
    expect(await db.getModelAliases()).toMatchObject({ repaint: "ark/first" });
  });

  // A node answers to two names: its raw id (what the dashboard stores) and its
  // prefix (what /v1/models advertises, so what a client copies back). Matching
  // only the id leaves working rows behind under the other spelling.
  it("matches both spellings of a node when handed a list", async () => {
    const id = "openai-compatible-chat-cafe0000-0000-0000-0000-000000000000";
    const names = [id, "glados"];
    await db.addCustomModel({ providerAlias: id, id: "glm-4.7", type: "llm" });
    await db.addCustomModel({ providerAlias: "glados", id: "glm-4.7", type: "llm" });
    await db.addCustomModel({ providerAlias: "glados", id: "other", type: "embedding" });
    await db.setModelAlias("by-id", `${id}/glm-4.7`);
    await db.setModelAlias("by-prefix", "glados/glm-4.7");
    await db.disableModels(id, ["glm-4.7"]);
    await db.disableModels("glados", ["glm-4.7"]);

    expect(await db.deleteCustomModelsByProvider(names)).toBe(3);
    expect(await db.deleteModelAliasesForProvider(names)).toBe(2);
    expect(await db.getModelAliases()).not.toHaveProperty("by-prefix");
    for (const name of names) await db.enableModels(name, []);

    const left = (await db.getCustomModels()).map((m) => m.providerAlias);
    expect(left).not.toContain("glados");
    expect(left).not.toContain(id);
  });

  it("an empty or falsy name list never wipes a scope", async () => {
    const before = (await db.getCustomModels()).length;
    expect(await db.deleteCustomModelsByProvider([])).toBe(0);
    expect(await db.deleteCustomModelsByProvider([null, undefined, ""])).toBe(0);
    expect(await db.deleteModelAliasesForProvider([])).toBe(0);
    expect((await db.getCustomModels()).length).toBe(before);
  });
});

describe("DELETE /api/provider-nodes/[id]", () => {
  it("takes the node's kv rows with it", async () => {
    const node = await db.createProviderNode({
      type: "openai-compatible", name: "Dying node", prefix: "dying", baseUrl: "http://127.0.0.1:9/v1",
    });
    await db.addCustomModel({ providerAlias: node.id, id: "glm-4.7", type: "llm" });
    await db.addCustomModel({ providerAlias: "dying", id: "glm-4.7", type: "llm" });
    await db.setModelAlias("dying-fast", `${node.id}/glm-4.7`);
    await db.setModelAlias("dying-slow", "dying/glm-4.7");
    await db.disableModels(node.id, ["glm-4.7"]);
    await db.disableModels("dying", ["glm-4.7"]);

    const route = await import("@/app/api/provider-nodes/[id]/route.js");
    const res = await route.DELETE(
      new Request(`http://x/api/provider-nodes/${node.id}`, { method: "DELETE" }),
      { params: Promise.resolve({ id: node.id }) },
    );

    expect(res.status).toBe(200);
    expect(await db.getProviderNodeById(node.id)).toBeNull();
    const survivors = (await db.getCustomModels()).map((m) => m.providerAlias);
    expect(survivors).not.toContain(node.id);
    expect(survivors).not.toContain("dying");
    expect(await db.getModelAliases()).not.toHaveProperty("dying-fast");
    expect(await db.getModelAliases()).not.toHaveProperty("dying-slow");
    const disabled = await db.getDisabledModels();
    expect(disabled[node.id]).toBeUndefined();
    expect(disabled.dying).toBeUndefined();
  });

  // The node row is deleted last on purpose: if a cascade fails, the node is
  // still there and the DELETE can be retried instead of 404-ing on orphans.
  it("keeps the node when a cascade fails, so the delete stays retryable", async () => {
    const node = await db.createProviderNode({
      type: "openai-compatible", name: "Half-dead node", prefix: "halfdying", baseUrl: "http://127.0.0.1:9/v1",
    });
    const reached = [];
    vi.doMock("@/models", () => ({
      getProviderNodeById: async (id) => (id === node.id ? { id, prefix: "halfdying" } : null),
      getProviderConnections: async () => [],
      updateProviderConnection: async () => {},
      updateProviderNode: async () => {},
      deleteProviderConnectionsByProvider: async (id) => { reached.push(["connections", id]); },
      deleteCustomModelsByProvider: async (names) => { reached.push(["customModels", names]); },
      deleteModelAliasesForProvider: async () => { throw new Error("cascade failed"); },
      enableModels: async () => {},
      deleteProviderNode: async () => { throw new Error("must not be reached"); },
    }));
    vi.resetModules();

    const { DELETE } = await import("@/app/api/provider-nodes/[id]/route.js");
    const res = await DELETE(
      new Request(`http://x/api/provider-nodes/${node.id}`, { method: "DELETE" }),
      { params: Promise.resolve({ id: node.id }) },
    );

    vi.doUnmock("@/models");
    expect(res.status).toBe(500);
    expect(reached).toEqual([
      ["connections", node.id],
      ["customModels", [node.id, "halfdying"]],
    ]);
    expect(await db.getProviderNodeById(node.id)).not.toBeNull();
  });

  // A prefix is user-typed and unchecked, so "<prefix>/model" rows are only
  // this node's if nothing else answers to that name. A node prefixed "ollama"
  // is a thing people configure, and its rows are then indistinguishable from
  // the live provider's — leaking a row beats deleting someone else's.
  it("does not cascade under a prefix a built-in provider already answers to", async () => {
    const node = await db.createProviderNode({
      type: "openai-compatible", name: "Confusing node", prefix: "ollama", baseUrl: "http://127.0.0.1:9/v1",
    });
    await db.addCustomModel({ providerAlias: "ollama", id: "llama-4", type: "llm" });
    await db.setModelAlias("ollama-keep", "ollama/llama-4");

    vi.resetModules();
    const route = await import("@/app/api/provider-nodes/[id]/route.js");
    const res = await route.DELETE(
      new Request(`http://x/api/provider-nodes/${node.id}`, { method: "DELETE" }),
      { params: Promise.resolve({ id: node.id }) },
    );

    expect(res.status).toBe(200);
    expect(await db.getProviderNodeById(node.id)).toBeNull();
    expect((await db.getCustomModels()).some((m) => m.providerAlias === "ollama" && m.id === "llama-4")).toBe(true);
    expect(await db.getModelAliases()).toMatchObject({ "ollama-keep": "ollama/llama-4" });
    expect((await db.getDisabledModels()).ollama).toEqual(["llama-2"]);
  });

  it("does not cascade under a prefix a sibling node still advertises", async () => {
    const twinA = await db.createProviderNode({
      type: "openai-compatible", name: "Twin A", prefix: "twins", baseUrl: "http://127.0.0.1:9/v1",
    });
    const twinB = await db.createProviderNode({
      type: "openai-compatible", name: "Twin B", prefix: "twins", baseUrl: "http://127.0.0.1:9/v1",
    });
    await db.createProviderConnection({
      provider: twinB.id, authType: "apikey", name: "twin-b-key", apiKey: "not-a-secret",
      providerSpecificData: { prefix: "twins" },
    });

    await db.addCustomModel({ providerAlias: "twins", id: "glm-4.7", type: "llm" });
    await db.addCustomModel({ providerAlias: twinA.id, id: "glm-4.7", type: "llm" });
    await db.setModelAlias("twins-fast", "twins/glm-4.7");

    vi.resetModules();
    const route = await import("@/app/api/provider-nodes/[id]/route.js");
    const res = await route.DELETE(
      new Request(`http://x/api/provider-nodes/${twinA.id}`, { method: "DELETE" }),
      { params: Promise.resolve({ id: twinA.id }) },
    );

    expect(res.status).toBe(200);
    const survivors = (await db.getCustomModels()).map((m) => `${m.providerAlias}/${m.id}`);
    expect(survivors).toContain("twins/glm-4.7");
    expect(survivors).not.toContain(`${twinA.id}/glm-4.7`);
    expect(await db.getModelAliases()).toMatchObject({ "twins-fast": "twins/glm-4.7" });
    expect(await db.getProviderNodeById(twinB.id)).not.toBeNull();
  });
});

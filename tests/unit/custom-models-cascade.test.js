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
});

// Regression coverage for the lazy runtime resolver.
//
// The published CLI bundle used to fold `createRequire(<dynamic path>)` to
// `void 0`, so every web-login start died with "Cannot read properties of
// undefined (reading 'resolve')" before the on-demand install could run.
// The resolver below is fs-only and must stay importable from a bundle.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { resolvePackageEntry } from "open-sse/services/lazyRuntime.js";

let root;

function writePkg(name, pkgJson, files = ["index.js"]) {
  const dir = path.join(root, "node_modules", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), typeof pkgJson === "string" ? pkgJson : JSON.stringify(pkgJson));
  for (const file of files) {
    const abs = path.join(dir, file);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, "export default 1;\n");
  }
  return dir;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "9r-lazy-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("resolvePackageEntry", () => {
  it("resolves the main field", () => {
    writePkg("plain", { main: "dist/main.js" }, ["dist/main.js"]);
    expect(resolvePackageEntry(root, "plain")).toBe(
      pathToFileURL(path.join(root, "node_modules/plain/dist/main.js")).href
    );
  });

  it("falls back to index.js when package.json names no entry", () => {
    writePkg("bare", { name: "bare" });
    expect(resolvePackageEntry(root, "bare")).toBe(
      pathToFileURL(path.join(root, "node_modules/bare/index.js")).href
    );
  });

  it("resolves a directory main to its index.js", () => {
    writePkg("dir-main", { main: "lib" }, ["lib/index.js"]);
    expect(resolvePackageEntry(root, "dir-main")).toBe(
      pathToFileURL(path.join(root, "node_modules/dir-main/lib/index.js")).href
    );
  });

  it("prefers module over main", () => {
    writePkg("dual", { main: "cjs.js", module: "esm.js" }, ["cjs.js", "esm.js"]);
    expect(resolvePackageEntry(root, "dual")).toBe(
      pathToFileURL(path.join(root, "node_modules/dual/esm.js")).href
    );
  });

  it("handles the exports subpath map and its conditions", () => {
    writePkg("exp-sub", { exports: { ".": "./src/index.mjs" } }, ["src/index.mjs"]);
    writePkg("exp-cond", { exports: { ".": { import: "./esm/index.js", require: "./cjs/index.cjs" } } }, [
      "esm/index.js",
      "cjs/index.cjs",
    ]);
    writePkg("exp-bare", { exports: { import: "./esm/index.js" } }, ["esm/index.js"]);
    expect(resolvePackageEntry(root, "exp-sub")).toContain("/exp-sub/src/index.mjs");
    expect(resolvePackageEntry(root, "exp-cond")).toContain("/exp-cond/esm/index.js");
    expect(resolvePackageEntry(root, "exp-bare")).toContain("/exp-bare/esm/index.js");
  });

  it("falls back through an exports array", () => {
    writePkg("exp-array", { exports: [null, "./real.js"] }, ["real.js"]);
    expect(resolvePackageEntry(root, "exp-array")).toContain("/exp-array/real.js");
  });

  it("returns null for missing, malformed or path-like package names", () => {
    expect(resolvePackageEntry(root, "nope")).toBeNull();
    writePkg("broken", "{not json");
    expect(resolvePackageEntry(root, "broken")).toBeNull();
    writePkg("no-entry", { main: "dist/gone.js" });
    expect(resolvePackageEntry(root, "no-entry")).toBeNull();
    // Bare names only: a subpath or relative name must never be joined here.
    expect(resolvePackageEntry(root, "../escape")).toBeNull();
    expect(resolvePackageEntry(root, "pkg/sub")).toBeNull();
    expect(resolvePackageEntry("", "x")).toBeNull();
  });
});

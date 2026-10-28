// Lazy loader for heavy optional runtime deps (playwright-core, wreq-js).
//
// They are devDependencies only, so end-user installs stay small. On first
// use the package is downloaded into <DATA_DIR>/runtime (same pattern as
// cli/hooks/sqliteRuntime.js) and imported from there. Resolution order:
// app node_modules (dev / traced standalone) → runtime dir → npm install.
//
// Never throws at import time of THIS module — failures surface from
// loadRuntimeDep() with a manual-install hint.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { getWritableDataDir } from "../utils/writableDataDir.js";

// Keep in sync with package.json devDependencies.
const LAZY_DEP_VERSIONS = {
  "playwright-core": "^1.62.1",
  "wreq-js": "^3.2.0",
};

function getRuntimeDir() {
  return path.join(getWritableDataDir(), "runtime");
}

function isModuleMissing(error) {
  const code = String(error?.code || "");
  return code === "MODULE_NOT_FOUND" || code === "ERR_MODULE_NOT_FOUND";
}

function npmInstall(pkg, version) {
  const cwd = getRuntimeDir();
  fs.mkdirSync(cwd, { recursive: true });
  // Anchor npm to the runtime dir so it can't adopt a parent package.json as install root.
  const manifest = path.join(cwd, "package.json");
  if (!fs.existsSync(manifest)) {
    fs.writeFileSync(manifest, JSON.stringify({ name: "9router-runtime", private: true }, null, 2));
  }
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const args = ["install", "--no-audit", "--no-fund", "--prefer-online", `${pkg}@${version}`];
  return new Promise((resolve) => {
    const child = spawn(npm, args, { cwd, stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32" });
    let stderr = "";
    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error) => resolve({ ok: false, stderr: String(error.message || error) }));
    child.on("close", (status) => resolve({ ok: status === 0, stderr }));
  });
}

async function installIntoRuntime(pkg, version) {
  const dir = getRuntimeDir();
  const res = await npmInstall(pkg, version);
  if (!res.ok) {
    const reason = (res.stderr.match(/npm ERR! ?(.+)/) || [])[1] || res.stderr.split("\n").filter(Boolean).pop() || "unknown npm error";
    throw new Error(
      `${pkg} is missing and the on-demand install failed (${String(reason).slice(0, 160)}) — ` +
      `install it manually: cd "${dir}" && npm install ${pkg}@${version}`
    );
  }
}

const inflight = new Map();

// Entry file of an installed package, resolved from package.json alone.
// createRequire().resolve() cannot be used here: Next's webpack build folds
// `createRequire(<dynamic path>)` to `void 0` in the published CLI bundle, so
// every lazy load threw "Cannot read properties of undefined (reading
// 'resolve')" before the on-demand install could run (0.6.15 and earlier).
// fs-only resolution survives bundling and costs one small JSON read.
function pickExportTarget(value) {
  if (!value) return null;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = pickExportTarget(item);
      if (hit) return hit;
    }
    return null;
  }
  if (typeof value !== "object") return null;
  // Subpath map wins over bare conditions ({".": ...} / {".": {import: ...}}).
  if (value["."] !== undefined) {
    const hit = pickExportTarget(value["."]);
    if (hit) return hit;
  }
  for (const condition of ["import", "node", "require", "default"]) {
    const hit = pickExportTarget(value[condition]);
    if (hit) return hit;
  }
  return null;
}

export function resolvePackageEntry(rootDir, pkg) {
  if (!rootDir || !pkg || pkg.includes("/") || pkg.includes("\\")) return null;
  const pkgDir = path.join(rootDir, "node_modules", pkg);
  let meta;
  try {
    meta = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"));
  } catch {
    return null;
  }
  const relative = pickExportTarget(meta.exports) || meta.module || meta.main || "index.js";
  let entry = path.resolve(pkgDir, relative);
  try {
    if (fs.statSync(entry).isDirectory()) entry = path.join(entry, "index.js");
  } catch {
    return null;
  }
  return pathToFileURL(entry).href;
}

async function load(pkg) {
  // 1) Resolvable from the app install (dev machine / traced standalone).
  try {
    return await import(/* webpackIgnore: true */ pkg);
  } catch (error) {
    if (!isModuleMissing(error)) throw error;
  }
  // 2) Already present in the runtime dir from a previous install.
  const runtimeDir = getRuntimeDir();
  const existing = resolvePackageEntry(runtimeDir, pkg);
  if (existing) {
    try {
      // webpackIgnore: without it the bundle replaces this with a chunk-map
      // lookup that always throws "Cannot find module '<file url>'" — the
      // runtime dir lives outside the webpack output by design.
      return await import(/* webpackIgnore: true */ existing);
    } catch (error) {
      if (!isModuleMissing(error)) throw error;
    }
  }
  // 3) Download on demand, then import from the runtime dir.
  // An unmapped name has no pinned version, and installing `latest` into the
  // proxy process is a supply-chain decision nobody made: declare the version
  // in LAZY_DEP_VERSIONS instead of guessing one.
  const version = LAZY_DEP_VERSIONS[pkg];
  if (!version) {
    throw new Error(
      `${pkg} is missing and has no pinned runtime version — add it to ` +
      `LAZY_DEP_VERSIONS in open-sse/services/lazyRuntime.js (never install "latest" at runtime).`
    );
  }
  const dir = getRuntimeDir();
  await installIntoRuntime(pkg, version);
  let installed = resolvePackageEntry(dir, pkg);
  if (!installed) {
    // npm exits 0 on a partially extracted install, so "no entry file" right after
    // a successful install usually means a torn node_modules, not a bad package
    // (upstream's fix for the same symptom). Wipe just this package and retry once;
    // the error below is the honest fallback if it is still unresolvable.
    fs.rmSync(path.join(dir, "node_modules", pkg), { recursive: true, force: true });
    await installIntoRuntime(pkg, version);
    installed = resolvePackageEntry(dir, pkg);
  }
  if (!installed) {
    throw new Error(
      `${pkg}@${version} installed into "${dir}" but no entry file could be resolved — ` +
      `check that the package ships a package.json with main/exports`
    );
  }
  return import(/* webpackIgnore: true */ installed);
}

export function loadRuntimeDep(pkg) {
  if (!inflight.has(pkg)) {
    inflight.set(pkg, load(pkg).finally(() => inflight.delete(pkg)));
  }
  return inflight.get(pkg);
}

import { describe, it, afterEach, expect } from "vitest";
import { createRequire } from "node:module";
import { mkdtempSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

const require_ = createRequire(import.meta.url);
const { getDataDir } = require_("../../cli/src/cli/utils/dataDir");

const realPlatform = process.platform;
const realEnv = { ...process.env };

function asPlatform(p) {
  Object.defineProperty(process, "platform", { value: p, configurable: true });
}

afterEach(() => {
  asPlatform(realPlatform);
  process.env = { ...realEnv };
});

describe("CLI data dir resolution", () => {
  it("uses ~/.9router on POSIX", () => {
    asPlatform("darwin");
    delete process.env.DATA_DIR;
    expect(getDataDir()).toBe(join(homedir(), ".9router"));
  });

  it("falls back to AppData/Roaming when %APPDATA% is unset on Windows", () => {
    asPlatform("win32");
    delete process.env.DATA_DIR;
    delete process.env.APPDATA;
    expect(getDataDir()).toBe(join(homedir(), "AppData", "Roaming", "9router"));
  });

  it("honours %APPDATA% on Windows", () => {
    asPlatform("win32");
    delete process.env.DATA_DIR;
    process.env.APPDATA = "D:\\roaming";
    expect(getDataDir()).toBe(join("D:\\roaming", "9router"));
  });

  it("drops a Unix-style DATA_DIR on Windows", () => {
    asPlatform("win32");
    process.env.APPDATA = "D:\\roaming";
    process.env.DATA_DIR = "/var/lib/9router";
    expect(getDataDir()).toBe(join("D:\\roaming", "9router"));
  });

  it("creates a configured DATA_DIR (including nested paths)", () => {
    asPlatform("linux");
    const root = mkdtempSync(join(tmpdir(), "9r-data-dir-"));
    const dir = join(root, "nested", "data");
    process.env.DATA_DIR = dir;
    try {
      expect(getDataDir()).toBe(dir);
      expect(existsSync(dir)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("falls back to the default instead of throwing when DATA_DIR is unusable", () => {
    asPlatform("linux");
    const root = mkdtempSync(join(tmpdir(), "9r-data-dir-"));
    const blocker = join(root, "afile");
    writeFileSync(blocker, "x");
    process.env.DATA_DIR = join(blocker, "sub");   // ENOTDIR
    try {
      expect(getDataDir()).toBe(join(homedir(), ".9router"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

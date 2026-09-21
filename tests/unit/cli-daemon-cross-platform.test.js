import { describe, it, afterAll, afterEach, expect } from "vitest";
import { createRequire } from "node:module";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const requireCjs = createRequire(import.meta.url);
const cp = requireCjs("child_process");

// daemon.js destructures execSync at load time, so the stub must be installed
// before the first require and stays installed for the whole file.
const realExecSync = cp.execSync;
let execSyncCalls = [];
let execSyncImpl = realExecSync;
cp.execSync = (...args) => {
  execSyncCalls.push(args[0]);
  return execSyncImpl(...args);
};

const daemon = requireCjs("../../cli/src/cli/commands/daemon.js");
const { isOurServer, terminateTree, processCommandLine } = daemon.__test__;

const realPlatform = process.platform;
const asPlatform = (p) => Object.defineProperty(process, "platform", { value: p, configurable: true });
function restore() {
  asPlatform(realPlatform);
  execSyncImpl = realExecSync;
  execSyncCalls = [];
}
afterEach(restore);
afterAll(restore);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const readPidFile = (file) => {
  try { return parseInt(readFileSync(file, "utf8").trim(), 10); } catch { return 0; }
};

// Waits must stay non-blocking: a busy loop starves the event loop, our exited child is
// never reaped, and a zombie still answers to signal 0 → "still alive" forever.
async function waitUntil(pred, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !pred()) await sleep(50);
  return pred();
}

describe("daemon PID identity", () => {
  it("rejects a PID that is alive but not ours (PID-reuse guard)", () => {
    const foreign = cp.spawn("sleep", ["30"], { stdio: "ignore" });
    try {
      expect(isAlive(foreign.pid)).toBe(true);
      expect(isOurServer(foreign.pid)).toBe(false);
      expect(processCommandLine(foreign.pid)).toMatch(/sleep/);
    } finally {
      foreign.kill("SIGKILL");
    }
  });

  it("accepts a live process whose command line is our server", () => {
    // The temp path contains "9router", which is what the guard matches on.
    const dir = mkdtempSync(join(tmpdir(), "9router-daemon-test-"));
    const script = join(dir, "fake-server.js");
    writeFileSync(script, "setInterval(() => {}, 1000);\n");
    const child = cp.spawn(process.execPath, [script], { stdio: "ignore" });
    try {
      expect(isOurServer(child.pid)).toBe(true);
    } finally {
      child.kill("SIGKILL");
    }
  });

  it("reads the command line through CIM on Windows", () => {
    asPlatform("win32");
    // isAlive() is unmocked, so the fake PID has to be a process that exists.
    execSyncImpl = () => "C:\\node.exe C:\\app\\custom-server.js\n";
    expect(isOurServer(process.pid)).toBe(true);
    expect(execSyncCalls[0]).toMatch(/Get-CimInstance Win32_Process -Filter 'ProcessId=\d+'/);

    execSyncImpl = () => "C:\\Windows\\System32\\notepad.exe\n";
    execSyncCalls = [];
    expect(isOurServer(process.pid)).toBe(false);
  });
});

describe("daemon stop", () => {
  it("tears down the whole process group on POSIX (no orphaned children)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "9router-daemon-test-"));
    const script = join(dir, "parent.js");
    const kidFile = join(dir, "child.pid");
    writeFileSync(script, `
      const { spawn } = require("child_process");
      const kid = spawn("sleep", ["30"], { stdio: "ignore" });
      require("fs").writeFileSync(${JSON.stringify(kidFile)}, String(kid.pid));
      process.on("SIGTERM", () => process.exit(0));
      setInterval(() => {}, 1000);
    `);
    // detached:true is what cmdStart does — the server becomes its own group leader.
    const parent = cp.spawn(process.execPath, [script], { stdio: "ignore", detached: true });
    const kid = await waitUntil(() => readPidFile(kidFile) > 0) ? readPidFile(kidFile) : 0;
    expect(kid).toBeGreaterThan(0);

    terminateTree(parent.pid, "SIGTERM");
    expect(await waitUntil(() => !isAlive(parent.pid))).toBe(true);
    expect(await waitUntil(() => !isAlive(kid))).toBe(true);
  });

  it("walks the process tree with taskkill on Windows", () => {
    asPlatform("win32");
    execSyncImpl = () => "";
    terminateTree(4242, "SIGTERM");
    expect(execSyncCalls[0]).toBe("taskkill /T /PID 4242");
    execSyncCalls = [];
    terminateTree(4242, "SIGKILL");
    expect(execSyncCalls[0]).toBe("taskkill /T /F /PID 4242");
  });
});

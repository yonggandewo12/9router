import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fsPromises from "fs/promises";
import * as childProcess from "child_process";
import path from "path";
import { createRequire } from "module";

// Mock next/server
vi.mock("next/server", () => ({
  NextResponse: {
    json: vi.fn((body, init) => ({
      status: init?.status || 200,
      body,
      json: async () => body,
    })),
  },
}));

// Mock os
vi.mock("os", () => ({
  default: { homedir: vi.fn(() => "/mock/home") },
  homedir: vi.fn(() => "/mock/home"),
}));

// Mock fs/promises
vi.mock("fs/promises", () => ({
  access: vi.fn(),
  constants: { R_OK: 4 },
}));

// The route's second extraction strategy shells out to the `sqlite3` CLI, and its
// Linux install check shells out to `which`. A unit test must never spawn real
// processes, so both fail fast; tests that care assert the CLI was consulted.
vi.mock("child_process", () => ({
  execFile: vi.fn((...args) => {
    const callback = args[args.length - 1];
    callback(new Error("child_process is stubbed in tests"));
  }),
}));

// Shared mock db instance
const mockDbInstance = {
  prepare: vi.fn(),
  close: vi.fn(),
  __throwOnConstruct: false,
};

// The route lazily `require`s better-sqlite3 inside the extraction function, which
// `vi.mock` cannot intercept (it is a runtime CJS require, not a static import).
// Priming the CJS require cache for that exact module id is what the route sees.
const nodeRequire = createRequire(import.meta.url);
const BETTER_SQLITE3_ID = nodeRequire.resolve("better-sqlite3");

function installSqliteStub() {
  const previous = nodeRequire.cache[BETTER_SQLITE3_ID];
  function FakeDatabase() {
    if (mockDbInstance.__throwOnConstruct) throw new Error("SQLITE_CANTOPEN");
    return mockDbInstance;
  }
  nodeRequire.cache[BETTER_SQLITE3_ID] = {
    id: BETTER_SQLITE3_ID,
    filename: BETTER_SQLITE3_ID,
    path: path.dirname(BETTER_SQLITE3_ID),
    loaded: true,
    exports: FakeDatabase,
    children: [],
    paths: [],
  };
  return () => {
    if (previous) nodeRequire.cache[BETTER_SQLITE3_ID] = previous;
    else delete nodeRequire.cache[BETTER_SQLITE3_ID];
  };
}

// We need to dynamically import after mocks are registered
let GET;
let uninstallSqliteStub;

const darwinCandidates = () => [
  "/mock/home/Library/Application Support/Cursor/User/globalStorage/state.vscdb",
  "/mock/home/Library/Application Support/Cursor - Insiders/User/globalStorage/state.vscdb",
];
const unixCandidates = () => [
  "/mock/home/.config/Cursor/User/globalStorage/state.vscdb",
  "/mock/home/.config/cursor/User/globalStorage/state.vscdb",
];

// The route queries one key at a time: prepare(sql).get(key).
function stubItemTable(rows) {
  const queried = [];
  mockDbInstance.prepare.mockImplementation(() => ({
    get: (key) => {
      queried.push(key);
      return rows[key] === undefined ? undefined : { value: rows[key] };
    },
  }));
  return queried;
}

describe("GET /api/oauth/cursor/auto-import", () => {
  const originalPlatform = process.platform;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockDbInstance.__throwOnConstruct = false;
    uninstallSqliteStub = installSqliteStub();
    // Force darwin so macOS-specific logic is exercised
    Object.defineProperty(process, "platform", { value: "darwin", writable: true });
    // Re-import to pick up fresh mocks each run
    const mod = await import("../../src/app/api/oauth/cursor/auto-import/route.js");
    GET = mod.GET;
  });

  afterEach(() => {
    uninstallSqliteStub();
    Object.defineProperty(process, "platform", { value: originalPlatform, writable: true });
  });

  // ── macOS path probing ────────────────────────────────────────────────

  it("lists every probed macOS location when none is accessible", async () => {
    vi.mocked(fsPromises.access).mockRejectedValue(new Error("ENOENT"));

    const response = await GET();

    expect(response.body.found).toBe(false);
    expect(response.body.error).toContain("Cursor database not found. Checked locations:");
    for (const candidate of darwinCandidates()) {
      expect(response.body.error).toContain(candidate);
      expect(fsPromises.access).toHaveBeenCalledWith(candidate, 4);
    }
    // Nothing to open → no extraction attempt.
    expect(mockDbInstance.prepare).not.toHaveBeenCalled();
  });

  it("reports the db path for manual paste when the macOS db cannot be opened", async () => {
    vi.mocked(fsPromises.access).mockResolvedValue();
    mockDbInstance.__throwOnConstruct = true;

    const response = await GET();

    // Strategy 1 (better-sqlite3) failed → strategy 2 (CLI) consulted → still no
    // tokens: the endpoint hands the detected path back for manual import rather
    // than failing the request.
    expect(response.status).toBe(200);
    expect(response.body.found).toBe(false);
    expect(response.body.dbPath).toBe(darwinCandidates()[0]);
    expect(response.body.windowsManual).toBe(true);
    expect(childProcess.execFile).toHaveBeenCalled();
  });

  // ── Token extraction ──────────────────────────────────────────────────

  it("extracts tokens using exact keys", async () => {
    vi.mocked(fsPromises.access).mockResolvedValue();
    stubItemTable({
      "cursorAuth/accessToken": "test-token",
      "storage.serviceMachineId": "test-machine-id",
    });

    const response = await GET();

    expect(response.body.found).toBe(true);
    expect(response.body.accessToken).toBe("test-token");
    expect(response.body.machineId).toBe("test-machine-id");
    expect(mockDbInstance.close).toHaveBeenCalled();
    // better-sqlite3 succeeded, so no CLI fallback was needed
    expect(childProcess.execFile).not.toHaveBeenCalled();
  });

  it("unwraps JSON-encoded string values", async () => {
    vi.mocked(fsPromises.access).mockResolvedValue();
    stubItemTable({
      "cursorAuth/accessToken": '"json-token"',
      "storage.serviceMachineId": '"json-machine-id"',
    });

    const response = await GET();

    expect(response.body.found).toBe(true);
    expect(response.body.accessToken).toBe("json-token");
    expect(response.body.machineId).toBe("json-machine-id");
  });

  // ── Alternate key names ───────────────────────────────────────────────

  it("tries the documented alternate key names when the primary keys are absent", async () => {
    vi.mocked(fsPromises.access).mockResolvedValue();
    const queried = stubItemTable({
      "cursorAuth/token": "fallback-token",
      "telemetry.machineId": "fallback-machine",
    });

    const response = await GET();

    expect(response.body.found).toBe(true);
    expect(response.body.accessToken).toBe("fallback-token");
    expect(response.body.machineId).toBe("fallback-machine");
    // primary keys are probed before the alternates
    expect(queried.indexOf("cursorAuth/accessToken")).toBeLessThan(queried.indexOf("cursorAuth/token"));
    expect(queried.indexOf("storage.serviceMachineId")).toBeLessThan(queried.indexOf("telemetry.machineId"));
  });

  it("returns the manual-paste hint when no token key holds a value", async () => {
    vi.mocked(fsPromises.access).mockResolvedValue();
    stubItemTable({});

    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.body.found).toBe(false);
    expect(response.body.windowsManual).toBe(true);
    expect(response.body.dbPath).toBe(darwinCandidates()[0]);
  });

  // ── linux / other unix platforms ──────────────────────────────────────

  it("linux probes both config locations and reports them", async () => {
    Object.defineProperty(process, "platform", { value: "linux", writable: true });
    vi.mocked(fsPromises.access).mockRejectedValue(new Error("ENOENT"));
    mockDbInstance.__throwOnConstruct = true;

    const response = await GET();

    expect(response.body.found).toBe(false);
    expect(response.body.error).toContain("Cursor database not found. Checked locations:");
    // linux no longer uses a single hardcoded path: both candidates are probed.
    for (const candidate of unixCandidates()) {
      expect(response.body.error).toContain(candidate);
    }
    expect(fsPromises.access).toHaveBeenCalledTimes(unixCandidates().length);
  });

  it("linux refuses to import leftover config when Cursor is not installed", async () => {
    Object.defineProperty(process, "platform", { value: "linux", writable: true });
    const candidates = unixCandidates();
    vi.mocked(fsPromises.access).mockImplementation(async (target) => {
      if (target === candidates[0]) return undefined;
      throw new Error("ENOENT");
    });
    stubItemTable({
      "cursorAuth/accessToken": "test-token",
      "storage.serviceMachineId": "test-machine-id",
    });

    const response = await GET();

    // `which cursor` and the .desktop lookup both fail (stubbed child_process).
    expect(response.body.found).toBe(false);
    expect(response.body.error).toContain("does not appear to be installed");
    expect(mockDbInstance.prepare).not.toHaveBeenCalled();
  });

  it("linux imports when the Cursor .desktop entry proves the install", async () => {
    Object.defineProperty(process, "platform", { value: "linux", writable: true });
    const candidates = unixCandidates();
    const desktopFile = "/mock/home/.local/share/applications/cursor.desktop";
    vi.mocked(fsPromises.access).mockImplementation(async (target) => {
      if (target === candidates[0] || target === desktopFile) return undefined;
      throw new Error("ENOENT");
    });
    stubItemTable({
      "cursorAuth/accessToken": "test-token",
      "storage.serviceMachineId": "test-machine-id",
    });

    const response = await GET();

    expect(response.body.found).toBe(true);
    expect(response.body.accessToken).toBe("test-token");
    expect(response.body.machineId).toBe("test-machine-id");
  });

  it("unknown platform falls back to the unix locations", async () => {
    Object.defineProperty(process, "platform", { value: "freebsd", writable: true });
    vi.mocked(fsPromises.access).mockRejectedValue(new Error("ENOENT"));

    const response = await GET();

    // Unknown platforms are treated as unix-like instead of being rejected with 400.
    expect(response.status).toBe(200);
    expect(response.body.found).toBe(false);
    for (const candidate of unixCandidates()) {
      expect(response.body.error).toContain(candidate);
    }
  });
});

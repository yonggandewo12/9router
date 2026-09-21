// Headless server control for the global CLI: `9router-proxy start|stop|status`.
// Spawns the bundled standalone server directly (detached, log to file, PID file),
// bypassing the interactive launcher which always kill-and-starts on launch.
const path = require("path");
const fs = require("fs");
const net = require("net");
const { spawn, execSync } = require("child_process");
const { getDataDir } = require("../utils/dataDir");
const pkg = require("../../../package.json");

const DEFAULT_PORT = 20128;
const DEFAULT_HOST = "0.0.0.0";
const cliRoot = path.join(__dirname, "..", "..", "..");
const standaloneDir = path.join(cliRoot, "app");
const customServerPath = path.join(standaloneDir, "custom-server.js");
const serverPath = fs.existsSync(customServerPath) ? customServerPath : path.join(standaloneDir, "server.js");

const APP_DATA_DIR = getDataDir();
const pidFile = path.join(APP_DATA_DIR, "server.pid");
const logFile = path.join(APP_DATA_DIR, "server.log");

function parseOpts(argv) {
  const opts = { port: DEFAULT_PORT, host: DEFAULT_HOST, help: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--port" || argv[i] === "-p") opts.port = parseInt(argv[i + 1], 10) || DEFAULT_PORT, i++;
    else if (argv[i] === "--host" || argv[i] === "-H") opts.host = argv[i + 1] || DEFAULT_HOST, i++;
    else if (argv[i] === "--help" || argv[i] === "-h") opts.help = true;
  }
  return opts;
}

function readPid() {
  try {
    const pid = parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10);
    return pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

// Guard against PID reuse: the recorded PID must look like our server process.
// Windows has no `ps`; CIM is the only way to read another process' command line,
// and without it a recycled PID would be reported as "running".
function processCommandLine(pid) {
  try {
    if (process.platform === "win32") {
      return execSync(
        `powershell -NoProfile -NonInteractive -WindowStyle Hidden -Command "(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine"`,
        { encoding: "utf8", timeout: 8000, windowsHide: true }
      );
    }
    return execSync(`ps -p ${pid} -o command=`, { encoding: "utf8", timeout: 3000 });
  } catch {
    return "";
  }
}

function isOurServer(pid) {
  if (!isAlive(pid)) return false;
  const cmd = processCommandLine(pid).toLowerCase();
  // If CIM/powershell is unavailable, fall back to the old Windows behaviour: refusing to
  // stop a live server would orphan it, which is worse than a stale-PID false positive.
  if (!cmd) return process.platform === "win32";
  return cmd.includes("server.js") || cmd.includes("next-server") || cmd.includes("9router");
}

function tcpProbe(port, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.setTimeout(timeoutMs);
    socket.on("error", () => { socket.destroy(); resolve(false); });
    socket.on("timeout", () => { socket.destroy(); resolve(false); });
  });
}

async function waitReady(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await tcpProbe(port)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

function tailLog(lines = 20) {
  try {
    return fs.readFileSync(logFile, "utf8").split("\n").filter(Boolean).slice(-lines).join("\n");
  } catch {
    return "(no log output yet)";
  }
}

function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* ignore */ }
}

async function cmdStart(opts) {
  const existing = readPid();
  if (existing && isOurServer(existing)) {
    console.log(`Already running (PID ${existing}, port ${opts.port}). Use \`${pkg.name} stop\` first.`);
    return 0;
  }
  try { fs.unlinkSync(pidFile); } catch { /* stale or absent */ }

  // A live listener we don't own would make the readiness probe below a false positive.
  if (await tcpProbe(opts.port)) {
    console.error(`❌ Port ${opts.port} is already in use by another process. Stop it first or use --port.`);
    return 1;
  }

  if (!fs.existsSync(serverPath)) {
    console.error(`Error: Standalone build not found at ${standaloneDir}.`);
    return 1;
  }

  const { ensureSqliteRuntime, buildEnvWithRuntime } = require("../../../hooks/sqliteRuntime");
  try { ensureSqliteRuntime({ silent: true }); } catch { /* best-effort; server falls back to sql.js */ }
  fs.mkdirSync(APP_DATA_DIR, { recursive: true });
  const fd = fs.openSync(logFile, "a");
  const child = spawn(process.execPath,
    ["--dns-result-order=ipv4first", "--max-old-space-size=6144", serverPath], {
    cwd: standaloneDir,
    detached: true,
    stdio: ["ignore", fd, fd],
    windowsHide: true,
    env: { ...buildEnvWithRuntime(process.env), PORT: String(opts.port), HOSTNAME: opts.host },
  });
  fs.closeSync(fd);
  child.unref();
  fs.writeFileSync(pidFile, String(child.pid));

  const ready = await waitReady(opts.port, 20000);
  if (!ready) {
    console.error(`❌ Server did not come up on port ${opts.port} within 20s. Last log lines:`);
    console.error(tailLog());
    terminateTree(child.pid, "SIGKILL");
    try { fs.unlinkSync(pidFile); } catch { /* ignore */ }
    return 1;
  }
  const displayHost = opts.host === DEFAULT_HOST || opts.host === "0.0.0.0" ? "localhost" : opts.host;
  console.log(`✅ ${pkg.name} v${pkg.version} started (PID ${child.pid})`);
  console.log(`   Dashboard: http://${displayHost}:${opts.port}/dashboard`);
  console.log(`   Logs:      ${logFile}`);
  return 0;
}

function terminateTree(pid, signal) {
  if (process.platform === "win32") {
    // A detached Windows console process can't be sent SIGTERM, so taskkill is the only
    // lever. /T walks the process tree — otherwise the MITM/tunnel children survive us.
    const flags = signal === "SIGKILL" ? "/T /F" : "/T";
    try {
      execSync(`taskkill ${flags} /PID ${pid}`, { stdio: "ignore", windowsHide: true, timeout: 8000 });
    } catch { /* already gone / needs /F */ }
    return;
  }
  // start() spawns detached, so the server is its own process-group leader: signalling
  // -pid tears down its children in one go. Plain pid covers the non-leader case.
  for (const target of [-pid, pid]) {
    try { process.kill(target, signal); } catch { /* not a group leader / already dead */ }
  }
}

function cmdStop() {
  const pid = readPid();
  if (!pid || !isOurServer(pid)) {
    try { fs.unlinkSync(pidFile); } catch { /* ignore */ }
    console.log("Not running.");
    return 0;
  }
  terminateTree(pid, "SIGTERM");
  let deadline = Date.now() + 5000;
  while (Date.now() < deadline && isAlive(pid)) sleepSync(100);
  if (isAlive(pid)) {
    terminateTree(pid, "SIGKILL");
    deadline = Date.now() + 2000;
    while (Date.now() < deadline && isAlive(pid)) sleepSync(100);
  }
  try { fs.unlinkSync(pidFile); } catch { /* ignore */ }
  console.log(`Stopped (PID ${pid}).`);
  return 0;
}

async function cmdStatus(opts) {
  const pid = readPid();
  const pidAlive = pid && isOurServer(pid);
  const portOpen = await tcpProbe(opts.port);
  const displayHost = opts.host === DEFAULT_HOST || opts.host === "0.0.0.0" ? "localhost" : opts.host;

  if (pidAlive) {
    console.log(`Status:   running`);
    console.log(`PID:      ${pid}`);
  } else if (portOpen) {
    console.log(`Status:   running (not tracked by this CLI — started elsewhere)`);
  } else {
    console.log(`Status:   stopped`);
    return 3;
  }
  if (pid && !pidAlive) console.log(`Note:     stale PID file (${pid})`);
  console.log(`Port:     ${opts.port}${portOpen ? " (listening)" : " (not listening)"}`);
  console.log(`Dashboard: http://${displayHost}:${opts.port}/dashboard`);
  console.log(`Version:  ${pkg.version}`);
  return 0;
}

const HELP = `Usage: ${pkg.name} <command> [options]

Commands:
  start    Start the server in the background
  stop     Stop the background server
  status   Show whether the server is running

Options:
  -p, --port <port>   Port (default: ${DEFAULT_PORT})
  -H, --host <host>   Host to bind (default: ${DEFAULT_HOST})
  -h, --help          Show this help
`;

async function runDaemon(verb, argv) {
  const opts = parseOpts(argv);
  if (opts.help) {
    console.log(HELP);
    return 0;
  }
  if (verb === "start") return cmdStart(opts);
  if (verb === "stop") return cmdStop();
  return cmdStatus(opts);
}

module.exports = { runDaemon, __test__: { parseOpts, pidFile, logFile, isOurServer, terminateTree, processCommandLine } };

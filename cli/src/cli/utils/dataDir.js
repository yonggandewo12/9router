const fs = require("fs");
const path = require("path");
const os = require("os");

const APP_NAME = "9router";

function defaultDir() {
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), APP_NAME);
  }
  return path.join(os.homedir(), `.${APP_NAME}`);
}

/**
 * Resolve the writable data directory. Mirrors src/lib/dataDir.js (app side) —
 * keep both in sync; the CLI cannot import ESM from the Next app bundle.
 */
function getDataDir() {
  const configured = process.env.DATA_DIR;
  if (!configured) return defaultDir();

  // A Unix-style DATA_DIR from a Linux/Docker .env is meaningless on Windows.
  if (process.platform === "win32" && /^\//.test(configured)) {
    console.warn(`[DATA_DIR] '${configured}' is a Unix path on Windows → fallback to default`);
    return defaultDir();
  }

  try {
    fs.mkdirSync(configured, { recursive: true });
    return configured;
  } catch (e) {
    // Unlike the app-side copy this never throws: the CLI also runs from
    // postinstall, where failing the whole npm install over a bad DATA_DIR
    // would be far worse than falling back.
    console.warn(`[DATA_DIR] '${configured}' unusable (${e?.code || e}) → fallback ~/${APP_NAME}`);
    return defaultDir();
  }
}

const DATA_DIR = getDataDir();

module.exports = { APP_NAME, DATA_DIR, getDataDir };

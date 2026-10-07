/**
 * efficiency-baseline.mjs — read-only ruler over the local usage DB.
 *
 * Reports, per provider: cache-read / cache-write / full-price input share,
 * cost, and (when observability request details exist) the split between local
 * PREP work and upstream TTFT. Nothing is written; the DB is opened read-only.
 *
 *   node scripts/efficiency-baseline.mjs [--days 7] [--provider codex] [--json]
 *
 * Requires the server to have been used normally (usageHistory rows are written
 * per request). WAL frames the running server has not checkpointed yet may be
 * invisible to a read-only connection — numbers are a snapshot, not an audit.
 */
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function dbFile() {
  const dir = process.env.DATA_DIR || path.join(os.homedir(), ".9router");
  return path.join(dir, "db", "data.sqlite");
}

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = process.argv[i + 1];
  return next && !next.startsWith("--") ? next : true;
}

const FILE = dbFile();
if (!fs.existsSync(FILE)) {
  console.error(`no database at ${FILE} — set DATA_DIR or use the proxy first`);
  process.exit(1);
}

const days = Number(arg("days", "7")) || 7;
const providerFilter = typeof arg("provider", "") === "string" ? arg("provider", "") : "";
const asJson = Boolean(arg("json", false));
const since = new Date(Date.now() - days * 86400_000).toISOString();

const db = new DatabaseSync(FILE, { readOnly: true });
try {
  const where = "WHERE timestamp >= ?" + (providerFilter ? " AND provider = ?" : "");
  const params = providerFilter ? [since, providerFilter] : [since];

  const rows = db.prepare(`
    SELECT provider, model, timestamp, promptTokens, completionTokens, cost, tokens
    FROM usageHistory ${where}
    ORDER BY timestamp DESC
    LIMIT 20000
  `).all(...params);

  const perProvider = new Map();
  for (const row of rows) {
    let t = {};
    try { t = row.tokens ? JSON.parse(row.tokens) : {}; } catch { t = {}; }
    const prompt = Number(t.prompt_tokens ?? t.input_tokens ?? row.promptTokens ?? 0);
    const read = Number(t.cached_tokens ?? t.cache_read_input_tokens ?? 0);
    const write = Number(t.cache_creation_input_tokens ?? t.prompt_tokens_details?.cache_creation_tokens ?? 0);
    // A provider that never reports cache fields gives no share signal at all —
    // keep them in a separate bucket so the average isn't silently diluted.
    const reportsCache = t.cached_tokens !== undefined || t.cache_creation_input_tokens !== undefined ||
      t.cache_read_input_tokens !== undefined || t.prompt_tokens_details?.cached_tokens !== undefined;
    const key = row.provider || "(unknown)";
    const acc = perProvider.get(key) || {
      provider: key, requests: 0, withCacheReport: 0, prompt: 0, read: 0, write: 0,
      full: 0, completion: 0, cost: 0, models: new Set(),
    };
    acc.requests++;
    if (reportsCache) acc.withCacheReport++;
    acc.prompt += prompt;
    acc.read += read;
    acc.write += write;
    acc.full += Math.max(0, prompt - read - write);
    acc.completion += Number(t.completion_tokens ?? row.completionTokens ?? 0);
    acc.cost += Number(row.cost || 0);
    if (row.model) acc.models.add(row.model);
    perProvider.set(key, acc);
  }

  // Latency segments live in requestDetails only (observability, capped records)
  const seg = new Map();
  if (fs.existsSync(FILE)) {
    let details = [];
    try {
      details = db.prepare(`SELECT provider, data FROM requestDetails WHERE timestamp >= ? ORDER BY timestamp DESC LIMIT 5000`).all(since);
    } catch {
      details = [];
    }
    for (const d of details) {
      let obj = {};
      try { obj = JSON.parse(d.data || "{}"); } catch { continue; }
      const l = obj.latency || {};
      if (!Number.isFinite(l.total)) continue;
      const key = d.provider || "(unknown)";
      const acc = seg.get(key) || { provider: key, total: [], ttft: [], prep: [], media: [], translate: [], savers: [] };
      acc.total.push(l.total);
      if (Number.isFinite(l.ttft) && l.ttft > 0) acc.ttft.push(l.ttft);
      for (const k of ["prep", "media", "translate", "savers"]) {
        if (Number.isFinite(l[k])) acc[k].push(l[k]);
      }
      seg.set(key, acc);
    }
  }

  const pct = (v, of) => (of > 0 ? (v / of) * 100 : 0);
  const p = (n) => Number(n.toFixed(1));
  const list = [...perProvider.values()].sort((a, b) => b.cost - a.cost);
  const totals = list.reduce((a, x) => ({
    requests: a.requests + x.requests, prompt: a.prompt + x.prompt, read: a.read + x.read,
    write: a.write + x.write, full: a.full + x.full, cost: a.cost + x.cost,
  }), { requests: 0, prompt: 0, read: 0, write: 0, full: 0, cost: 0 });

  if (asJson) {
    console.log(JSON.stringify({
      windowDays: days, dbFile: FILE, totals: { ...totals, readPct: p(pct(totals.read, totals.prompt)) },
      providers: list.map((x) => ({ ...x, models: [...x.models], readPct: p(pct(x.read, x.prompt)) })),
      latency: [...seg.values()].map((x) => ({ provider: x.provider, samples: x.total.length, p50: percentile(x.total, .5), p95: percentile(x.total, .95), ttftP50: percentile(x.ttft, .5), prepP50: percentile(x.prep, .5) })),
    }, null, 2));
    process.exit(0);
  }

  const w = (s, n) => String(s).padStart(n);
  console.log(`usage baseline · last ${days}d · ${FILE} · ${totals.requests} requests`);
  console.log("");
  console.log(["provider".padEnd(18), w("req", 6), w("in", 10), w("↻read%", 8), w("+write", 10), w("full", 10), w("cost$", 9), w("cache?", 7)].join(" "));
  for (const x of list) {
    console.log([
      x.provider.padEnd(18),
      w(x.requests, 6),
      w(x.prompt, 10),
      w(p(pct(x.read, x.prompt)) + "%", 8),
      w(x.write, 10),
      w(x.full, 10),
      w(x.cost.toFixed(4), 9),
      w(`${x.withCacheReport}/${x.requests}`, 7),
    ].join(" "));
  }
  console.log("-".repeat(62));
  console.log([
    "TOTAL",
    w(totals.requests, 6),
    w(totals.prompt, 10),
    w(p(pct(totals.read, totals.prompt)) + "%", 8),
    w(totals.write, 10),
    w(totals.full, 10),
    w(totals.cost.toFixed(4), 9),
  ].join(" "));

  const anyLatency = [...seg.values()].some((x) => x.prep.length > 0);
  if (anyLatency) {
    console.log("");
    console.log(`latency (requestDetails samples, capped retention) — PREP = local work before dispatch, TTFT = from request start`);
    console.log(["provider".padEnd(18), w("n", 6), w("totalP50", 9), w("totalP95", 9), w("ttftP50", 8), w("prepP50", 8), w("media", 7), w("translate", 10), w("savers", 7)].join(" "));
    for (const x of [...seg.values()].sort((a, b) => b.total.length - a.total.length)) {
      if (!x.prep.length) continue;
      console.log([
        x.provider.padEnd(18), w(x.total.length, 6),
        w(percentile(x.total, .5), 9), w(percentile(x.total, .95), 9),
        w(percentile(x.ttft, .5), 8), w(percentile(x.prep, .5), 8),
        w(percentile(x.media, .5), 7), w(percentile(x.translate, .5), 10), w(percentile(x.savers, .5), 7),
      ].join(" "));
    }
  } else {
    console.log("");
    console.log("no PREP segment data yet — it starts being recorded with this build (needs enableObservability + requests made after it)");
  }
} finally {
  db.close();
}

function percentile(values, q) {
  if (!values.length) return "-";
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * q));
  return Math.round(sorted[idx]);
}

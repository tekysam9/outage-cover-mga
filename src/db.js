import { DatabaseSync } from "node:sqlite";
import { DEFAULT_TIERS } from "./engine.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL,
  pw_hash TEXT NOT NULL, merchant_id INTEGER, partner_id INTEGER, active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS merchants(
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, bank_verified INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS partners(
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, channel TEXT NOT NULL, rate REAL NOT NULL, api_key_hash TEXT UNIQUE);
CREATE TABLE IF NOT EXISTS states(
  code TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL, note TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS rates(
  id INTEGER PRIMARY KEY, version TEXT UNIQUE NOT NULL, base REAL NOT NULL, wait_h REAL NOT NULL,
  max_limit_cents INTEGER NOT NULL, share REAL NOT NULL, tiers TEXT NOT NULL, effective_at INTEGER NOT NULL,
  proposed_by INTEGER, approved_by INTEGER);
CREATE TABLE IF NOT EXISTS rate_proposals(
  id INTEGER PRIMARY KEY, base REAL NOT NULL, wait_h REAL NOT NULL, max_limit_cents INTEGER NOT NULL,
  status TEXT NOT NULL, proposed_by INTEGER NOT NULL, decided_by INTEGER, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS quotes(
  id TEXT PRIMARY KEY, merchant_id INTEGER NOT NULL, partner_id INTEGER, created_by INTEGER NOT NULL,
  store TEXT NOT NULL, opts TEXT NOT NULL, limit_cents INTEGER NOT NULL, premium_cents INTEGER NOT NULL,
  score INTEGER NOT NULL, route TEXT NOT NULL, reasons TEXT NOT NULL, snap TEXT NOT NULL,
  status TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS policies(
  id TEXT PRIMARY KEY, merchant_id INTEGER NOT NULL, partner_id INTEGER, quote_id TEXT NOT NULL,
  store TEXT NOT NULL, zip TEXT NOT NULL, state TEXT NOT NULL, limit_cents INTEGER NOT NULL,
  premium_cents INTEGER NOT NULL, score INTEGER NOT NULL, bound_at INTEGER NOT NULL, snap TEXT NOT NULL,
  sensor INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active', commission_cents INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS policies_zip ON policies(zip);
CREATE TABLE IF NOT EXISTS referrals(
  id TEXT PRIMARY KEY, quote_id TEXT NOT NULL, status TEXT NOT NULL, decided_by INTEGER,
  created_at INTEGER NOT NULL, decided_at INTEGER);
CREATE TABLE IF NOT EXISTS outage_events(
  id TEXT PRIMARY KEY, external_id TEXT UNIQUE, zip TEXT NOT NULL, start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL,
  source_count INTEGER NOT NULL, sensor_mode TEXT NOT NULL DEFAULT 'agree', created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS readings(
  id INTEGER PRIMARY KEY, event_id TEXT NOT NULL, source TEXT NOT NULL, zip TEXT NOT NULL,
  start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL, policy_id TEXT, received_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS decisions(
  id TEXT PRIMARY KEY, policy_id TEXT NOT NULL, event_id TEXT NOT NULL, inputs TEXT NOT NULL, result TEXT NOT NULL,
  rule TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(policy_id, event_id));
CREATE TABLE IF NOT EXISTS reviews(
  id TEXT PRIMARY KEY, policy_id TEXT NOT NULL, decision_id TEXT NOT NULL, status TEXT NOT NULL,
  decided_by INTEGER, created_at INTEGER NOT NULL, decided_at INTEGER);
CREATE TABLE IF NOT EXISTS payouts(
  id TEXT PRIMARY KEY, policy_id TEXT NOT NULL, merchant_id INTEGER NOT NULL, decision_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL, approved INTEGER NOT NULL DEFAULT 0, approved_by INTEGER,
  paid_at INTEGER, provider_ref TEXT, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS notices(
  id INTEGER PRIMARY KEY, merchant_id INTEGER NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS audit(
  seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, actor TEXT NOT NULL, type TEXT NOT NULL,
  detail TEXT NOT NULL, version TEXT NOT NULL DEFAULT '', prev_hash TEXT NOT NULL, hash TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS counters(prefix TEXT PRIMARY KEY, n INTEGER NOT NULL);
`;

export const STATE_SEED = [
  ["TX", "Texas", "open", "First launch state; issues many MGA licenses, MGA exam required"],
  ["FL", "Florida", "pending", "Later, pending counsel; separate pre-licensing and high scrutiny"],
  ["NY", "New York", "pending", "Later, pending counsel; parametric law signed December 2024"],
  ["CA", "California", "closed", "No carrier presence confirmed; not planned yet"],
];

export function openDb(path = ":memory:") {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  const has = db.prepare("SELECT COUNT(*) AS n FROM rates").get().n;
  if (!has) {
    db.prepare(
      "INSERT INTO rates(version,base,wait_h,max_limit_cents,share,tiers,effective_at) VALUES(?,?,?,?,?,?,?)"
    ).run("rates-v1", 0.03, 24, 5_000_000, 0.5, JSON.stringify(DEFAULT_TIERS), 0);
  }
  const ins = db.prepare("INSERT OR IGNORE INTO states(code,name,status,note) VALUES(?,?,?,?)");
  for (const s of STATE_SEED) ins.run(...s);
  return db;
}

export function tx(db, fn) {
  db.exec("BEGIN");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export function nextId(db, prefix, start = 1000) {
  const row = db.prepare("SELECT n FROM counters WHERE prefix=?").get(prefix);
  const n = row ? row.n + 1 : start + 1;
  db.prepare("INSERT INTO counters(prefix,n) VALUES(?,?) ON CONFLICT(prefix) DO UPDATE SET n=excluded.n").run(prefix, n);
  return `${prefix}-${n}`;
}

export const getSetting = (db, key, dflt = null) => db.prepare("SELECT value FROM settings WHERE key=?").get(key)?.value ?? dflt;
export const setSetting = (db, key, value) =>
  db.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, String(value));

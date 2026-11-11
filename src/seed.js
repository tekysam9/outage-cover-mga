import { hashPassword } from "./auth.js";
import { CHANNELS } from "./engine.js";
import { sha256 } from "./auth.js";

export const DEMO_PASSWORD = "demo-password-1";

/** Seed demo users and partners. Safe to call twice. */
export function seedDemo(db, now = Date.now()) {
  if (db.prepare("SELECT COUNT(*) n FROM users").get().n > 0) return;
  const m = Number(db.prepare("INSERT INTO merchants(name,created_at) VALUES(?,?)").run("Sunrise Market", now).lastInsertRowid);
  const pid = Number(db.prepare("INSERT INTO partners(name,channel,rate,api_key_hash) VALUES(?,?,?,?)").run("Lone Star Independent Agency", "agent", CHANNELS.agent.rate, sha256("pk_demo_partner_key")).lastInsertRowid);
  const add = (email, name, role, mid = null, partner = null) =>
    db.prepare("INSERT INTO users(email,name,role,pw_hash,merchant_id,partner_id) VALUES(?,?,?,?,?,?)").run(email, name, role, hashPassword(DEMO_PASSWORD), mid, partner);
  add("merchant@demo.test", "Maya Reyes", "merchant", m);
  add("agent@demo.test", "Sam Whitfield", "agent", null, pid);
  add("uw1@demo.test", "Una Underwood", "underwriting");
  add("uw2@demo.test", "Uri Underhill", "underwriting");
  add("ops@demo.test", "Omar Ops", "ops");
  add("auditor@demo.test", "Ada Auditor", "auditor");
  add("admin@demo.test", "Alex Admin", "admin");
}

export function bootstrapAdmin(db, email, password) {
  if (!email || !password) return false;
  if (db.prepare("SELECT 1 FROM users WHERE role='admin'").get()) return false;
  db.prepare("INSERT INTO users(email,name,role,pw_hash) VALUES(?,?,?,?)").run(email.toLowerCase(), "Administrator", "admin", hashPassword(password));
  return true;
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file://").href) {
  const { openDb } = await import("./db.js");
  const db = openDb(process.env.DB_PATH || "data/outage.db");
  seedDemo(db);
  console.log("Seeded demo users (password: " + DEMO_PASSWORD + ")");
}

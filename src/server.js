import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { openDb } from "./db.js";
import { mockProvider } from "./payments.js";
import { createApp } from "./app.js";
import { bootstrapAdmin, seedDemo } from "./seed.js";

const demo = process.env.DEMO === "1";
// Keep data outside the app folder by default so redeploys do not wipe it.
function pickDbPath() {
  if (process.env.DB_PATH) return process.env.DB_PATH;
  if (demo) return ":memory:";
  const candidates = [process.env.HOME && path.join(process.env.HOME, "outage-cover-data", "outage.db"), path.join(process.cwd(), "data", "outage.db"), path.join(os.tmpdir(), "outage-cover", "outage.db")].filter(Boolean);
  for (const c of candidates) {
    try { fs.mkdirSync(path.dirname(c), { recursive: true }); fs.accessSync(path.dirname(c), fs.constants.W_OK); return c; } catch { /* try next */ }
  }
  throw new Error("No writable location for the database. Set DB_PATH.");
}
const dbPath = pickDbPath();
console.log("Database:", dbPath);
const db = openDb(dbPath);
if (demo) seedDemo(db);
if (bootstrapAdmin(db, process.env.ADMIN_EMAIL, process.env.ADMIN_PASSWORD)) console.log("Admin account created from ADMIN_EMAIL.");

const secret = process.env.SESSION_SECRET || (demo ? crypto.randomBytes(32).toString("hex") : null);
if (!secret) { console.error("SESSION_SECRET is required outside demo mode."); process.exit(1); }

const { server } = createApp({
  db, payments: mockProvider(),
  config: { demo, secret, feedKey: process.env.FEED_KEY || (demo ? "demo-feed-key" : null), secureCookie: process.env.SECURE_COOKIE === "1" },
});
const port = Number(process.env.PORT || 3000);
process.on("uncaughtException", (e) => { console.error("Fatal:", e); process.exit(1); });
server.listen(port, () => console.log(`Outage Cover listening on http://localhost:${port} (${demo ? "demo" : "production"} mode)`));

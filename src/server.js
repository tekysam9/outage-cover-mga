import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { openDb } from "./db.js";
import { mockProvider } from "./payments.js";
import { createApp } from "./app.js";
import { bootstrapAdmin, seedDemo } from "./seed.js";

const demo = process.env.DEMO === "1";
const dbPath = process.env.DB_PATH || (demo ? ":memory:" : "data/outage.db");
if (dbPath !== ":memory:") fs.mkdirSync(path.dirname(dbPath), { recursive: true });
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
server.listen(port, () => console.log(`Outage Cover listening on http://localhost:${port} (${demo ? "demo" : "production"} mode)`));

import { openDb } from "../src/db.js";
import { seedDemo, DEMO_PASSWORD } from "../src/seed.js";

const db = openDb(process.env.DB_PATH || "data/outage.db");
seedDemo(db);
console.log("Seeded demo users (password: " + DEMO_PASSWORD + ")");

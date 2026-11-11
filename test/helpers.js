import { openDb } from "../src/db.js";
import { mockProvider } from "../src/payments.js";
import { createApp } from "../src/app.js";
import { seedDemo, DEMO_PASSWORD } from "../src/seed.js";
import { riskScore } from "../src/engine.js";

export const PW = DEMO_PASSWORD;
export function findZip(pred) {
  for (let z = 75001; z < 79999; z++) if (pred(riskScore(String(z)))) return String(z);
}
export const LOW_ZIP = findZip((s) => s <= 60);
export const HIGH_ZIP = findZip((s) => s > 70);

export async function boot(config = {}) {
  const db = openDb();
  seedDemo(db);
  const payments = mockProvider();
  const { server, svc } = createApp({ db, payments, config: { demo: true, secret: "test-secret", feedKey: "feed-k", ...config } });
  await new Promise((r) => server.listen(0, r));
  const base = `http://localhost:${server.address().port}`;
  return { db, payments, svc, base, close: () => { server.closeAllConnections(); server.close(); }, client: (email) => new Client(base, email) };
}

export class Client {
  constructor(base, email) { this.base = base; this.email = email; this.cookie = ""; this.csrf = null; }
  async login(password = PW) {
    const r = await fetch(this.base + "/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: this.email, password }) });
    const body = await r.json();
    if (r.ok) { this.cookie = r.headers.get("set-cookie").split(";")[0]; this.csrf = body.csrf; }
    return { status: r.status, body };
  }
  async call(method, path, body, headers = {}) {
    const h = { "content-type": "application/json", cookie: this.cookie, ...headers };
    if (method !== "GET" && this.csrf && !("x-csrf-token" in headers)) h["x-csrf-token"] = this.csrf;
    const r = await fetch(this.base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: r.status, body: data, headers: r.headers };
  }
  get(p) { return this.call("GET", p); }
  post(p, b = {}) { return this.call("POST", p, b); }
}

export const store = (zip, over = {}) => ({ name: "Corner Fresh", type: "grocery", state: "TX", zip, utility: "Oncor", inventoryCents: 8_000_000, ...over });

import test from "node:test";
import assert from "node:assert/strict";
import { boot, store, LOW_ZIP, HIGH_ZIP, PW } from "./helpers.js";

async function setup() {
  const t = await boot();
  const c = {};
  for (const k of ["merchant", "agent", "uw1", "uw2", "ops", "auditor", "admin"]) { c[k] = t.client(`${k}@demo.test`); assert.equal((await c[k].login()).status, 200); }
  return { ...t, c };
}

test("auth: bad password, throttle, anonymous blocked", async () => {
  const t = await boot();
  const bad = t.client("merchant@demo.test");
  assert.equal((await bad.login("wrong-password")).status, 401);
  for (let i = 0; i < 5; i++) await bad.login("wrong-password");
  assert.equal((await bad.login(PW)).status, 429);
  const anon = t.client("x");
  assert.equal((await anon.get("/api/policies")).status, 401);
  t.close();
});

test("csrf is required for cookie sessions", async () => {
  const t = await setup();
  const r = await t.c.merchant.call("POST", "/api/quotes", { store: store(LOW_ZIP) }, { "x-csrf-token": "nope" });
  assert.equal(r.status, 403);
  t.close();
});

test("role boundaries", async () => {
  const t = await setup();
  assert.equal((await t.c.merchant.get("/api/audit")).status, 403);
  assert.equal((await t.c.merchant.get("/api/admin/users")).status, 403);
  assert.equal((await t.c.agent.get("/api/summary")).status, 403);
  assert.equal((await t.c.ops.get("/api/admin/users")).status, 403);
  assert.equal((await t.c.auditor.post("/api/admin/advance-clock", { hours: 1 })).status, 403);
  assert.equal((await t.c.admin.get("/api/admin/users")).status, 200);
  t.close();
});

test("quote validation errors are 400", async () => {
  const t = await setup();
  const r = await t.c.merchant.post("/api/quotes", { store: { ...store(LOW_ZIP), zip: "12" } });
  assert.equal(r.status, 400);
  t.close();
});

test("full lifecycle: quote, bind, outage, hold for bank, pay, audit chain, replay", async () => {
  const t = await setup();
  const q = await t.c.merchant.post("/api/quotes", { store: store(LOW_ZIP), style: "tiered", sensor: false });
  assert.equal(q.status, 200); assert.equal(q.body.route, "auto");
  assert.match(q.body.sentence, /You pay \$/);
  const pol = await t.c.merchant.post(`/api/quotes/${q.body.id}/bind`);
  assert.equal(pol.status, 200);
  // double bind refused
  assert.equal((await t.c.merchant.post(`/api/quotes/${q.body.id}/bind`)).status, 409);

  // Outage during waiting period: no trigger
  let sim = await t.c.ops.post("/api/admin/simulate-outage", { zip: LOW_ZIP, durationH: 10 });
  assert.equal(sim.body.decisions[0].result, "no-trigger");

  await t.c.ops.post("/api/admin/advance-clock", { hours: 30 });
  sim = await t.c.ops.post("/api/admin/simulate-outage", { zip: LOW_ZIP, durationH: 10 });
  assert.equal(sim.status, 200);
  assert.equal(sim.body.decisions[0].result, "trigger");
  let payouts = (await t.c.merchant.get("/api/payouts")).body;
  assert.equal(payouts.length, 1);
  assert.equal(payouts[0].status, "hold-bank"); // first payout held until bank verified
  assert.equal(t.payments.list().length, 0);

  assert.equal((await t.c.merchant.post("/api/bank/verify")).status, 200);
  payouts = (await t.c.merchant.get("/api/payouts")).body;
  assert.equal(payouts[0].status, "paid");
  assert.equal(t.payments.list().length, 1);
  assert.equal(payouts[0].amountCents, 2_000_000 * 0.5);

  // other merchant data not visible
  const audit = (await t.c.auditor.get("/api/audit/verify")).body;
  assert.equal(audit.ok, true);
  const decisions = (await t.c.auditor.get("/api/decisions")).body;
  const rep = (await t.c.auditor.get(`/api/decisions/${decisions.find((d) => d.result === "trigger").id}/replay`)).body;
  assert.equal(rep.matches, true);
  t.close();
});

test("tampering with the audit log is detected", async () => {
  const t = await setup();
  await t.c.merchant.post("/api/quotes", { store: store(LOW_ZIP) });
  t.db.prepare("UPDATE audit SET detail='edited' WHERE seq=1").run();
  assert.equal((await t.c.auditor.get("/api/audit/verify")).body.ok, false);
  t.close();
});

test("duplicate outage events never pay twice", async () => {
  const t = await setup();
  const q = await t.c.merchant.post("/api/quotes", { store: store(LOW_ZIP) });
  await t.c.merchant.post(`/api/quotes/${q.body.id}/bind`);
  await t.c.merchant.post("/api/bank/verify");
  await t.c.ops.post("/api/admin/advance-clock", { hours: 30 });
  const now = t.svc.T();
  const ev = { externalId: "utility-123", zip: LOW_ZIP, start: now - 12 * 3600_000, end: now - 3600_000, readings: [{ source: "A", start: now - 12 * 3600_000, end: now - 3600_000 }, { source: "B", start: now - 12 * 3600_000, end: now - 3600_000 }] };
  const post = (k) => fetch(t.base + "/api/feed/outages", { method: "POST", headers: { "content-type": "application/json", "x-feed-key": k }, body: JSON.stringify(ev) });
  assert.equal((await post("wrong")).status, 401);
  const a = await (await post("feed-k")).json();
  const b = await (await post("feed-k")).json();
  assert.equal(a.decisions[0].result, "trigger");
  assert.equal(b.duplicate, true);
  assert.equal(b.decisions[0].result, "duplicate");
  assert.equal(t.payments.list().length, 1);
  t.close();
});

test("single-source and disagreement go to human review, then pay at conservative reading", async () => {
  const t = await setup();
  const q = await t.c.merchant.post("/api/quotes", { store: store(LOW_ZIP) });
  await t.c.merchant.post(`/api/quotes/${q.body.id}/bind`);
  await t.c.merchant.post("/api/bank/verify");
  await t.c.ops.post("/api/admin/advance-clock", { hours: 30 });
  await t.c.admin.post("/api/admin/feeds/B", { online: false });
  const sim = await t.c.ops.post("/api/admin/simulate-outage", { zip: LOW_ZIP, durationH: 10 });
  assert.equal(sim.body.decisions[0].result, "review");
  const reviews = (await t.c.ops.get("/api/reviews")).body;
  assert.equal(reviews.length, 1);
  assert.equal(t.payments.list().length, 0);
  const paid = await t.c.ops.post(`/api/reviews/${reviews[0].id}/pay`);
  assert.equal(paid.status, 200);
  assert.equal(t.payments.list().length, 1);
  assert.equal((await t.c.ops.post(`/api/reviews/${reviews[0].id}/pay`)).status, 409);
  t.close();
});

test("referral: high-risk ZIP needs underwriting approval", async () => {
  const t = await setup();
  const q = await t.c.merchant.post("/api/quotes", { store: store(HIGH_ZIP) });
  assert.equal(q.body.route, "refer");
  assert.equal((await t.c.merchant.post(`/api/quotes/${q.body.id}/bind`)).status, 409);
  const ref = await t.c.merchant.post(`/api/quotes/${q.body.id}/refer`);
  assert.equal(ref.status, 200);
  assert.equal((await t.c.merchant.post(`/api/referrals/${ref.body.id}/approve`)).status, 403);
  const ok = await t.c.uw1.post(`/api/referrals/${ref.body.id}/approve`);
  assert.equal(ok.status, 200); assert.ok(ok.body.policyId);
  t.close();
});

test("closed state declines, pending state waitlists, cannot bind", async () => {
  const t = await setup();
  const q = await t.c.merchant.post("/api/quotes", { store: store(LOW_ZIP, { state: "CA" }) });
  assert.equal(q.body.route, "decline");
  assert.equal((await t.c.merchant.post(`/api/quotes/${q.body.id}/bind`)).status, 409);
  const w = await t.c.merchant.post("/api/quotes", { store: store(LOW_ZIP, { state: "FL" }) });
  assert.equal(w.body.route, "waitlist");
  t.close();
});

test("rate change needs a second, different approver", async () => {
  const t = await setup();
  const p = await t.c.uw1.post("/api/rates/proposals", { base: 0.04, waitH: 24, maxLimitCents: 5_000_000 });
  assert.equal(p.status, 200);
  assert.equal((await t.c.uw1.post(`/api/rates/proposals/${p.body.id}/approve`)).status, 403);
  const ok = await t.c.uw2.post(`/api/rates/proposals/${p.body.id}/approve`);
  assert.equal(ok.body.version, "rates-v2");
  assert.equal((await t.c.merchant.get("/api/rates")).body.current.base, 0.04);
  t.close();
});

test("existing policies keep their rate version after a rate change", async () => {
  const t = await setup();
  const q = await t.c.merchant.post("/api/quotes", { store: store(LOW_ZIP) });
  await t.c.merchant.post(`/api/quotes/${q.body.id}/bind`);
  const p = await t.c.uw1.post("/api/rates/proposals", { base: 0.05, waitH: 24, maxLimitCents: 5_000_000 });
  await t.c.uw2.post(`/api/rates/proposals/${p.body.id}/approve`);
  const pol = (await t.c.merchant.get("/api/policies")).body[0];
  assert.equal(pol.snap.rateVersion, "rates-v1");
  t.close();
});

test("partner: Bearer key quotes, binds, earns 12% commission", async () => {
  const t = await setup();
  const h = { authorization: "Bearer pk_demo_partner_key", "content-type": "application/json" };
  const qr = await fetch(t.base + "/api/quotes", { method: "POST", headers: h, body: JSON.stringify({ store: store(LOW_ZIP, { name: "Partner Client" }) }) });
  const q = await qr.json();
  assert.equal(qr.status, 200);
  const br = await fetch(t.base + `/api/quotes/${q.id}/bind`, { method: "POST", headers: h, body: "{}" });
  assert.equal(br.status, 200);
  const com = (await t.c.agent.get("/api/partner/commissions")).body;
  assert.equal(com.policies, 1);
  assert.equal(com.commissionCents, Math.round(q.premiumCents * 0.12));
  assert.equal((await fetch(t.base + "/api/policies", { headers: { authorization: "Bearer bad" } })).status, 401);
  t.close();
});

test("payout above $15,000 needs approval", async () => {
  const t = await setup();
  const q = await t.c.merchant.post("/api/quotes", { store: store(LOW_ZIP, { inventoryCents: 10_000_000 }) });
  await t.c.merchant.post(`/api/quotes/${q.body.id}/bind`);
  await t.c.merchant.post("/api/bank/verify");
  await t.c.ops.post("/api/admin/advance-clock", { hours: 60 });
  await t.c.ops.post("/api/admin/simulate-outage", { zip: LOW_ZIP, durationH: 40 });
  let po = (await t.c.ops.get("/api/payouts")).body[0];
  assert.equal(po.amountCents, 5_000_000);
  assert.equal(po.status, "needs-approval");
  await t.c.ops.post(`/api/payouts/${po.id}/approve`);
  po = (await t.c.ops.get("/api/payouts")).body[0];
  assert.equal(po.status, "paid");
  t.close();
});

test("bordereau CSV and summary", async () => {
  const t = await setup();
  const q = await t.c.merchant.post("/api/quotes", { store: store(LOW_ZIP) });
  await t.c.merchant.post(`/api/quotes/${q.body.id}/bind`);
  const csv = await t.c.ops.get("/api/bordereau.csv");
  assert.match(csv.body, /^policy,merchant,state,zip/);
  assert.match(csv.body, /Sunrise Market/);
  const s = (await t.c.ops.get("/api/summary")).body;
  assert.equal(s.policies, 1);
  t.close();
});

test("self-registration creates a merchant who can quote", async () => {
  const t = await boot();
  const anon = t.client("new@shop.test");
  const r = await anon.post("/api/register", { email: "new@shop.test", name: "New Owner", password: "a-long-password", businessName: "New Shop" });
  assert.equal(r.status, 200);
  assert.equal((await anon.post("/api/register", { email: "new@shop.test", name: "x", password: "a-long-password", businessName: "Dup" })).status, 409);
  assert.equal((await anon.post("/api/register", { email: "weak@shop.test", name: "x", password: "short", businessName: "W" })).status, 400);
  assert.equal((await anon.login("a-long-password")).status, 200);
  assert.equal((await anon.post("/api/quotes", { store: store(LOW_ZIP, { name: undefined }) })).status, 200);
  t.close();
});

test("static site and portal are served, traversal blocked", async () => {
  const t = await boot();
  assert.equal((await fetch(t.base + "/")).status, 200);
  assert.equal((await fetch(t.base + "/app/")).status, 200);
  assert.equal((await fetch(t.base + "/app/..%2f..%2fpackage.json")).status, 404);
  assert.equal((await fetch(t.base + "/nope")).status, 404);
  t.close();
});

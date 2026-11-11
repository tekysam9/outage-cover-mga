import test from "node:test";
import assert from "node:assert/strict";
import { evaluate, priceQuote, payoutStatus, validateStore, commissionCents, DEFAULT_TIERS, HOUR } from "../src/engine.js";
import { LOW_ZIP, HIGH_ZIP, store } from "./helpers.js";

const rates = { version: "rates-v1", base: 0.03, waitH: 24, maxLimitCents: 5_000_000, share: 0.5, tiers: DEFAULT_TIERS };
const ctx = { stateStatus: "open", stateName: "Texas", areaLimitCents: 0 };

test("limit is 50% of inventory capped at $50,000", () => {
  assert.equal(priceQuote(store(LOW_ZIP, { inventoryCents: 4_000_000 }), {}, rates, ctx).limitCents, 2_000_000);
  assert.equal(priceQuote(store(LOW_ZIP, { inventoryCents: 40_000_000 }), {}, rates, ctx).limitCents, 5_000_000);
});
test("low score auto-binds, high score refers", () => {
  assert.equal(priceQuote(store(LOW_ZIP), {}, rates, ctx).route, "auto");
  assert.equal(priceQuote(store(HIGH_ZIP), {}, rates, ctx).route, "refer");
});
test("area limit refers", () => {
  const q = priceQuote(store(LOW_ZIP), {}, rates, { ...ctx, areaLimitCents: 9_000_000 });
  assert.equal(q.route, "refer");
});
test("pending and closed states do not auto-bind", () => {
  assert.equal(priceQuote(store(LOW_ZIP), {}, rates, { ...ctx, stateStatus: "pending" }).route, "waitlist");
  assert.equal(priceQuote(store(LOW_ZIP), {}, rates, { ...ctx, stateStatus: "closed" }).route, "decline");
});
test("sensor discount lowers premium", () => {
  const a = priceQuote(store(LOW_ZIP), {}, rates, ctx).premiumCents;
  const b = priceQuote(store(LOW_ZIP), { sensor: true }, rates, ctx).premiumCents;
  assert.ok(b < a);
});
test("validation rejects bad input", () => {
  assert.ok(validateStore({ name: "", zip: "1", type: "x", state: "t", utility: "", inventoryCents: 5 }).length >= 5);
  assert.equal(validateStore(store(LOW_ZIP)).length, 0);
});
test("commission is rounded cents", () => assert.equal(commissionCents(100_000, 0.12), 12_000));

const base = { boundAt: 0, waitH: 24, limitCents: 1_000_000, tiers: DEFAULT_TIERS };
const out = (src, sH, eH) => ({ src, start: sH * HOUR, end: eH * HOUR });
test("two agreeing sources trigger the right tier", () => {
  const r = evaluate({ ...base, readings: [out("A", 30, 40), out("B", 30, 40)] });
  assert.equal(r.result, "trigger"); assert.equal(r.tierH, 8); assert.equal(r.amountCents, 500_000);
});
test("outage inside waiting period does not trigger", () => {
  assert.equal(evaluate({ ...base, readings: [out("A", 1, 20), out("B", 1, 20)] }).result, "no-trigger");
});
test("single source goes to review", () => assert.equal(evaluate({ ...base, readings: [out("A", 30, 40)] }).result, "review"));
test("disagreeing sources go to review with conservative proposal", () => {
  const r = evaluate({ ...base, readings: [out("A", 30, 40), out("B", 30, 34)] });
  assert.equal(r.result, "review"); assert.equal(r.proposed.tierH, 4);
});
test("majority of three pays", () => {
  const r = evaluate({ ...base, readings: [out("A", 30, 40), out("B", 30, 40), out("S", 30, 31)] });
  assert.equal(r.result, "trigger");
});
test("evaluate is deterministic", () => {
  const i = { ...base, readings: [out("A", 30, 60), out("B", 30, 60)] };
  assert.deepEqual(evaluate(i), evaluate(i));
});
test("payout status order", () => {
  assert.equal(payoutStatus({ paidAt: 1 }), "paid");
  assert.equal(payoutStatus({ bankVerified: false, amountCents: 1 }), "hold-bank");
  assert.equal(payoutStatus({ bankVerified: true, amountCents: 2_000_000, approved: false }), "needs-approval");
  assert.equal(payoutStatus({ bankVerified: true, amountCents: 2_000_000, approved: true }), "ready");
  assert.equal(payoutStatus({ bankVerified: true, amountCents: 100, approved: false }), "ready");
});

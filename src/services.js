import {
  APPROVAL_CENTS, CHANNELS, HOUR, SLA_HOURS, TRIG_RULES, UW_RULES,
  commissionCents, evaluate, payoutStatus, priceQuote, sentence, validateStore,
} from "./engine.js";
import { audit, verifyAudit } from "./audit.js";
import { getSetting, nextId, setSetting, tx } from "./db.js";
import { hashPassword, sha256, verifyPassword } from "./auth.js";
import crypto from "node:crypto";

export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

const j = (s) => JSON.parse(s);
const money = (c) => "$" + (c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function createServices({ db, payments, config = {}, nowFn = Date.now }) {
  const T = () => nowFn() + Number(getSetting(db, "clock_offset_ms", 0));
  const log = (actor, type, detail, version = "") => audit(db, T(), actor, type, detail, version);
  const who = (u) => `${u.name} (${u.role})`;
  const notice = (merchantId, text) =>
    db.prepare("INSERT INTO notices(merchant_id,text,created_at) VALUES(?,?,?)").run(merchantId, text, T());
  const autoRelease = () => getSetting(db, "auto_release", "1") === "1";

  /* ---------- rates ---------- */
  function currentRates() {
    const r = db.prepare("SELECT * FROM rates ORDER BY id DESC LIMIT 1").get();
    return { version: r.version, base: r.base, waitH: r.wait_h, maxLimitCents: r.max_limit_cents, share: r.share, tiers: j(r.tiers), effectiveAt: r.effective_at };
  }

  /* ---------- quotes and policies ---------- */
  const areaLimit = (zip) =>
    db.prepare("SELECT COALESCE(SUM(limit_cents),0) AS s FROM policies WHERE zip=? AND status='active'").get(zip).s;

  function quoteView(q) {
    const snap = j(q.snap);
    const store = j(q.store);
    const v = {
      id: q.id, merchantId: q.merchant_id, status: q.status, route: q.route, reasons: j(q.reasons),
      limitCents: q.limit_cents, premiumCents: q.premium_cents, score: q.score, snap, store, createdAt: q.created_at,
    };
    v.sentence = sentence({ limitCents: q.limit_cents, premiumCents: q.premium_cents, snap }, store.zip);
    return v;
  }

  function findOrCreateMerchant(name) {
    const row = db.prepare("SELECT id FROM merchants WHERE lower(name)=lower(?)").get(name);
    if (row) return row.id;
    return Number(db.prepare("INSERT INTO merchants(name,created_at) VALUES(?,?)").run(name, T()).lastInsertRowid);
  }

  function createQuote(user, body) {
    if (!["merchant", "agent"].includes(user.role)) throw new HttpError(403, "Only merchants and partners can request quotes.");
    const input = body?.store || {};
    let merchantId;
    if (user.role === "merchant") {
      merchantId = user.merchant_id;
      if (!input.name) input.name = db.prepare("SELECT name FROM merchants WHERE id=?").get(merchantId).name;
    } else {
      if (!String(input.name || "").trim()) throw new HttpError(400, "Validation failed", ["Enter the store name."]);
    }
    const store = {
      name: String(input.name || "").trim(), type: input.type, state: String(input.state || "").toUpperCase(),
      zip: String(input.zip || "").trim(), utility: String(input.utility || "").trim(),
      inventoryCents: Math.round(Number(input.inventoryCents)),
    };
    const errors = validateStore(store);
    if (errors.length) throw new HttpError(400, "Validation failed", errors);
    const st = db.prepare("SELECT * FROM states WHERE code=?").get(store.state);
    if (!st) throw new HttpError(400, "Validation failed", ["Unknown state."]);
    if (user.role === "agent") merchantId = findOrCreateMerchant(store.name);
    const opts = {
      style: body.style === "single" ? "single" : "tiered",
      trigger: [4, 8, 12, 24].includes(Number(body.trigger)) ? Number(body.trigger) : 12,
      sensor: body.sensor === true || body.sensor === "yes",
    };
    const rates = currentRates();
    const p = priceQuote(store, opts, rates, { stateStatus: st.status, stateName: st.name, areaLimitCents: areaLimit(store.zip) });
    const id = tx(db, () => nextId(db, "Q"));
    db.prepare(
      "INSERT INTO quotes(id,merchant_id,partner_id,created_by,store,opts,limit_cents,premium_cents,score,route,reasons,snap,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
    ).run(id, merchantId, user.partner_id ?? null, user.id, JSON.stringify(store), JSON.stringify(opts), p.limitCents, p.premiumCents, p.score, p.route, JSON.stringify(p.reasons), JSON.stringify(p.snap), "open", T());
    log(who(user), "quote.created", `${id} for ${store.name}: limit ${money(p.limitCents)}, premium ${money(p.premiumCents)}, route ${p.route}.`, `${p.snap.ruleVersion} / ${p.snap.rateVersion}`);
    return quoteView(db.prepare("SELECT * FROM quotes WHERE id=?").get(id));
  }

  function getQuoteFor(user, id) {
    const q = db.prepare("SELECT * FROM quotes WHERE id=?").get(id);
    if (!q) throw new HttpError(404, "Quote not found.");
    const mine =
      (user.role === "merchant" && q.merchant_id === user.merchant_id) ||
      (user.role === "agent" && q.partner_id === user.partner_id) ||
      ["admin", "underwriting"].includes(user.role);
    if (!mine) throw new HttpError(404, "Quote not found.");
    return q;
  }

  function bindPolicy(q, actor) {
    return tx(db, () => {
      const id = nextId(db, "P");
      const opts = j(q.opts);
      const store = j(q.store);
      const partner = q.partner_id ? db.prepare("SELECT * FROM partners WHERE id=?").get(q.partner_id) : null;
      const commission = partner ? commissionCents(q.premium_cents, partner.rate) : 0;
      db.prepare(
        "INSERT INTO policies(id,merchant_id,partner_id,quote_id,store,zip,state,limit_cents,premium_cents,score,bound_at,snap,sensor,status,commission_cents) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
      ).run(id, q.merchant_id, q.partner_id, q.id, q.store, store.zip, store.state, q.limit_cents, q.premium_cents, q.score, T(), q.snap, opts.sensor ? 1 : 0, "active", commission);
      db.prepare("UPDATE quotes SET status='bound' WHERE id=?").run(q.id);
      const snap = j(q.snap);
      log(actor, "policy.bound", `${id} bound for ${store.name} (${store.zip}): limit ${money(q.limit_cents)}, premium ${money(q.premium_cents)}.`, `${snap.ruleVersion} / ${snap.rateVersion}`);
      notice(q.merchant_id, `Policy ${id} is bound. Cover starts after a ${snap.waitH}-hour waiting period.`);
      return id;
    });
  }

  function bindQuote(user, id) {
    const q = getQuoteFor(user, id);
    if (!["merchant", "agent"].includes(user.role)) throw new HttpError(403, "Only the buyer can bind a quote.");
    if (q.status !== "open") throw new HttpError(409, `Quote is already ${q.status}.`);
    if (q.route !== "auto") throw new HttpError(409, "This quote needs underwriting review before it can be bound.");
    const pid = bindPolicy(q, who(user));
    return policyView(db.prepare("SELECT * FROM policies WHERE id=?").get(pid));
  }

  function referQuote(user, id) {
    const q = getQuoteFor(user, id);
    if (q.status !== "open") throw new HttpError(409, `Quote is already ${q.status}.`);
    if (q.route !== "refer") throw new HttpError(409, "Only quotes that need review can be referred.");
    const rid = tx(db, () => {
      const rid = nextId(db, "R");
      db.prepare("INSERT INTO referrals(id,quote_id,status,created_at) VALUES(?,?,?,?)").run(rid, id, "open", T());
      db.prepare("UPDATE quotes SET status='referred' WHERE id=?").run(id);
      return rid;
    });
    log(who(user), "application.referred", `${rid}: ${j(q.store).name} sent to underwriting review: ${j(q.reasons).join("; ")}`, UW_RULES);
    return { id: rid, status: "open" };
  }

  function listReferrals(status) {
    const rows = db.prepare("SELECT r.*, q.store, q.limit_cents, q.premium_cents, q.reasons, q.partner_id FROM referrals r JOIN quotes q ON q.id=r.quote_id WHERE (? IS NULL OR r.status=?) ORDER BY r.created_at DESC").all(status ?? null, status ?? null);
    return rows.map((r) => ({ id: r.id, quoteId: r.quote_id, status: r.status, store: j(r.store), limitCents: r.limit_cents, premiumCents: r.premium_cents, reasons: j(r.reasons), partnerId: r.partner_id, createdAt: r.created_at }));
  }

  function decideReferral(user, id, approve) {
    const r = db.prepare("SELECT * FROM referrals WHERE id=?").get(id);
    if (!r) throw new HttpError(404, "Referral not found.");
    if (r.status !== "open") throw new HttpError(409, `Referral already ${r.status}.`);
    const q = db.prepare("SELECT * FROM quotes WHERE id=?").get(r.quote_id);
    db.prepare("UPDATE referrals SET status=?,decided_by=?,decided_at=? WHERE id=?").run(approve ? "approved" : "declined", user.id, T(), id);
    if (approve) {
      const pid = bindPolicy(q, who(user));
      log(who(user), "referral.approved", `${id} approved and bound as ${pid}.`, UW_RULES);
      return { id, status: "approved", policyId: pid };
    }
    db.prepare("UPDATE quotes SET status='declined' WHERE id=?").run(q.id);
    log(who(user), "referral.declined", `${id} declined: ${j(q.reasons).join("; ")}`, UW_RULES);
    notice(q.merchant_id, "We could not offer cover for this location at this time.");
    return { id, status: "declined" };
  }

  function policyView(p) {
    const snap = j(p.snap);
    const coverStart = p.bound_at + snap.waitH * HOUR;
    const m = db.prepare("SELECT name,bank_verified FROM merchants WHERE id=?").get(p.merchant_id);
    const partner = p.partner_id ? db.prepare("SELECT name,channel FROM partners WHERE id=?").get(p.partner_id) : null;
    return {
      id: p.id, merchantId: p.merchant_id, merchant: m.name, store: j(p.store), limitCents: p.limit_cents,
      premiumCents: p.premium_cents, score: p.score, boundAt: p.bound_at, coverStart, covered: T() >= coverStart,
      snap, sensor: !!p.sensor, bankVerified: !!m.bank_verified, partner, commissionCents: p.commission_cents, status: p.status,
    };
  }

  function listPolicies(user) {
    let rows;
    if (user.role === "merchant") rows = db.prepare("SELECT * FROM policies WHERE merchant_id=? ORDER BY bound_at DESC").all(user.merchant_id);
    else if (user.role === "agent") rows = db.prepare("SELECT * FROM policies WHERE partner_id=? ORDER BY bound_at DESC").all(user.partner_id);
    else rows = db.prepare("SELECT * FROM policies ORDER BY bound_at DESC").all();
    return rows.map(policyView);
  }

  async function verifyBank(user) {
    if (user.role !== "merchant") throw new HttpError(403, "Only a merchant can verify its bank account.");
    db.prepare("UPDATE merchants SET bank_verified=1 WHERE id=?").run(user.merchant_id);
    log(who(user), "bank.verified", `Bank account ownership verified for merchant ${user.merchant_id} (demo).`);
    for (const p of db.prepare("SELECT id FROM payouts WHERE merchant_id=? AND paid_at IS NULL").all(user.merchant_id)) await tryAuto(p.id);
    return { ok: true };
  }

  /* ---------- trigger engine ---------- */
  function listOutageReadings(eventId) {
    return db.prepare("SELECT * FROM readings WHERE event_id=? AND policy_id IS NULL ORDER BY id").all(eventId);
  }

  async function ingestOutage(actor, body, { sensorMode = "agree" } = {}) {
    const zip = String(body?.zip || "");
    const start = Number(body?.start), end = Number(body?.end);
    if (!/^\d{5}$/.test(zip) || !(end > start)) throw new HttpError(400, "Validation failed", ["zip must be 5 digits and end must be after start (epoch ms)."]);
    const rs = Array.isArray(body.readings) ? body.readings : [];
    for (const r of rs) {
      if (!r || !/^[A-Za-z0-9_-]{1,12}$/.test(String(r.source)) || !(Number(r.end) > Number(r.start))) throw new HttpError(400, "Validation failed", ["Each reading needs a source and end after start."]);
    }
    const ext = body.externalId ? String(body.externalId) : null;
    let event = ext ? db.prepare("SELECT * FROM outage_events WHERE external_id=?").get(ext) : null;
    let duplicate = false;
    if (event) duplicate = true;
    else {
      event = tx(db, () => {
        const id = nextId(db, "O");
        db.prepare("INSERT INTO outage_events(id,external_id,zip,start_ms,end_ms,source_count,sensor_mode,created_at) VALUES(?,?,?,?,?,?,?,?)").run(id, ext, zip, start, end, rs.length, sensorMode, T());
        for (const r of rs) db.prepare("INSERT INTO readings(event_id,source,zip,start_ms,end_ms,received_at) VALUES(?,?,?,?,?,?)").run(id, String(r.source), zip, Number(r.start), Number(r.end), T());
        return db.prepare("SELECT * FROM outage_events WHERE id=?").get(id);
      });
      log(actor, "reading.ingested", `Outage ${event.id} at ZIP ${zip}: ${rs.length} feed source(s) reported.`);
      if (rs.length === 0) log(actor, "feed.alert", `No feed reported outage ${event.id} at ZIP ${zip}. Feeds are silent; ops alerted.`);
      else if (rs.length < 2) log(actor, "feed.alert", `Only one feed reported outage ${event.id}; policies without a store sensor go to human review.`);
    }
    const base = listOutageReadings(event.id).map((r) => ({ src: r.source, start: r.start_ms, end: r.end_ms }));
    const decisions = [];
    if (base.length || sensorMode !== "silent") {
      for (const p of db.prepare("SELECT * FROM policies WHERE zip=? AND status='active'").all(zip)) {
        decisions.push(await decide(p, event, base));
      }
    }
    return { event: { id: event.id, zip, start: event.start_ms, end: event.end_ms, sources: event.source_count }, duplicate, decisions: decisions.filter(Boolean) };
  }

  async function decide(p, event, base) {
    const snap = j(p.snap);
    if (db.prepare("SELECT 1 FROM decisions WHERE policy_id=? AND event_id=?").get(p.id, event.id)) {
      log("Trigger engine", "decision.duplicate-blocked", `Event ${event.id} was already decided for ${p.id}; no second payment.`, TRIG_RULES);
      return { policyId: p.id, result: "duplicate" };
    }
    const rr = base.map((r) => ({ ...r }));
    if (p.sensor && event.sensor_mode !== "silent") {
      rr.push({ src: "S", start: event.start_ms, end: event.end_ms });
      db.prepare("INSERT INTO readings(event_id,source,zip,start_ms,end_ms,policy_id,received_at) VALUES(?,?,?,?,?,?,?)").run(event.id, "S", event.zip, event.start_ms, event.end_ms, p.id, T());
    }
    if (!rr.length) return { policyId: p.id, result: "no-data" };
    const inputs = { boundAt: p.bound_at, waitH: snap.waitH, limitCents: p.limit_cents, tiers: snap.tiers, readings: rr };
    const res = evaluate(inputs);
    const did = tx(db, () => {
      const id = nextId(db, "D");
      db.prepare("INSERT INTO decisions(id,policy_id,event_id,inputs,result,rule,created_at) VALUES(?,?,?,?,?,?,?)").run(id, p.id, event.id, JSON.stringify(inputs), JSON.stringify(res), TRIG_RULES, T());
      return id;
    });
    log("Trigger engine", "decision", `${did} for ${p.id}: ${res.result}. ${res.reason}.`, TRIG_RULES);
    notice(p.merchant_id, `We detected a power outage at your address (${event.id}).`);
    let payoutId = null;
    if (res.result === "trigger") {
      payoutId = createPayout(p, did, res.amountCents);
      notice(p.merchant_id, `Your trigger was met. A payment of ${money(res.amountCents)} is being processed.`);
      await tryAuto(payoutId);
    } else if (res.result === "review") {
      const rid = tx(db, () => nextId(db, "V"));
      db.prepare("INSERT INTO reviews(id,policy_id,decision_id,status,created_at) VALUES(?,?,?,?,?)").run(rid, p.id, did, "open", T());
      notice(p.merchant_id, "Our data sources need a human check on this outage. We will update you.");
    } else {
      notice(p.merchant_id, `This outage did not meet your trigger: ${res.reason}.`);
    }
    return { policyId: p.id, decisionId: did, result: res.result, reason: res.reason, payoutId };
  }

  function createPayout(p, decisionId, amountCents) {
    const id = tx(db, () => nextId(db, "PO"));
    db.prepare("INSERT INTO payouts(id,policy_id,merchant_id,decision_id,amount_cents,created_at) VALUES(?,?,?,?,?,?)").run(id, p.id, p.merchant_id, decisionId, amountCents, T());
    log("Payout service", "payout.created", `${id} for ${p.id}: ${money(amountCents)}.`, TRIG_RULES);
    return id;
  }

  const payoutRow = (id) =>
    db.prepare("SELECT po.*, m.bank_verified, m.name AS merchant FROM payouts po JOIN merchants m ON m.id=po.merchant_id WHERE po.id=?").get(id);

  const payoutStatusOf = (r) => payoutStatus({ paidAt: r.paid_at, bankVerified: !!r.bank_verified, amountCents: r.amount_cents, approved: !!r.approved });

  async function tryAuto(id) {
    const r = payoutRow(id);
    if (autoRelease() && payoutStatusOf(r) === "ready") await release(id, "Payout service (auto)");
  }

  async function release(id, actor) {
    const r = payoutRow(id);
    if (!r) throw new HttpError(404, "Payout not found.");
    const st = payoutStatusOf(r);
    if (st !== "ready") throw new HttpError(409, `Payout cannot be released: ${st}.`);
    const t = await payments.createTransfer({ amountCents: r.amount_cents, merchantId: r.merchant_id, idempotencyKey: r.id });
    const upd = db.prepare("UPDATE payouts SET paid_at=?, provider_ref=? WHERE id=? AND paid_at IS NULL").run(T(), t.ref, id);
    if (!upd.changes) return payoutView(payoutRow(id));
    log(actor, "payout.paid", `${id}: ${money(r.amount_cents)} sent to ${r.merchant} after ${Math.round(((T() - r.created_at) / HOUR) * 10) / 10} h (${t.ref}).`);
    notice(r.merchant_id, `Payment of ${money(r.amount_cents)} was sent (${id}).`);
    return payoutView(payoutRow(id));
  }

  function payoutView(r) {
    return {
      id: r.id, policyId: r.policy_id, merchantId: r.merchant_id, merchant: r.merchant, amountCents: r.amount_cents,
      status: payoutStatusOf(r), createdAt: r.created_at, paidAt: r.paid_at, providerRef: r.provider_ref,
      ageHours: Math.round((((r.paid_at ?? T()) - r.created_at) / HOUR) * 10) / 10, slaHours: SLA_HOURS,
    };
  }

  function listPayouts(user) {
    const rows = db.prepare("SELECT po.*, m.bank_verified, m.name AS merchant FROM payouts po JOIN merchants m ON m.id=po.merchant_id ORDER BY po.created_at DESC").all();
    return rows.filter((r) => user.role !== "merchant" || r.merchant_id === user.merchant_id).map(payoutView);
  }

  async function approvePayout(user, id) {
    const r = payoutRow(id);
    if (!r) throw new HttpError(404, "Payout not found.");
    if (r.amount_cents <= APPROVAL_CENTS) throw new HttpError(409, "This payout is under the approval limit.");
    if (r.approved) throw new HttpError(409, "Already approved.");
    db.prepare("UPDATE payouts SET approved=1, approved_by=? WHERE id=?").run(user.id, id);
    log(who(user), "payout.approved", `${id} approved above the ${money(APPROVAL_CENTS)} threshold.`);
    await tryAuto(id);
    return payoutView(payoutRow(id));
  }

  async function releasePayout(user, id) {
    return release(id, who(user));
  }

  /* ---------- reviews ---------- */
  function listReviews(status = "open") {
    const rows = db.prepare("SELECT v.*, d.inputs, d.result, d.event_id FROM reviews v JOIN decisions d ON d.id=v.decision_id WHERE v.status=? ORDER BY v.created_at").all(status);
    return rows.map((v) => {
      const p = db.prepare("SELECT merchant_id FROM policies WHERE id=?").get(v.policy_id);
      const m = db.prepare("SELECT name FROM merchants WHERE id=?").get(p.merchant_id);
      return { id: v.id, policyId: v.policy_id, merchant: m.name, decisionId: v.decision_id, eventId: v.event_id, status: v.status, inputs: j(v.inputs), result: j(v.result), createdAt: v.created_at };
    });
  }

  async function resolveReview(user, id, action) {
    const v = db.prepare("SELECT * FROM reviews WHERE id=?").get(id);
    if (!v) throw new HttpError(404, "Review not found.");
    if (v.status !== "open") throw new HttpError(409, `Review already ${v.status}.`);
    const d = db.prepare("SELECT * FROM decisions WHERE id=?").get(v.decision_id);
    const res = j(d.result);
    const p = db.prepare("SELECT * FROM policies WHERE id=?").get(v.policy_id);
    if (action === "pay") {
      if (!res.proposed) throw new HttpError(409, "The conservative reading is under the first tier, so there is nothing to pay.");
      db.prepare("UPDATE reviews SET status='paid',decided_by=?,decided_at=? WHERE id=?").run(user.id, T(), id);
      const pid = createPayout(p, d.id, res.proposed.amountCents);
      log(who(user), "review.resolved", `${id}: paid at the conservative reading (${money(res.proposed.amountCents)}).`, TRIG_RULES);
      notice(p.merchant_id, `After review, a payment of ${money(res.proposed.amountCents)} is being processed.`);
      await tryAuto(pid);
      return { id, status: "paid", payoutId: pid };
    }
    db.prepare("UPDATE reviews SET status='rejected',decided_by=?,decided_at=? WHERE id=?").run(user.id, T(), id);
    log(who(user), "review.resolved", `${id}: no payout.`, TRIG_RULES);
    notice(p.merchant_id, "After review, this outage did not meet your trigger.");
    return { id, status: "rejected" };
  }

  /* ---------- rates (two-person approval by distinct users) ---------- */
  function listRates() {
    const versions = db.prepare("SELECT r.*, u1.name AS proposer, u2.name AS approver FROM rates r LEFT JOIN users u1 ON u1.id=r.proposed_by LEFT JOIN users u2 ON u2.id=r.approved_by ORDER BY r.id DESC").all()
      .map((r) => ({ version: r.version, base: r.base, waitH: r.wait_h, maxLimitCents: r.max_limit_cents, share: r.share, tiers: j(r.tiers), effectiveAt: r.effective_at, proposedBy: r.proposer, approvedBy: r.approver }));
    const proposals = db.prepare("SELECT p.*, u.name AS proposer FROM rate_proposals p JOIN users u ON u.id=p.proposed_by ORDER BY p.id DESC").all()
      .map((p) => ({ id: p.id, base: p.base, waitH: p.wait_h, maxLimitCents: p.max_limit_cents, status: p.status, proposedBy: p.proposed_by, proposer: p.proposer, createdAt: p.created_at }));
    return { current: currentRates(), versions, proposals };
  }

  function proposeRates(user, body) {
    const base = Number(body?.base), waitH = Number(body?.waitH), max = Math.round(Number(body?.maxLimitCents));
    if (!(base > 0 && base < 0.2) || !(waitH >= 0 && waitH <= 168) || !(max >= 100_000)) {
      throw new HttpError(400, "Validation failed", ["base must be between 0 and 0.2, waitH between 0 and 168, maxLimitCents at least 100000."]);
    }
    const id = Number(db.prepare("INSERT INTO rate_proposals(base,wait_h,max_limit_cents,status,proposed_by,created_at) VALUES(?,?,?,?,?,?)").run(base, waitH, max, "open", user.id, T()).lastInsertRowid);
    log(who(user), "rates.proposed", `RP-${id}: base rate ${(base * 100).toFixed(1)}%, ${waitH} h wait, limit up to ${money(max)}. Needs a second approver.`);
    return { id, status: "open" };
  }

  function decideRates(user, id, approve) {
    const p = db.prepare("SELECT * FROM rate_proposals WHERE id=?").get(id);
    if (!p) throw new HttpError(404, "Proposal not found.");
    if (p.status !== "open") throw new HttpError(409, `Proposal already ${p.status}.`);
    if (approve && p.proposed_by === user.id) throw new HttpError(403, "A different person must approve this change.");
    if (!approve) {
      db.prepare("UPDATE rate_proposals SET status='rejected',decided_by=? WHERE id=?").run(user.id, id);
      log(who(user), "rates.rejected", `RP-${id} rejected.`);
      return { id, status: "rejected" };
    }
    const cur = currentRates();
    const n = db.prepare("SELECT COUNT(*) AS n FROM rates").get().n + 1;
    tx(db, () => {
      db.prepare("INSERT INTO rates(version,base,wait_h,max_limit_cents,share,tiers,effective_at,proposed_by,approved_by) VALUES(?,?,?,?,?,?,?,?,?)").run(`rates-v${n}`, p.base, p.wait_h, p.max_limit_cents, cur.share, JSON.stringify(cur.tiers), T(), p.proposed_by, user.id);
      db.prepare("UPDATE rate_proposals SET status='approved',decided_by=? WHERE id=?").run(user.id, id);
    });
    log(who(user), "rates.approved", `rates-v${n} approved (proposal RP-${id}). Existing policies keep their version.`, `rates-v${n}`);
    return { id, status: "approved", version: `rates-v${n}` };
  }

  /* ---------- reports, audit, replay ---------- */
  function summary() {
    const pol = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(premium_cents),0) AS prem FROM policies WHERE status='active'").get();
    const paid = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(amount_cents),0) AS amt, AVG(paid_at-created_at) AS avg FROM payouts WHERE paid_at IS NOT NULL").get();
    const open = db.prepare("SELECT id,created_at FROM payouts WHERE paid_at IS NULL").all();
    return {
      policies: pol.n, writtenPremiumCents: pol.prem, paidCents: paid.amt, paidCount: paid.n,
      lossRatio: pol.prem ? Math.round((paid.amt / pol.prem) * 1000) / 10 : null,
      avgHoursToPay: paid.avg != null ? Math.round((paid.avg / HOUR) * 10) / 10 : null,
      openPayouts: open.length, latePayouts: open.filter((o) => T() - o.created_at > SLA_HOURS * HOUR).length,
      openReviews: db.prepare("SELECT COUNT(*) AS n FROM reviews WHERE status='open'").get().n,
      openReferrals: db.prepare("SELECT COUNT(*) AS n FROM referrals WHERE status='open'").get().n,
      feeds: { A: getSetting(db, "feed_A", "1") === "1", B: getSetting(db, "feed_B", "1") === "1" },
      autoRelease: autoRelease(), now: T(), demo: !!config.demo,
    };
  }

  function bordereau() {
    return db.prepare("SELECT p.id, m.name AS merchant, p.state, p.zip, p.bound_at, p.premium_cents, p.limit_cents, COALESCE((SELECT SUM(amount_cents) FROM payouts po WHERE po.policy_id=p.id AND po.paid_at IS NOT NULL),0) AS paid_cents FROM policies p JOIN merchants m ON m.id=p.merchant_id ORDER BY p.bound_at").all();
  }

  function bordereauCsv() {
    const rows = [["policy", "merchant", "state", "zip", "bound_at", "premium", "limit", "paid_out"]];
    for (const r of bordereau()) rows.push([r.id, r.merchant, r.state, r.zip, new Date(r.bound_at).toISOString(), (r.premium_cents / 100).toFixed(2), (r.limit_cents / 100).toFixed(2), (r.paid_cents / 100).toFixed(2)]);
    return rows.map((r) => r.map((c) => (/[",\n]/.test(String(c)) ? `"${String(c).replace(/"/g, '""')}"` : c)).join(",")).join("\n") + "\n";
  }

  function listAudit({ type, limit = 200 } = {}) {
    const lim = Math.min(Math.max(parseInt(limit, 10) || 200, 1), 1000);
    const rows = type
      ? db.prepare("SELECT seq,at,actor,type,detail,version FROM audit WHERE type LIKE ? ORDER BY seq DESC LIMIT ?").all(`${type}%`, lim)
      : db.prepare("SELECT seq,at,actor,type,detail,version FROM audit ORDER BY seq DESC LIMIT ?").all(lim);
    return rows;
  }

  function listDecisions() {
    return db.prepare("SELECT id,policy_id,event_id,result,created_at FROM decisions ORDER BY created_at DESC LIMIT 200").all()
      .map((d) => ({ id: d.id, policyId: d.policy_id, eventId: d.event_id, result: j(d.result).result, createdAt: d.created_at }));
  }

  function replay(id) {
    const d = db.prepare("SELECT * FROM decisions WHERE id=?").get(id);
    if (!d) throw new HttpError(404, "Decision not found.");
    const inputs = j(d.inputs);
    const stored = j(d.result);
    const replayed = evaluate(inputs);
    return { id, rule: d.rule, inputs, stored, replayed, matches: JSON.stringify(stored) === JSON.stringify(replayed) };
  }

  function myNotices(user) {
    if (user.role !== "merchant") return [];
    return db.prepare("SELECT id,text,created_at FROM notices WHERE merchant_id=? ORDER BY id DESC LIMIT 50").all(user.merchant_id);
  }

  /* ---------- admin ---------- */
  function setFeed(user, feed, online) {
    if (!["A", "B"].includes(feed)) throw new HttpError(400, "Unknown feed.");
    setSetting(db, `feed_${feed}`, online ? "1" : "0");
    log(who(user), "feed.status", `Feed ${feed} set ${online ? "online" : "silent"}.`);
    return summary().feeds;
  }

  async function simulateOutage(user, body) {
    if (!config.demo) throw new HttpError(403, "Outage simulation is only available in demo mode.");
    const durationH = Number(body?.durationH), endedHoursAgo = Number(body?.endedHoursAgo ?? 0);
    if (!(durationH > 0) || !(endedHoursAgo >= 0)) throw new HttpError(400, "Validation failed", ["durationH must be above 0 and endedHoursAgo 0 or more."]);
    const end = T() - endedHoursAgo * HOUR, start = end - durationH * HOUR;
    const readings = [];
    if (getSetting(db, "feed_A", "1") === "1") readings.push({ source: "A", start, end });
    const bMode = body?.bMode || "agree";
    if (getSetting(db, "feed_B", "1") === "1" && bMode !== "silent") readings.push({ source: "B", start, end: bMode === "early" ? Math.max(start + 0.5 * HOUR, end - 2 * HOUR) : end });
    return ingestOutage(who(user), { zip: body.zip, start, end, readings }, { sensorMode: body?.sMode === "silent" ? "silent" : "agree" });
  }

  function advanceClock(user, hours) {
    if (!config.demo) throw new HttpError(403, "The demo clock is only available in demo mode.");
    const h = Number(hours);
    if (!(h > 0 && h <= 24 * 30)) throw new HttpError(400, "Validation failed", ["hours must be between 0 and 720."]);
    setSetting(db, "clock_offset_ms", Number(getSetting(db, "clock_offset_ms", 0)) + h * HOUR);
    log(who(user), "clock.advanced", `Demo clock advanced ${h} h.`);
    return { now: T() };
  }

  function setAutoRelease(user, on) {
    setSetting(db, "auto_release", on ? "1" : "0");
    log(who(user), "settings.autorelease", `Auto-release of payouts under the approval limit set ${on ? "on" : "off"}.`);
    return { autoRelease: on };
  }

  function setState(user, code, status) {
    if (!["open", "pending", "closed"].includes(status)) throw new HttpError(400, "Validation failed", ["status must be open, pending or closed."]);
    const r = db.prepare("UPDATE states SET status=? WHERE code=?").run(status, String(code).toUpperCase());
    if (!r.changes) throw new HttpError(404, "State not found.");
    log(who(user), "state.status", `${code} set to ${status}.`);
    return db.prepare("SELECT * FROM states WHERE code=?").get(String(code).toUpperCase());
  }

  const listStates = () => db.prepare("SELECT * FROM states ORDER BY code").all();

  function createUser(user, body) {
    const roles = ["merchant", "agent", "underwriting", "ops", "auditor", "admin"];
    const email = String(body?.email || "").trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, "Validation failed", ["Enter a valid email."]);
    if (!roles.includes(body.role)) throw new HttpError(400, "Validation failed", ["Unknown role."]);
    if (String(body.password || "").length < 10) throw new HttpError(400, "Validation failed", ["Password must be at least 10 characters."]);
    if (db.prepare("SELECT 1 FROM users WHERE email=?").get(email)) throw new HttpError(409, "That email is already registered.");
    let merchantId = null, partnerId = null;
    if (body.role === "merchant") merchantId = findOrCreateMerchant(String(body.merchantName || body.name || "").trim() || email);
    if (body.role === "agent") {
      partnerId = Number(body.partnerId);
      if (!db.prepare("SELECT 1 FROM partners WHERE id=?").get(partnerId)) throw new HttpError(400, "Validation failed", ["Choose an existing partner."]);
    }
    const id = Number(db.prepare("INSERT INTO users(email,name,role,pw_hash,merchant_id,partner_id) VALUES(?,?,?,?,?,?)").run(email, String(body.name || email), body.role, hashPassword(body.password), merchantId, partnerId).lastInsertRowid);
    log(user ? who(user) : "Self-service", "user.created", `${email} added as ${body.role}.`);
    return { id, email, role: body.role };
  }

  function registerMerchant(body) {
    const businessName = String(body?.businessName || "").trim();
    if (!businessName) throw new HttpError(400, "Validation failed", ["Enter the business name."]);
    return createUser(null, { email: body.email, name: body.name, password: body.password, role: "merchant", merchantName: businessName });
  }

  function listUsers() {
    return db.prepare("SELECT id,email,name,role,merchant_id,partner_id,active FROM users ORDER BY id").all();
  }

  function createPartner(user, body) {
    const name = String(body?.name || "").trim();
    const ch = CHANNELS[body?.channel];
    if (!name || !ch) throw new HttpError(400, "Validation failed", ["Give the partner a name and a channel: agent, assoc or embedded."]);
    const key = "pk_" + crypto.randomBytes(24).toString("hex");
    const id = Number(db.prepare("INSERT INTO partners(name,channel,rate,api_key_hash) VALUES(?,?,?,?)").run(name, body.channel, ch.rate, sha256(key)).lastInsertRowid);
    log(who(user), "partner.created", `Partner ${name} (${body.channel}) added at ${(ch.rate * 100).toFixed(1)}% commission.`);
    return { id, name, channel: body.channel, rate: ch.rate, apiKey: key };
  }

  const listPartners = () => db.prepare("SELECT id,name,channel,rate FROM partners ORDER BY id").all();

  function partnerCommissions(user) {
    const rows = db.prepare("SELECT p.id, m.name AS merchant, p.premium_cents, p.commission_cents, p.bound_at FROM policies p JOIN merchants m ON m.id=p.merchant_id WHERE p.partner_id=? ORDER BY p.bound_at DESC").all(user.partner_id);
    return { policies: rows.length, premiumCents: rows.reduce((a, r) => a + r.premium_cents, 0), commissionCents: rows.reduce((a, r) => a + r.commission_cents, 0), rows };
  }

  /* ---------- auth ---------- */
  function login(email, password) {
    const u = db.prepare("SELECT * FROM users WHERE email=? AND active=1").get(String(email || "").trim().toLowerCase());
    if (!u || !verifyPassword(String(password || ""), u.pw_hash)) return null;
    return u;
  }
  const userById = (id) => db.prepare("SELECT * FROM users WHERE id=? AND active=1").get(id);
  function partnerByKey(key) {
    const p = db.prepare("SELECT * FROM partners WHERE api_key_hash=?").get(sha256(String(key)));
    return p ? { id: -p.id, name: p.name, role: "agent", partner_id: p.id, email: null, merchant_id: null } : null;
  }

  return {
    T, currentRates, createQuote, bindQuote, referQuote, listReferrals, decideReferral, listPolicies, verifyBank,
    ingestOutage, listPayouts, approvePayout, releasePayout, listReviews, resolveReview, listRates, proposeRates, decideRates,
    summary, bordereau, bordereauCsv, listAudit, verifyAudit: () => verifyAudit(db), listDecisions, replay, myNotices,
    setFeed, simulateOutage, advanceClock, setAutoRelease, setState, listStates, createUser, registerMerchant, listUsers,
    createPartner, listPartners, partnerCommissions, login, userById, partnerByKey, quoteView, getQuoteFor,
    listEventsRaw: () => db.prepare("SELECT * FROM readings ORDER BY id DESC LIMIT 20").all(),
  };
}

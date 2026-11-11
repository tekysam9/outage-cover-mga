// Pure business rules: pricing, underwriting routing and the trigger engine.
// No I/O here, so every decision can be replayed from its stored inputs.
// Money is integer cents. Times are epoch milliseconds.

export const UW_RULES = "uw-rules-v1";
export const TRIG_RULES = "trigger-rules-v1";
export const SCORE_AUTO = 70; // auto-bind up to this outage-risk score
export const AREA_CAP_CENTS = 10_000_000; // $100,000 insured per ZIP
export const APPROVAL_CENTS = 1_500_000; // payouts above $15,000 need approval
export const SLA_HOURS = 72;
export const HOUR = 3_600_000;
export const TRIGGER_FACTOR = { 4: 1.35, 8: 1.0, 12: 0.8, 24: 0.55 }; // placeholders
export const SENSOR_DISCOUNT = 0.92; // placeholder

export const CHANNELS = {
  agent: { label: "Independent agent", rate: 0.12 },
  assoc: { label: "Trade association", rate: 0.04 },
  embedded: { label: "Embedded partner (equipment or POS)", rate: 0.075 },
};

export const DEFAULT_TIERS = [
  { h: 4, pct: 0.25 },
  { h: 8, pct: 0.5 },
  { h: 24, pct: 1 },
];

const round2 = (n) => Math.round(n * 100) / 100;

// Placeholder outage-risk score by ZIP. Replace with a scored model and real outage history.
export function riskScore(zip, overrides = {}) {
  if (overrides[zip] != null) return overrides[zip];
  return 20 + ((parseInt(zip, 10) * 7919) % 71);
}

export function validateStore(s) {
  const errors = [];
  if (!s || typeof s !== "object") return ["Store details are required."];
  if (!String(s.name || "").trim()) errors.push("Enter the store name.");
  if (!/^\d{5}$/.test(String(s.zip || "").trim())) errors.push("Enter a 5-digit ZIP code.");
  if (!String(s.utility || "").trim()) errors.push("Enter the store's electric utility.");
  if (!["grocery", "convenience", "pharmacy"].includes(s.type)) errors.push("Choose a store type.");
  if (!/^[A-Z]{2}$/.test(String(s.state || ""))) errors.push("Choose a state.");
  if (!(Number(s.inventoryCents) >= 100_000)) errors.push("Cold-chain inventory must be at least $1,000.");
  return errors;
}

/**
 * Price a quote and decide the route.
 * rates: {version, base, waitH, maxLimitCents, share, tiers}
 * ctx: {stateStatus: open|pending|closed, stateName, areaLimitCents, scoreOverrides}
 * opts: {style: tiered|single, trigger: 4|8|12|24, sensor: bool}
 */
export function priceQuote(store, opts, rates, ctx) {
  const single = opts.style === "single";
  const trig = [4, 8, 12, 24].includes(Number(opts.trigger)) ? Number(opts.trigger) : 12;
  const tiers = single ? [{ h: trig, pct: 1 }] : rates.tiers;
  const limitCents = Math.round(Math.min(store.inventoryCents * rates.share, rates.maxLimitCents));
  const score = riskScore(store.zip, ctx.scoreOverrides);
  const factor = (0.8 + score / 250) * (single ? TRIGGER_FACTOR[trig] : 1) * (opts.sensor ? SENSOR_DISCOUNT : 1);
  const premiumCents = Math.round(limitCents * rates.base * factor);
  const reasons = [];
  let route = "auto";
  if (ctx.stateStatus === "closed") {
    route = "decline";
    reasons.push(`Cover is not available in ${ctx.stateName} yet`);
  } else if (ctx.stateStatus === "pending") {
    route = "waitlist";
    reasons.push(`${ctx.stateName} is later in the launch order, pending counsel and the fronting carrier`);
  } else {
    if (score > SCORE_AUTO) {
      route = "refer";
      reasons.push(`Outage-risk score ${score} is above the auto-bind limit of ${SCORE_AUTO}`);
    }
    const area = ctx.areaLimitCents + limitCents;
    if (area > AREA_CAP_CENTS) {
      route = "refer";
      reasons.push(`Total insured in ZIP ${store.zip} would be $${Math.round(area / 100).toLocaleString("en-US")}, above the $${(AREA_CAP_CENTS / 100).toLocaleString("en-US")} area limit`);
    }
  }
  return {
    limitCents,
    premiumCents,
    score,
    route,
    reasons,
    snap: {
      ruleVersion: UW_RULES,
      rateVersion: rates.version,
      waitH: rates.waitH,
      tiers,
      style: single ? "single" : "tiered",
    },
  };
}

export function commissionCents(premiumCents, rate) {
  return Math.round(premiumCents * rate);
}

/**
 * Trigger engine. Deterministic: same inputs always give the same result.
 * inputs: {boundAt, waitH, limitCents, tiers, readings:[{src,start,end}]}
 * Results: trigger | no-trigger | review
 * Rule: at least two sources must agree on duration (within 30 minutes), otherwise a human reviews.
 */
export function evaluate(inputs) {
  const cs = inputs.boundAt + inputs.waitH * HOUR;
  const rs = inputs.readings;
  const cov = rs.map((r) => Math.max(0, (r.end - Math.max(r.start, cs)) / HOUR));
  const dur = rs.map((r) => (r.end - r.start) / HOUR);
  const agree = [];
  rs.forEach((_, a) => {
    if (rs.some((_, b) => b !== a && Math.abs(dur[a] - dur[b]) <= 0.5)) agree.push(a);
  });
  const tierOf = (c) => inputs.tiers.reduce((t, x) => (c >= x.h ? x : t), null);
  const prop = (c) => {
    const t = tierOf(c);
    return t ? { tierH: t.h, pct: t.pct, amountCents: Math.round(inputs.limitCents * t.pct) } : null;
  };
  const all = round2(Math.min(...cov));
  if (agree.length < 2) {
    const reason = rs.length < 2
      ? "Only one data source reported this outage"
      : `Sources disagree on duration (${rs.map((r, k) => `${r.src}: ${round2(dur[k])} h`).join(", ")})`;
    return { result: "review", reason, coveredH: all, proposed: prop(all) };
  }
  const c = round2(Math.min(...agree.map((k) => cov[k])));
  const note = agree.length < rs.length ? ` (majority of ${rs.length} sources agree)` : "";
  const p = prop(c);
  if (!p) {
    return {
      result: "no-trigger",
      reason: (c === 0 ? "The outage ended inside the waiting period" : `Covered outage time was ${c} h, under the first tier of ${inputs.tiers[0].h} h`) + note,
      coveredH: c,
    };
  }
  return { result: "trigger", reason: `Covered outage of ${c} h met the ${p.tierH}-hour tier${note}`, coveredH: c, tierH: p.tierH, pct: p.pct, amountCents: p.amountCents };
}

export function payoutStatus({ paidAt, bankVerified, amountCents, approved }) {
  if (paidAt != null) return "paid";
  if (!bankVerified) return "hold-bank";
  if (amountCents > APPROVAL_CENTS && !approved) return "needs-approval";
  return "ready";
}

export function sentence(q, zip) {
  const t = q.snap.tiers;
  const L = q.limitCents / 100;
  const m0 = (n) => "$" + Math.round(n).toLocaleString("en-US");
  const pay = t.length === 1
    ? `we pay your full limit (${m0(L)})`
    : `we pay ${Math.round(t[0].pct * 100)}% of your limit (${m0(L * t[0].pct)}); ` +
      t.slice(1).map((x) => `${x.h} hours pays ${Math.round(x.pct * 100)}% (${m0(L * x.pct)})`).join("; ");
  return `You pay $${(q.premiumCents / 100).toFixed(2)} a year. If power at your store (${zip}) is out for ${t[0].h} hours or more after the ${q.snap.waitH}-hour waiting period, ${pay}. No claim form, and we target payment within ${SLA_HOURS} hours of a confirmed outage.`;
}

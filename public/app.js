// Outage Cover portal: vanilla JS, no build step. All text goes through textContent (no innerHTML).
const $ = (sel, el = document) => el.querySelector(sel);
const state = { me: null, csrf: null, view: null, flash: null };

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, "");
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) el.append(k.nodeType ? k : document.createTextNode(String(k)));
  return el;
}

const usd = (c) => "$" + (c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const when = (ms) => new Date(ms).toLocaleString();
const pill = (text, kind = "") => h("span", { class: "pill " + kind }, text);
const statusKind = { paid: "ok", active: "ok", approved: "ok", trigger: "ok", "hold-bank": "warn", "needs-approval": "warn", review: "warn", ready: "info", declined: "bad", rejected: "bad", "no-trigger": "", open: "info" };

async function api(method, path, body) {
  const headers = { "content-type": "application/json" };
  if (state.csrf && method !== "GET") headers["x-csrf-token"] = state.csrf;
  const r = await fetch("/api" + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const ct = r.headers.get("content-type") || "";
  const data = ct.includes("json") ? await r.json() : await r.text();
  if (!r.ok) {
    const err = new Error(data.error || "Request failed");
    err.details = data.details;
    err.status = r.status;
    throw err;
  }
  return data;
}

function flash(kind, text) { state.flash = { kind, text }; }
function flashEl() {
  const f = state.flash; state.flash = null;
  return f ? h("div", { class: "msg " + f.kind }, f.text) : null;
}
async function act(fn, okText) {
  try { await fn(); if (okText) flash("ok", okText); }
  catch (e) { flash("err", [e.message, ...(e.details || [])].join(" ")); }
  render();
}

/* ------------ views by role ------------ */
const NAV = {
  merchant: [["quote", "Get a quote"], ["policies", "My policies"], ["payouts", "Payments"], ["notices", "Notices"]],
  agent: [["quote", "Quote a client"], ["policies", "Client policies"], ["commissions", "Commissions"]],
  underwriting: [["referrals", "Referrals"], ["rates", "Rates"], ["policies", "Policies"]],
  ops: [["overview", "Overview"], ["payouts", "Payouts"], ["reviews", "Reviews"], ["policies", "Policies"]],
  auditor: [["audit", "Audit log"], ["decisions", "Decisions"], ["overview", "Overview"]],
  admin: [["overview", "Overview"], ["referrals", "Referrals"], ["payouts", "Payouts"], ["reviews", "Reviews"], ["rates", "Rates"], ["policies", "Policies"], ["audit", "Audit log"], ["decisions", "Decisions"], ["admin", "Admin"]],
};

const table = (cols, rows, empty = "Nothing here yet.") =>
  rows.length
    ? h("table", {}, h("thead", {}, h("tr", {}, cols.map((c) => h("th", {}, c.t)))), h("tbody", {}, rows.map((r) => h("tr", {}, cols.map((c) => h("td", {}, c.f(r)))))))
    : h("div", { class: "empty" }, empty);

let quoteResult = null;

async function viewQuote() {
  const rates = await api("GET", "/rates");
  const isAgent = state.me.role === "agent";
  const f = h("form", { onsubmit: (e) => { e.preventDefault(); const d = new FormData(e.target); act(async () => {
    quoteResult = await api("POST", "/quotes", {
      store: { name: d.get("name"), type: d.get("type"), state: d.get("state"), zip: d.get("zip"), utility: d.get("utility"), inventoryCents: Math.round(Number(d.get("inventory")) * 100) },
      style: d.get("style"), trigger: Number(d.get("trigger")), sensor: d.get("sensor") === "yes",
    });
  }); } },
    h("div", { class: "row" },
      h("div", {}, h("label", {}, "Store name"), h("input", { name: "name", required: true })),
      h("div", {}, h("label", {}, "Store type"), h("select", { name: "type" }, ["grocery", "convenience", "pharmacy"].map((t) => h("option", { value: t }, t)))),
      h("div", {}, h("label", {}, "State"), h("select", { name: "state" }, rates.states.map((s) => h("option", { value: s.code }, `${s.name}${s.status === "open" ? "" : " (" + s.status + ")"}`)))),
      h("div", {}, h("label", {}, "ZIP code"), h("input", { name: "zip", required: true, inputmode: "numeric", maxlength: 5 })),
      h("div", {}, h("label", {}, "Electric utility"), h("input", { name: "utility", required: true })),
      h("div", {}, h("label", {}, "Cold-chain inventory ($)"), h("input", { name: "inventory", type: "number", min: 1000, step: 100, required: true }))),
    h("div", { class: "row" },
      h("div", {}, h("label", {}, "Payout style"), h("select", { name: "style" }, h("option", { value: "tiered" }, "Tiered (4h / 8h / 24h)"), h("option", { value: "single" }, "Single trigger"))),
      h("div", {}, h("label", {}, "Single trigger (hours)"), h("select", { name: "trigger" }, [4, 8, 12, 24].map((x) => h("option", { value: x, selected: x === 12 }, x + " h")))),
      h("div", {}, h("label", {}, "Store sensor installed"), h("select", { name: "sensor" }, h("option", { value: "no" }, "No"), h("option", { value: "yes" }, "Yes (discount)")))),
    h("div", { class: "actions" }, h("button", { class: "btn", type: "submit" }, "Get my price")));
  const out = [h("div", { class: "card" }, h("h2", {}, "Price your cover"), h("p", { class: "mute" }, "Parametric cover pays a fixed amount when a verified power outage lasts long enough. No claim form."), f)];
  if (quoteResult) {
    const q = quoteResult;
    const kind = { auto: "ok", refer: "warn", waitlist: "warn", decline: "bad" }[q.route];
    out.push(h("div", { class: "card" },
      h("h2", {}, `Quote ${q.id} `, pill(q.route === "auto" ? "ready to bind" : q.route, kind)),
      h("div", { class: "grid" }, stat("Premium / year", usd(q.premiumCents)), stat("Limit", usd(q.limitCents)), stat("Risk score", q.score), stat("Waiting period", q.snap.waitH + " h")),
      h("p", {}, q.sentence),
      q.reasons.length ? h("div", { class: "msg info" }, q.reasons.join(". ")) : null,
      h("p", { class: "mute mono" }, `${q.snap.ruleVersion} · ${q.snap.rateVersion}`),
      h("div", { class: "actions" },
        q.route === "auto" ? h("button", { class: "btn alt", onclick: () => act(async () => { await api("POST", `/quotes/${q.id}/bind`); quoteResult = null; state.view = "policies"; }, "Policy bound.") }, "Buy now") : null,
        q.route === "refer" ? h("button", { class: "btn", onclick: () => act(async () => { await api("POST", `/quotes/${q.id}/refer`); quoteResult = null; }, "Sent to underwriting. We will follow up.") }, "Send for review") : null)));
  }
  return out;
}
const stat = (label, value) => h("div", { class: "stat" }, h("b", {}, String(value)), h("span", {}, label));

async function viewPolicies() {
  const ps = await api("GET", "/policies");
  const m = state.me.role === "merchant";
  const acts = (p) => (m && !p.bankVerified ? h("button", { class: "btn sm ghost", onclick: () => act(() => api("POST", "/bank/verify"), "Bank account verified (demo).") }, "Verify bank") : null);
  return h("div", { class: "card" }, h("h2", {}, "Policies"), table([
    { t: "Policy", f: (p) => p.id }, { t: "Store", f: (p) => `${p.merchant} · ${p.store.zip}` },
    { t: "Limit", f: (p) => usd(p.limitCents) }, { t: "Premium", f: (p) => usd(p.premiumCents) },
    { t: "Cover", f: (p) => (p.covered ? pill("in force", "ok") : pill("waiting until " + when(p.coverStart), "warn")) },
    { t: "Rates", f: (p) => p.snap.rateVersion }, { t: m ? "Bank" : "Partner", f: (p) => (m ? (p.bankVerified ? pill("verified", "ok") : acts(p)) : p.partner?.name || "Direct") },
  ], ps, "No policies yet."));
}

async function viewPayouts() {
  const ps = await api("GET", "/payouts");
  const staff = ["ops", "admin"].includes(state.me.role);
  const label = { "hold-bank": "held: bank not verified", "needs-approval": "needs approval", ready: "ready", paid: "paid" };
  return h("div", { class: "card" }, h("h2", {}, "Payouts"), table([
    { t: "Payout", f: (p) => p.id }, { t: "Policy", f: (p) => p.policyId }, { t: "Merchant", f: (p) => p.merchant },
    { t: "Amount", f: (p) => usd(p.amountCents) }, { t: "Status", f: (p) => pill(label[p.status], statusKind[p.status]) },
    { t: "Age", f: (p) => `${p.ageHours} h` + (p.status !== "paid" && p.ageHours > p.slaHours ? " (late)" : "") },
    { t: "", f: (p) => staff && p.status === "needs-approval" ? h("button", { class: "btn sm", onclick: () => act(() => api("POST", `/payouts/${p.id}/approve`), "Approved.") }, "Approve")
        : staff && p.status === "ready" ? h("button", { class: "btn sm", onclick: () => act(() => api("POST", `/payouts/${p.id}/release`), "Released.") }, "Release") : null },
  ], ps, "No payouts yet."));
}

async function viewNotices() {
  const ns = await api("GET", "/notices");
  return h("div", { class: "card" }, h("h2", {}, "Notices"), table([{ t: "When", f: (n) => when(n.created_at) }, { t: "Message", f: (n) => n.text }], ns, "No notices yet."));
}

async function viewCommissions() {
  const c = await api("GET", "/partner/commissions");
  return h("div", { class: "card" }, h("h2", {}, "Commissions"),
    h("div", { class: "grid" }, stat("Policies", c.policies), stat("Premium", usd(c.premiumCents)), stat("Commission earned", usd(c.commissionCents))),
    table([{ t: "Policy", f: (r) => r.id }, { t: "Merchant", f: (r) => r.merchant }, { t: "Premium", f: (r) => usd(r.premium_cents) }, { t: "Commission", f: (r) => usd(r.commission_cents) }], c.rows, "No bound policies yet."));
}

async function viewReferrals() {
  const rs = await api("GET", "/referrals?status=open");
  return h("div", { class: "card" }, h("h2", {}, "Open referrals"), table([
    { t: "Referral", f: (r) => r.id }, { t: "Store", f: (r) => `${r.store.name} · ${r.store.zip}` }, { t: "Limit", f: (r) => usd(r.limitCents) },
    { t: "Why", f: (r) => r.reasons.join("; ") },
    { t: "", f: (r) => h("div", { class: "actions" }, h("button", { class: "btn sm", onclick: () => act(() => api("POST", `/referrals/${r.id}/approve`), "Approved and bound.") }, "Approve"), h("button", { class: "btn sm ghost", onclick: () => act(() => api("POST", `/referrals/${r.id}/decline`), "Declined.") }, "Decline")) },
  ], rs, "No referrals waiting."));
}

async function viewReviews() {
  const rs = await api("GET", "/reviews");
  return h("div", { class: "card" }, h("h2", {}, "Outage reviews"), h("p", { class: "mute" }, "Sources disagreed or only one reported. Pay at the conservative reading or reject."),
    table([
      { t: "Review", f: (r) => r.id }, { t: "Policy", f: (r) => `${r.policyId} · ${r.merchant}` }, { t: "Why", f: (r) => r.result.reason },
      { t: "Conservative payout", f: (r) => (r.result.proposed ? usd(r.result.proposed.amountCents) : "none") },
      { t: "", f: (r) => h("div", { class: "actions" }, r.result.proposed ? h("button", { class: "btn sm", onclick: () => act(() => api("POST", `/reviews/${r.id}/pay`), "Paid at conservative reading.") }, "Pay") : null, h("button", { class: "btn sm ghost", onclick: () => act(() => api("POST", `/reviews/${r.id}/reject`), "Rejected.") }, "Reject")) },
    ], rs, "No reviews waiting."));
}

async function viewRates() {
  const r = await api("GET", "/rates/all");
  const c = r.current;
  const f = h("form", { onsubmit: (e) => { e.preventDefault(); const d = new FormData(e.target); act(() => api("POST", "/rates/proposals", { base: Number(d.get("base")) / 100, waitH: Number(d.get("waitH")), maxLimitCents: Math.round(Number(d.get("max")) * 100) }), "Proposal created. A different person must approve it."); } },
    h("div", { class: "row" }, h("div", {}, h("label", {}, "Base rate (% of limit)"), h("input", { name: "base", type: "number", step: "0.1", value: (c.base * 100).toFixed(1) })),
      h("div", {}, h("label", {}, "Waiting period (hours)"), h("input", { name: "waitH", type: "number", value: c.waitH })),
      h("div", {}, h("label", {}, "Max limit ($)"), h("input", { name: "max", type: "number", value: c.maxLimitCents / 100 }))),
    h("div", { class: "actions" }, h("button", { class: "btn", type: "submit" }, "Propose change")));
  return [
    h("div", { class: "card" }, h("h2", {}, `Current: ${c.version}`), f),
    h("div", { class: "card" }, h("h2", {}, "Proposals (two-person approval)"), table([
      { t: "#", f: (p) => "RP-" + p.id }, { t: "Base", f: (p) => (p.base * 100).toFixed(1) + "%" }, { t: "Wait", f: (p) => p.waitH + " h" }, { t: "Proposed by", f: (p) => p.proposer },
      { t: "Status", f: (p) => pill(p.status, statusKind[p.status]) },
      { t: "", f: (p) => p.status === "open" ? (p.proposedBy === state.me.id ? h("span", { class: "mute" }, "Waiting for a second approver") : h("div", { class: "actions" }, h("button", { class: "btn sm", onclick: () => act(() => api("POST", `/rates/proposals/${p.id}/approve`), "Approved.") }, "Approve"), h("button", { class: "btn sm ghost", onclick: () => act(() => api("POST", `/rates/proposals/${p.id}/reject`), "Rejected.") }, "Reject"))) : null },
    ], r.proposals, "No proposals.")),
    h("div", { class: "card" }, h("h2", {}, "Version history"), table([{ t: "Version", f: (v) => v.version }, { t: "Base", f: (v) => (v.base * 100).toFixed(1) + "%" }, { t: "Wait", f: (v) => v.waitH + " h" }, { t: "Effective", f: (v) => when(v.effectiveAt) }, { t: "Approved by", f: (v) => v.approvedBy || "initial" }], r.versions)),
  ];
}

async function viewOverview() {
  const s = await api("GET", "/summary");
  const staff = ["ops", "admin"].includes(state.me.role);
  const cards = [h("div", { class: "card" }, h("h2", {}, "Overview"), h("div", { class: "grid" },
    stat("Active policies", s.policies), stat("Written premium", usd(s.writtenPremiumCents)), stat("Paid out", usd(s.paidCents)),
    stat("Loss ratio", s.lossRatio == null ? "n/a" : s.lossRatio + "%"), stat("Avg hours to pay", s.avgHoursToPay ?? "n/a"),
    stat("Open payouts", s.openPayouts), stat("Late (>72h)", s.latePayouts), stat("Open reviews", s.openReviews)),
    staff ? h("div", { class: "actions" }, h("a", { class: "btn ghost sm", style: "text-decoration:none;padding:5px 12px", href: "/api/bordereau.csv" }, "Download bordereau (CSV)")) : null)];
  if (staff) {
    cards.push(h("div", { class: "card" }, h("h2", {}, "Data feeds"),
      h("div", { class: "actions" }, ["A", "B"].map((k) => h("button", { class: "btn sm " + (s.feeds[k] ? "" : "alt"), onclick: () => act(() => api("POST", `/admin/feeds/${k}`, { online: !s.feeds[k] })) }, `Feed ${k}: ${s.feeds[k] ? "online" : "silent"} (click to toggle)`))),
      h("p", { class: "mute" }, "At least two sources must agree before a payout is made automatically; otherwise a person reviews it.")));
    if (s.demo) {
      cards.push(h("div", { class: "card" }, h("h2", {}, "Demo tools"), h("p", { class: "mute" }, "Demo mode only. Move the clock past the waiting period, then simulate an outage."),
        h("form", { onsubmit: (e) => { e.preventDefault(); const d = new FormData(e.target); act(async () => { const r = await api("POST", "/admin/simulate-outage", { zip: d.get("zip"), durationH: Number(d.get("dur")), bMode: d.get("b"), sMode: d.get("s") }); flash("ok", `Outage ${r.event.id}: ` + (r.decisions.map((x) => `${x.policyId} ${x.result}`).join(", ") || "no policies in that ZIP")); }); } },
          h("div", { class: "row" }, h("div", {}, h("label", {}, "ZIP"), h("input", { name: "zip", required: true })), h("div", {}, h("label", {}, "Duration (hours)"), h("input", { name: "dur", type: "number", value: 10, step: "0.5" })),
            h("div", {}, h("label", {}, "Feed B"), h("select", { name: "b" }, h("option", { value: "agree" }, "agrees"), h("option", { value: "early" }, "reports early recovery"), h("option", { value: "silent" }, "silent"))),
            h("div", {}, h("label", {}, "Store sensor"), h("select", { name: "s" }, h("option", { value: "agree" }, "agrees"), h("option", { value: "silent" }, "silent")))),
          h("div", { class: "actions" }, h("button", { class: "btn", type: "submit" }, "Simulate outage"),
            [24, 72].map((x) => h("button", { class: "btn ghost", type: "button", onclick: () => act(() => api("POST", "/admin/advance-clock", { hours: x }), `Clock moved ${x} hours ahead.`) }, `+${x} h`))))));
    }
  }
  return cards;
}

async function viewAudit() {
  const [rows, v] = await Promise.all([api("GET", "/audit?limit=200"), state.me.role === "auditor" || state.me.role === "admin" ? api("GET", "/audit/verify") : Promise.resolve(null)]);
  return h("div", { class: "card" }, h("h2", {}, "Audit log"),
    v ? h("div", { class: "msg " + (v.ok ? "ok" : "err") }, v.ok ? `Hash chain intact (${v.checked} entries).` : `Chain broken at entry ${v.brokenAt}.`) : null,
    table([{ t: "#", f: (r) => r.seq }, { t: "When", f: (r) => when(r.at) }, { t: "Who", f: (r) => r.actor }, { t: "Event", f: (r) => r.type }, { t: "Detail", f: (r) => r.detail }, { t: "Rules", f: (r) => h("span", { class: "mono" }, r.version) }], rows));
}

async function viewDecisions() {
  const ds = await api("GET", "/decisions");
  const out = h("div", {});
  return [h("div", { class: "card" }, h("h2", {}, "Decisions"), h("p", { class: "mute" }, "Every payout decision is made by fixed, versioned rules. Replay re-runs the stored inputs and checks the result is identical."),
    table([{ t: "Decision", f: (d) => d.id }, { t: "Policy", f: (d) => d.policyId }, { t: "Event", f: (d) => d.eventId }, { t: "Result", f: (d) => pill(d.result, statusKind[d.result]) },
      { t: "", f: (d) => h("button", { class: "btn sm ghost", onclick: async () => { const r = await api("GET", `/decisions/${d.id}/replay`); out.replaceChildren(h("div", { class: "card" }, h("h2", {}, `Replay ${r.id}`), h("div", { class: "msg " + (r.matches ? "ok" : "err") }, r.matches ? "Replay matches the stored decision." : "MISMATCH: replay differs."), h("p", { class: "mono" }, `${r.rule} · ${r.replayed.reason}`))); } }, "Replay") }], ds)), out];
}

async function viewAdmin() {
  const [users, partners, rates] = await Promise.all([api("GET", "/admin/users"), api("GET", "/admin/partners"), api("GET", "/rates")]);
  const s = await api("GET", "/summary");
  const newKey = state.newKey; state.newKey = null;
  return [
    h("div", { class: "card" }, h("h2", {}, "State availability"), table([{ t: "State", f: (x) => x.name }, { t: "Status", f: (x) => pill(x.status, x.status === "open" ? "ok" : x.status === "pending" ? "warn" : "bad") },
      { t: "", f: (x) => h("select", { onchange: (e) => act(() => api("PUT", `/admin/states/${x.code}`, { status: e.target.value })) }, ["open", "pending", "closed"].map((o) => h("option", { value: o, selected: o === x.status }, o))) }], rates.states)),
    h("div", { class: "card" }, h("h2", {}, "Payout settings"), h("div", { class: "actions" }, h("button", { class: "btn sm " + (s.autoRelease ? "" : "alt"), onclick: () => act(() => api("POST", "/admin/auto-release", { on: !s.autoRelease })) }, `Auto-release payouts under the approval limit: ${s.autoRelease ? "on" : "off"}`))),
    h("div", { class: "card" }, h("h2", {}, "Partners"), newKey ? h("div", { class: "msg info" }, "API key (shown once): ", h("span", { class: "mono" }, newKey)) : null,
      table([{ t: "Name", f: (p) => p.name }, { t: "Channel", f: (p) => p.channel }, { t: "Commission", f: (p) => (p.rate * 100).toFixed(1) + "%" }], partners),
      h("form", { onsubmit: (e) => { e.preventDefault(); const d = new FormData(e.target); act(async () => { const r = await api("POST", "/admin/partners", { name: d.get("name"), channel: d.get("channel") }); state.newKey = r.apiKey; }); } },
        h("div", { class: "row" }, h("div", {}, h("label", {}, "Partner name"), h("input", { name: "name", required: true })), h("div", {}, h("label", {}, "Channel"), h("select", { name: "channel" }, h("option", { value: "agent" }, "Agent (12%)"), h("option", { value: "assoc" }, "Association (4%)"), h("option", { value: "embedded" }, "Embedded (7.5%)")))),
        h("div", { class: "actions" }, h("button", { class: "btn", type: "submit" }, "Add partner")))),
    h("div", { class: "card" }, h("h2", {}, "Users"), table([{ t: "Email", f: (u) => u.email }, { t: "Name", f: (u) => u.name }, { t: "Role", f: (u) => pill(u.role, "info") }], users),
      h("form", { onsubmit: (e) => { e.preventDefault(); const d = new FormData(e.target); act(() => api("POST", "/admin/users", { email: d.get("email"), name: d.get("name"), role: d.get("role"), password: d.get("pw"), partnerId: d.get("partner") ? Number(d.get("partner")) : undefined, merchantName: d.get("mname") }), "User created."); } },
        h("div", { class: "row" }, h("div", {}, h("label", {}, "Email"), h("input", { name: "email", type: "email", required: true })), h("div", {}, h("label", {}, "Name"), h("input", { name: "name", required: true })),
          h("div", {}, h("label", {}, "Role"), h("select", { name: "role" }, ["merchant", "agent", "underwriting", "ops", "auditor", "admin"].map((r) => h("option", { value: r }, r)))),
          h("div", {}, h("label", {}, "Password (10+ chars)"), h("input", { name: "pw", type: "password", minlength: 10, required: true })),
          h("div", {}, h("label", {}, "Partner (agents)"), h("select", { name: "partner" }, h("option", { value: "" }, "none"), partners.map((p) => h("option", { value: p.id }, p.name)))),
          h("div", {}, h("label", {}, "Business name (merchants)"), h("input", { name: "mname" }))),
        h("div", { class: "actions" }, h("button", { class: "btn", type: "submit" }, "Add user")))),
  ];
}

const VIEWS = { quote: viewQuote, policies: viewPolicies, payouts: viewPayouts, notices: viewNotices, commissions: viewCommissions, referrals: viewReferrals, reviews: viewReviews, rates: viewRates, overview: viewOverview, audit: viewAudit, decisions: viewDecisions, admin: viewAdmin };

/* ------------ auth screens + shell ------------ */
function authScreen(demo) {
  let mode = "login";
  const box = h("div", { class: "auth" });
  const draw = () => {
    const reg = mode === "register";
    box.replaceChildren(h("div", { class: "card" },
      h("div", { class: "brand" }, "Outage", h("b", {}, "·"), h("i", {}, "Cover")),
      h("h1", {}, reg ? "Create your account" : "Sign in"),
      h("form", { onsubmit: async (e) => { e.preventDefault(); const d = new FormData(e.target);
        try {
          if (reg) await api("POST", "/register", { email: d.get("email"), name: d.get("name"), password: d.get("password"), businessName: d.get("business") });
          const r = await api("POST", "/login", { email: d.get("email"), password: d.get("password") });
          state.csrf = r.csrf; state.view = null; await boot();
        } catch (err) { $("#autherr").replaceChildren(h("div", { class: "msg err" }, [err.message, ...(err.details || [])].join(" "))); } } },
        reg ? [h("label", {}, "Your name"), h("input", { name: "name", required: true }), h("label", {}, "Business name"), h("input", { name: "business", required: true })] : null,
        h("label", {}, "Email"), h("input", { name: "email", type: "email", required: true, autocomplete: "username" }),
        h("label", {}, "Password"), h("input", { name: "password", type: "password", required: true, minlength: reg ? 10 : 1, autocomplete: reg ? "new-password" : "current-password" }),
        h("div", { id: "autherr" }),
        h("div", { class: "actions" }, h("button", { class: "btn", type: "submit" }, reg ? "Create account" : "Sign in"), h("button", { class: "btn ghost", type: "button", onclick: () => { mode = reg ? "login" : "register"; draw(); } }, reg ? "I have an account" : "New merchant? Register"))),
      demo && !reg ? h("p", { class: "mute" }, "Demo accounts (password demo-password-1): merchant@, agent@, uw1@, uw2@, ops@, auditor@, admin@ demo.test") : null,
      h("p", { class: "mute" }, h("a", { href: "/" }, "About Outage Cover"))));
  };
  draw();
  return box;
}

async function render() {
  const root = $("#root");
  if (!state.me || state.me.anonymous) { root.replaceChildren(authScreen(state.me?.demo)); return; }
  const nav = NAV[state.me.role];
  if (!state.view || !nav.some(([k]) => k === state.view)) state.view = nav[0][0];
  const main = h("main", {});
  root.replaceChildren(
    h("div", { class: "top" }, h("div", { class: "brand" }, "Outage", h("b", {}, "·"), h("i", {}, "Cover")), state.me.demo ? pill("demo mode", "warn") : null,
      h("div", { class: "who" }, `${state.me.name} · ${state.me.role} `, h("button", { class: "btn ghost sm", onclick: async () => { await api("POST", "/logout"); state.me = null; state.csrf = null; quoteResult = null; await boot(); } }, "Sign out"))),
    h("div", { class: "layout" }, h("nav", { class: "side" }, nav.map(([k, label]) => h("button", { class: k === state.view ? "on" : "", onclick: () => { state.view = k; render(); } }, label))), main));
  const fl = flashEl();
  try { main.replaceChildren(...[h("h1", {}, nav.find(([k]) => k === state.view)[1]), fl, await VIEWS[state.view]()].flat().filter(Boolean)); }
  catch (e) { if (e.status === 401) { state.me = null; return boot(); } main.replaceChildren(h("div", { class: "msg err" }, e.message)); }
}

async function boot() {
  const me = await api("GET", "/me");
  state.me = me;
  if (!me.anonymous) { const c = await api("GET", "/csrf"); state.csrf = c.csrf; }
  render();
}
boot();

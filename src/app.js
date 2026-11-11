import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { createServices, HttpError } from "./services.js";
import { LoginThrottle, parseCookies, readToken, signToken } from "./auth.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json", ".png": "image/png", ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8" };
const SESSION_MS = 8 * 3_600_000;
const STAFF = ["underwriting", "ops", "auditor", "admin"];

export function createApp({ db, payments, config = {}, nowFn = Date.now }) {
  const secret = config.secret || crypto.randomBytes(32).toString("hex");
  const svc = createServices({ db, payments, config, nowFn });
  const throttle = new LoginThrottle(nowFn);
  const secureCookie = config.secureCookie ?? false;

  const need = (user, ...roles) => {
    if (!user) throw new HttpError(401, "Sign in required.");
    if (!roles.includes(user.role)) throw new HttpError(403, "Your role cannot do this.");
  };

  /** route table: [method, regex, handler(ctx)] */
  const routes = [];
  const R = (method, pattern, fn) => routes.push([method, new RegExp("^" + pattern.replace(/:(\w+)/g, "(?<$1>[^/]+)") + "$"), fn]);

  R("GET", "/api/health", () => ({ ok: true, demo: !!config.demo, audit: svc.verifyAudit().ok }));
  R("GET", "/api/me", ({ user }) => (user ? { id: user.id, name: user.name, email: user.email, role: user.role, merchantId: user.merchant_id, partnerId: user.partner_id, demo: !!config.demo } : { anonymous: true }));
  R("GET", "/api/rates", () => ({ current: svc.currentRates(), states: svc.listStates() }));

  R("POST", "/api/register", ({ body }) => svc.registerMerchant(body));
  R("POST", "/api/quotes", ({ user, body }) => (need(user, "merchant", "agent"), svc.createQuote(user, body)));
  R("GET", "/api/quotes/:id", ({ user, params }) => (need(user, "merchant", "agent", "admin", "underwriting"), svc.quoteView(svc.getQuoteFor(user, params.id))));
  R("POST", "/api/quotes/:id/bind", ({ user, params }) => (need(user, "merchant", "agent"), svc.bindQuote(user, params.id)));
  R("POST", "/api/quotes/:id/refer", ({ user, params }) => (need(user, "merchant", "agent"), svc.referQuote(user, params.id)));

  R("GET", "/api/policies", ({ user }) => (need(user, "merchant", "agent", ...STAFF), svc.listPolicies(user)));
  R("GET", "/api/notices", ({ user }) => (need(user, "merchant"), svc.myNotices(user)));
  R("POST", "/api/bank/verify", ({ user }) => (need(user, "merchant"), svc.verifyBank(user)));
  R("GET", "/api/partner/commissions", ({ user }) => (need(user, "agent"), svc.partnerCommissions(user)));

  R("GET", "/api/referrals", ({ user, query }) => (need(user, "underwriting", "admin"), svc.listReferrals(query.status)));
  R("POST", "/api/referrals/:id/approve", ({ user, params }) => (need(user, "underwriting", "admin"), svc.decideReferral(user, params.id, true)));
  R("POST", "/api/referrals/:id/decline", ({ user, params }) => (need(user, "underwriting", "admin"), svc.decideReferral(user, params.id, false)));

  R("GET", "/api/payouts", ({ user }) => (need(user, "merchant", "ops", "admin", "auditor", "underwriting"), svc.listPayouts(user)));
  R("POST", "/api/payouts/:id/approve", ({ user, params }) => (need(user, "ops", "admin"), svc.approvePayout(user, params.id)));
  R("POST", "/api/payouts/:id/release", ({ user, params }) => (need(user, "ops", "admin"), svc.releasePayout(user, params.id)));

  R("GET", "/api/reviews", ({ user, query }) => (need(user, "ops", "admin", "underwriting"), svc.listReviews(query.status || "open")));
  R("POST", "/api/reviews/:id/pay", ({ user, params }) => (need(user, "ops", "admin"), svc.resolveReview(user, params.id, "pay")));
  R("POST", "/api/reviews/:id/reject", ({ user, params }) => (need(user, "ops", "admin"), svc.resolveReview(user, params.id, "reject")));

  R("GET", "/api/summary", ({ user }) => (need(user, ...STAFF), svc.summary()));
  R("GET", "/api/bordereau.csv", ({ user }) => (need(user, "ops", "admin", "auditor"), { __csv: svc.bordereauCsv(), name: "bordereau.csv" }));
  R("GET", "/api/audit", ({ user, query }) => (need(user, "auditor", "admin", "ops", "underwriting"), svc.listAudit(query)));
  R("GET", "/api/audit/verify", ({ user }) => (need(user, "auditor", "admin"), svc.verifyAudit()));
  R("GET", "/api/decisions", ({ user }) => (need(user, "auditor", "admin", "ops"), svc.listDecisions()));
  R("GET", "/api/decisions/:id/replay", ({ user, params }) => (need(user, "auditor", "admin", "ops"), svc.replay(params.id)));

  R("GET", "/api/rates/all", ({ user }) => (need(user, "underwriting", "admin", "auditor"), svc.listRates()));
  R("POST", "/api/rates/proposals", ({ user, body }) => (need(user, "underwriting", "admin"), svc.proposeRates(user, body)));
  R("POST", "/api/rates/proposals/:id/approve", ({ user, params }) => (need(user, "underwriting", "admin"), svc.decideRates(user, Number(params.id), true)));
  R("POST", "/api/rates/proposals/:id/reject", ({ user, params }) => (need(user, "underwriting", "admin"), svc.decideRates(user, Number(params.id), false)));

  R("GET", "/api/admin/users", ({ user }) => (need(user, "admin"), svc.listUsers()));
  R("POST", "/api/admin/users", ({ user, body }) => (need(user, "admin"), svc.createUser(user, body)));
  R("GET", "/api/admin/partners", ({ user }) => (need(user, "admin"), svc.listPartners()));
  R("POST", "/api/admin/partners", ({ user, body }) => (need(user, "admin"), svc.createPartner(user, body)));
  R("PUT", "/api/admin/states/:code", ({ user, params, body }) => (need(user, "admin"), svc.setState(user, params.code, body?.status)));
  R("POST", "/api/admin/feeds/:feed", ({ user, params, body }) => (need(user, "admin", "ops"), svc.setFeed(user, params.feed, !!body?.online)));
  R("POST", "/api/admin/auto-release", ({ user, body }) => (need(user, "admin"), svc.setAutoRelease(user, !!body?.on)));
  R("POST", "/api/admin/simulate-outage", ({ user, body }) => (need(user, "admin", "ops"), svc.simulateOutage(user, body)));
  R("POST", "/api/admin/advance-clock", ({ user, body }) => (need(user, "admin", "ops"), svc.advanceClock(user, body?.hours)));

  // Machine endpoint for outage-data feed aggregators (shared key).
  R("POST", "/api/feed/outages", ({ body, req }) => {
    if (!config.feedKey || req.headers["x-feed-key"] !== config.feedKey) throw new HttpError(401, "Invalid feed key.");
    return svc.ingestOutage("Feed aggregator", body);
  });

  const json = (res, status, data, extra = {}) => {
    const buf = Buffer.from(JSON.stringify(data));
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...secHeaders(), ...extra });
    res.end(buf);
  };
  const secHeaders = () => ({
    "x-content-type-options": "nosniff", "x-frame-options": "DENY", "referrer-policy": "no-referrer",
    "content-security-policy": "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'",
  });

  async function readBody(req) {
    const chunks = [];
    let n = 0;
    for await (const c of req) {
      n += c.length;
      if (n > 256_000) throw new HttpError(413, "Request too large.");
      chunks.push(c);
    }
    if (!n) return {};
    try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { throw new HttpError(400, "Body must be JSON."); }
  }

  function session(req) {
    const auth = req.headers.authorization || "";
    if (auth.startsWith("Bearer ")) {
      const u = svc.partnerByKey(auth.slice(7).trim());
      if (u) return { user: u, csrf: null, bearer: true };
      return { user: null };
    }
    const tok = parseCookies(req.headers.cookie || "").sid;
    const p = readToken(tok, secret, nowFn());
    if (!p) return { user: null };
    const user = svc.userById(p.uid);
    return user ? { user, csrf: p.csrf } : { user: null };
  }

  async function api(req, res, url) {
    const { user, csrf, bearer } = session(req);
    const method = req.method;
    // login/logout handled here (need cookie control)
    if (method === "POST" && url.pathname === "/api/login") {
      const body = await readBody(req);
      const key = String(body.email || "").toLowerCase();
      if (throttle.blocked(key)) throw new HttpError(429, "Too many attempts. Try again in a few minutes.");
      const u = svc.login(body.email, body.password);
      if (!u) { throttle.fail(key); throw new HttpError(401, "Email or password is incorrect."); }
      throttle.ok(key);
      const token = signToken({ uid: u.id, csrf: crypto.randomBytes(16).toString("hex"), exp: nowFn() + SESSION_MS }, secret);
      const csrfTok = readToken(token, secret, nowFn()).csrf;
      return json(res, 200, { ok: true, role: u.role, name: u.name, csrf: csrfTok }, { "set-cookie": `sid=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}${secureCookie ? "; Secure" : ""}` });
    }
    if (method === "POST" && url.pathname === "/api/logout") {
      return json(res, 200, { ok: true }, { "set-cookie": "sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0" });
    }
    if (method === "GET" && url.pathname === "/api/csrf") {
      return json(res, 200, { csrf: csrf || null });
    }
    for (const [m, re, fn] of routes) {
      if (m !== method) continue;
      const match = re.exec(url.pathname);
      if (!match) continue;
      if (method !== "GET" && user && !bearer && req.headers["x-csrf-token"] !== csrf) throw new HttpError(403, "Missing or invalid CSRF token.");
      const out = await fn({ req, user, params: match.groups || {}, query: Object.fromEntries(url.searchParams), body: method === "GET" ? {} : await readBody(req) });
      if (out && out.__csv !== undefined) {
        res.writeHead(200, { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${out.name}"`, ...secHeaders() });
        return res.end(out.__csv);
      }
      return json(res, 200, out ?? {});
    }
    throw new HttpError(404, "Not found.");
  }

  function serveStatic(req, res, url) {
    let pathname = decodeURIComponent(url.pathname);
    let base, rel;
    if (pathname === "/app" || pathname.startsWith("/app/")) { base = path.join(ROOT, "public"); rel = pathname.slice(4) || "/"; }
    else { base = path.join(ROOT, "site"); rel = pathname; }
    if (rel.endsWith("/")) rel += "index.html";
    if (!path.extname(rel)) rel += ".html";
    const file = path.normalize(path.join(base, rel));
    if (!file.startsWith(base + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404, { "content-type": "text/html; charset=utf-8", ...secHeaders() });
      return res.end("<!doctype html><title>Not found</title><p>Page not found. <a href=\"/\">Home</a>");
    }
    res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream", "cache-control": "no-cache", ...secHeaders() });
    fs.createReadStream(file).pipe(res);
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname.startsWith("/api/")) return await api(req, res, url);
      if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "Method not allowed.");
      return serveStatic(req, res, url);
    } catch (e) {
      if (e instanceof HttpError) return json(res, e.status, { error: e.message, details: e.details });
      console.error(e);
      return json(res, 500, { error: "Something went wrong on our side." });
    }
  });

  return { server, svc };
}

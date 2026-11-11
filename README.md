# Outage Cover

Business portal and marketing website for a managing general agent (MGA) selling parametric power-outage cover to independent grocers, convenience stores and pharmacies (Texas first).

> **Prototype.** Not an insurer, not licensed, not in market. Rates, risk scores and trigger factors are placeholders. Payments use a mock provider. Real operation needs a fronting carrier, reinsurance, state approval and a real payments and outage-data provider.

## What is in it

| Area | Where |
|---|---|
| Rules engine (pricing, underwriting routing, trigger decision, payout status) | `src/engine.js` (pure, deterministic) |
| Services (quotes, binding, referrals, outage ingestion, payouts, reviews, rates, reports) | `src/services.js` |
| HTTP API, sessions, CSRF, Bearer partner keys | `src/app.js` |
| Storage (SQLite via `node:sqlite`) and hash-chained audit log | `src/db.js`, `src/audit.js` |
| Portal (merchant, agent, underwriting, ops, auditor, admin) | `public/` served at `/app/` |
| Marketing website | `site/` served at `/` |
| Tests (unit and end-to-end over HTTP) | `test/` |

Zero npm dependencies. Needs Node 22.13 or newer.

## Run

```bash
npm run dev            # demo mode: in-memory data, demo users, outage simulator
npm test
```

Open http://localhost:3000 (website) and http://localhost:3000/app/ (portal).
Demo users, password `demo-password-1`: `merchant@`, `agent@`, `uw1@`, `uw2@`, `ops@`, `auditor@`, `admin@` + `demo.test`.

Try it: sign in as the merchant, quote a Texas ZIP, buy. Sign in as ops, use **Demo tools** to move the clock 30 h and simulate an outage in that ZIP. The first payout is held until the merchant verifies their bank; verifying releases it.

### Production-style run

```bash
SESSION_SECRET=$(openssl rand -hex 32) ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='a-long-password' \
FEED_KEY=$(openssl rand -hex 16) SECURE_COOKIE=1 DB_PATH=data/outage.db npm start
```

## Rules implemented

- Auto-bind if risk score <= 70 and insured per ZIP <= $100,000; otherwise referral to underwriting. Pending states waitlist, closed states decline.
- Limit = 50% of cold-chain inventory, up to $50,000. Tiers 4h/8h/24h pay 25%/50%/100%, or a single trigger. 24 h waiting period.
- Payout decided only by `trigger-rules-v1`: at least two sources must agree within 30 minutes on duration, otherwise human review at the conservative reading. Duplicate events never pay twice.
- First payout held until bank verified; payouts over $15,000 need approval; 72 h payment target tracked.
- Rate changes need a proposer and a different approver; policies keep the rate version they were sold on.
- Hash-chained audit log with verification, and decision replay.
- Partner commissions: agent 12%, association 4%, embedded 7.5%. Partners can use a Bearer API key.

## API sketch

`POST /api/login`, `GET /api/me`, `POST /api/quotes`, `POST /api/quotes/:id/bind`, `POST /api/quotes/:id/refer`, `GET /api/policies`, `GET /api/payouts`, `POST /api/feed/outages` (header `x-feed-key`), `GET /api/bordereau.csv`, `GET /api/audit/verify`. Cookie sessions need the `x-csrf-token` header on writes; partner keys use `Authorization: Bearer pk_...`.

## CI

`.github/workflows/ci.yml` runs the tests, the site link check and a boot smoke test. `pages.yml` publishes `site/` to GitHub Pages (static marketing pages only; the portal needs the Node server, see `Dockerfile`).

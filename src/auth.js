import crypto from "node:crypto";

export const ROLES = ["merchant", "agent", "underwriting", "ops", "auditor", "admin"];

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(pw, salt, 32).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(pw, stored) {
  const [salt, hash] = String(stored).split(":");
  if (!salt || !hash) return false;
  const a = Buffer.from(crypto.scryptSync(pw, salt, 32).toString("hex"));
  const b = Buffer.from(hash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

// Stateless signed session token: base64url(payload).hmac
export function signToken(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const mac = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${mac}`;
}

export function readToken(token, secret, now) {
  if (!token || !token.includes(".")) return null;
  const [body, mac] = token.split(".");
  const good = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  const a = Buffer.from(mac);
  const b = Buffer.from(good);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString());
    return p.exp > now ? p : null;
  } catch {
    return null;
  }
}

export function parseCookies(header = "") {
  const out = {};
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// Simple in-memory login throttle: 5 failures per email locks it for 5 minutes.
export class LoginThrottle {
  constructor(now = Date.now) {
    this.now = now;
    this.map = new Map();
  }
  blocked(key) {
    const e = this.map.get(key);
    return !!(e && e.until > this.now());
  }
  fail(key) {
    const e = this.map.get(key) || { n: 0, until: 0 };
    e.n += 1;
    if (e.n >= 5) {
      e.until = this.now() + 5 * 60_000;
      e.n = 0;
    }
    this.map.set(key, e);
  }
  ok(key) {
    this.map.delete(key);
  }
}

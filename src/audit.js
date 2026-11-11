import crypto from "node:crypto";

const GENESIS = "0".repeat(64);
const digest = (prev, a) =>
  crypto.createHash("sha256").update([prev, a.at, a.actor, a.type, a.detail, a.version].join("|")).digest("hex");

// Append-only, hash-chained audit log. Each row commits to the one before it,
// so any edit or deletion after the fact breaks verify().
export function audit(db, now, actor, type, detail, version = "") {
  const last = db.prepare("SELECT hash FROM audit ORDER BY seq DESC LIMIT 1").get();
  const prev = last ? last.hash : GENESIS;
  const row = { at: now, actor, type, detail, version };
  db.prepare("INSERT INTO audit(at,actor,type,detail,version,prev_hash,hash) VALUES(?,?,?,?,?,?,?)").run(
    row.at, row.actor, row.type, row.detail, row.version, prev, digest(prev, row)
  );
}

export function verifyAudit(db) {
  const rows = db.prepare("SELECT * FROM audit ORDER BY seq").all();
  let prev = GENESIS;
  for (const r of rows) {
    if (r.prev_hash !== prev || digest(prev, r) !== r.hash) return { ok: false, brokenAt: r.seq, checked: rows.length };
    prev = r.hash;
  }
  return { ok: true, checked: rows.length };
}

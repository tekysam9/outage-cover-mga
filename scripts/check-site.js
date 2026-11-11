// Verifies every internal link and asset referenced by the site and portal resolves.
import fs from "node:fs";
import path from "node:path";
const root = path.resolve(import.meta.dirname, "..");
const exists = (base, rel) => {
  let p = rel.split("#")[0].split("?")[0];
  if (!p || p.startsWith("/api/")) return true;
  if (p.endsWith("/")) p += "index.html";
  if (!path.extname(p)) p += ".html";
  return fs.existsSync(path.join(base, p));
};
let bad = 0, n = 0;
for (const [dir, prefix] of [["site", ""], ["public", "/app"]]) {
  const base = path.join(root, dir);
  for (const f of fs.readdirSync(base).filter((x) => x.endsWith(".html"))) {
    const html = fs.readFileSync(path.join(base, f), "utf8");
    for (const m of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
      const u = m[1];
      if (/^(https?:|mailto:|#)/.test(u)) continue;
      n++;
      let target = u, b = base;
      if (u.startsWith("/app")) { target = u.slice(4) || "/"; b = path.join(root, "public"); }
      else if (u.startsWith("/")) b = path.join(root, "site");
      if (!exists(b, target)) { console.error(`${dir}/${f}: broken link ${u}`); bad++; }
    }
    if (!/<title>[^<]+<\/title>/.test(html)) { console.error(`${dir}/${f}: missing <title>`); bad++; }
  }
}
console.log(`${n} links checked, ${bad} problem(s)`);
process.exit(bad ? 1 : 0);

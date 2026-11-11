// Illustrative payout estimator (not a quote). Mirrors the published rules: limit = 50% of stock up to $50,000; tiers 4h/8h/24h pay 25%/50%/100%.
const $ = (id) => document.getElementById(id);
const usd = (n) => "$" + Math.round(n).toLocaleString("en-US");
function update() {
  const inv = Number($("inv").value), hrs = Number($("hrs").value);
  const limit = Math.min(inv * 0.5, 50000);
  const pct = hrs >= 24 ? 1 : hrs >= 8 ? 0.5 : hrs >= 4 ? 0.25 : 0;
  $("invOut").textContent = usd(inv); $("hrsOut").textContent = hrs + " hours"; $("limitOut").textContent = usd(limit);
  $("payOut").textContent = pct ? usd(limit * pct) : "$0";
  $("tierOut").textContent = pct ? `${pct * 100}% tier reached` : "Under the 4-hour first tier";
  $("fill").style.width = (hrs / 36) * 100 + "%";
}
for (const id of ["inv", "hrs"]) $(id).addEventListener("input", update);
update();
const io = "IntersectionObserver" in window ? new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); } }), { threshold: 0.12 }) : null;
document.querySelectorAll(".reveal").forEach((el) => (io ? io.observe(el) : el.classList.add("in")));

/* RIDGE — motion per the studied reference: intro logo reveal, staggered grid,
   slide-in section markers, count-up stats, horizontal pin (ease "none"),
   mint ticker, theme toggle, cursor follower. One-shot entrances (doctrine). */
gsap.registerPlugin(ScrollTrigger);

/* ---------- lenis smooth scroll ---------- */
let lenis = null;
if (window.Lenis && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
  lenis = new Lenis({ duration: 1.1, smoothWheel: true });
  lenis.on("scroll", ScrollTrigger.update);
  gsap.ticker.add((t) => lenis.raf(t * 1000));
  gsap.ticker.lagSmoothing(0);
}

/* ---------- intro: logo reveal → grid (reference intro) ---------- */
const introTl = gsap.timeline({ delay: 0.25 });
introTl
  .from(".intro-mark", { scale: 0.8, opacity: 0, duration: 0.9, ease: "power3.out" })
  .to(".intro", { opacity: 0, duration: 0.6, ease: "power2.inOut", onComplete: () => document.getElementById("intro").remove() })
  .from(".hero-grid .cell", { opacity: 0, y: 40, stagger: 0.09, duration: 0.9, ease: "power3.out" }, "-=0.15")
  .from(".topbar > *", { y: -16, opacity: 0, stagger: 0.06, duration: 0.6, ease: "power2.out" }, "-=0.7");

/* ---------- mint ticker (Recent hires from:) ---------- */
const firms = ["Two Sigma", "Headlands", "Citadel Securities", "Vatic Labs", "GQS-Chadel", "Synthia"];
let ti = 0;
setInterval(() => {
  const el = document.getElementById("ticker");
  if (!el) return;
  gsap.to(el, {
    opacity: 0, y: -8, duration: 0.25, ease: "power2.in",
    onComplete: () => {
      ti = (ti + 1) % firms.length;
      el.textContent = firms[ti];
      gsap.fromTo(el, { opacity: 0, y: 8 }, { opacity: 1, y: 0, duration: 0.35, ease: "power2.out" });
    },
  });
}, 2600);

/* ---------- slide-in giant section markers (one-shot) ---------- */
document.querySelectorAll("[data-slide]").forEach((el) => {
  gsap.from(el, {
    xPercent: -8, opacity: 0, duration: 1, ease: "power3.out",
    scrollTrigger: { trigger: el, start: "top 88%", toggleActions: "play none none none" },
  });
});

/* ---------- count-up stats ---------- */
document.querySelectorAll(".stat-num").forEach((el) => {
  const target = Number(el.dataset.count);
  const fmt = (v) => (el.dataset.format === "$0M-5M" ? `$${Math.round(v / 100)}M-5M` : `${Math.round(v)}+`);
  gsap.fromTo(el, { innerText: 0 }, {
    innerText: target, duration: 1.6, ease: "power2.out",
    snap: { innerText: 1 }, onUpdate: () => { el.innerText = fmt(Number(el.innerText) || 0); },
    scrollTrigger: { trigger: el, start: "top 85%", toggleActions: "play none none none" },
  });
});

/* ---------- disciplines: horizontal pin passage (ease none) ---------- */
{
  const track = document.getElementById("htrack");
  const getScroll = () => Math.max(0, track.scrollWidth - window.innerWidth);
  gsap.to(track, {
    x: () => -getScroll(),
    ease: "none",
    scrollTrigger: {
      trigger: "#hwrap",
      start: "top top",
      end: () => "+=" + getScroll(),
      pin: true,
      scrub: 1,
      invalidateOnRefresh: true,
      anticipatePin: 1,
    },
  });
  document.querySelectorAll(".dpanel").forEach((panel, i) => {
    gsap.from(panel.children, {
      opacity: 0, y: 30, stagger: 0.08, duration: 0.8, ease: "power3.out",
      scrollTrigger: { trigger: panel, containerAnimation: gsap.getTweensOf(track)[0], start: "left 90%", toggleActions: "play none none none" },
    });
  });
}

/* ---------- theme toggle ---------- */
document.getElementById("themeToggle").addEventListener("click", () => {
  const next = document.body.dataset.theme === "dark" ? "light" : "dark";
  document.body.dataset.theme = next;
  ScrollTrigger.refresh();
});

/* ---------- grain dither-dissolve (studied from aspensearch.com hover) ----------
   The halftone dots flip to mint inside a soft radius around the mouse; the
   blob elongates along movement (a shrinking trail) and the boundary is
   dithered by per-dot noise. Dots dissolve ~0.6s after the mouse leaves. */
function initDither(cell) {
  const canvas = document.createElement("canvas");
  cell.appendChild(canvas);
  const ctx = canvas.getContext("2d");
  let dots = [], trail = [], dirty = true, raf = 0;
  const GAP = 4, DOT = 1.5, MINT_DOT = 2.1;
  const css = (v) => getComputedStyle(document.body).getPropertyValue(v).trim();

  function build() {
    const r = cell.getBoundingClientRect();
    canvas.width = r.width; canvas.height = r.height;
    dots = [];
    for (let y = GAP; y < canvas.height; y += GAP)
      for (let x = GAP; x < canvas.width; x += GAP)
        dots.push({ x, y, noise: Math.random() });
    draw();
  }

  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const base = css("--black") || "#1a1a1a", mint = css("--mint") || "#b8f0d0";
    const now = performance.now();
    trail = trail.filter((p) => now - p.t < 600);
    for (const d of dots) {
      let intensity = 0;
      for (const p of trail) {
        const age = (now - p.t) / 600;               // 0 fresh → 1 old
        const R = 130 - 85 * age;                     // fresh head wide, tail tight
        const dist = Math.hypot(d.x - p.x, d.y - p.y);
        intensity = Math.max(intensity, 1 - dist / R);
      }
      // dithered boundary: per-dot noise decides who flips near the edge
      if (intensity > 0.2 + 0.55 * d.noise) {
        ctx.fillStyle = mint;
        ctx.beginPath(); ctx.arc(d.x, d.y, MINT_DOT, 0, 7); ctx.fill();
      } else {
        ctx.fillStyle = base; ctx.globalAlpha = 0.5;
        ctx.fillRect(d.x - DOT / 2, d.y - DOT / 2, DOT, DOT);
        ctx.globalAlpha = 1;
      }
    }
  }

  function loop() {
    if (trail.length || dirty) { draw(); dirty = trail.length === 0; }
    raf = requestAnimationFrame(loop);
  }

  cell.addEventListener("mousemove", (e) => {
    const r = cell.getBoundingClientRect();
    trail.push({ x: e.clientX - r.left, y: e.clientY - r.top, t: performance.now() });
  });
  window.addEventListener("resize", build);
  build(); loop();
}
document.querySelectorAll(".cell-grain").forEach(initDither);

/* ---------- refresh after fonts ---------- */
if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => ScrollTrigger.refresh());
window.addEventListener("load", () => ScrollTrigger.refresh());

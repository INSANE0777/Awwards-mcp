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

/* ---------- cursor follower (micro-interaction) ---------- */
if (window.matchMedia("(pointer: fine)").matches) {
  const cursor = document.getElementById("cursor");
  const xTo = gsap.quickTo(cursor, "x", { duration: 0.18, ease: "power2.out" });
  const yTo = gsap.quickTo(cursor, "y", { duration: 0.18, ease: "power2.out" });
  window.addEventListener("mousemove", (e) => { xTo(e.clientX); yTo(e.clientY); });
  document.querySelectorAll(".client-rows li, .contact-btn, .member").forEach((el) => {
    el.addEventListener("mouseenter", () => gsap.to(cursor, { scale: 3, duration: 0.3 }));
    el.addEventListener("mouseleave", () => gsap.to(cursor, { scale: 1, duration: 0.3 }));
  });
}

/* ---------- refresh after fonts ---------- */
if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => ScrollTrigger.refresh());
window.addEventListener("load", () => ScrollTrigger.refresh());

/* fallow press — flat 2D motion (GSAP ScrollTrigger + Lenis, no WebGL) */
gsap.registerPlugin(ScrollTrigger);

/* ---------- lenis smooth scroll, synced to ScrollTrigger ---------- */
let lenis = null;
if (window.Lenis && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
  lenis = new Lenis({ duration: 1.15, smoothWheel: true });
  lenis.on("scroll", ScrollTrigger.update);
  gsap.ticker.add((t) => lenis.raf(t * 1000));
  gsap.ticker.lagSmoothing(0);
}

/* ---------- page-scoped setup ---------- */
const page = document.body.dataset.page;

/* header: difference-blend needs no scroll swap, but give the nav a gentle intro */
gsap.from(".site-header > *", {
  y: -18, opacity: 0, duration: 0.9, stagger: 0.08, ease: "power3.out", delay: 0.15
});

/* ============================================================
   HOME — hero entrance + vertical section reveals
   ============================================================ */
if (page === "home") {
  // torn paper drops in /photo fades beneath — mirrors reference masthead entrance
  const heroTl = gsap.timeline({ delay: 0.35 });
  heroTl
    .from(".hero-paper", { yPercent: -104, duration: 1.25, ease: "power4.out" })
    .from(".hero-photo", { scale: 1.12, opacity: 0, duration: 1.6, ease: "power2.out" }, "-=1.0")
    .from(".hero-issue > *", { opacity: 0, y: 14, stagger: 0.12, duration: 0.7, ease: "power2.out" }, "-=0.8")
    .from(".hero-title span", { opacity: 0, yPercent: 60, stagger: 0.14, duration: 0.9, ease: "power4.out" }, "-=0.6")
    .from(".hero .pill-btn", { opacity: 0, y: 16, duration: 0.7, ease: "power2.out" }, "-=0.5")
    .from(".hero-caption", { opacity: 0, x: -18, duration: 0.8, ease: "power2.out" }, "-=0.6");

  // statement: indented line rises
  gsap.from(".statement .caps-label", {
    opacity: 0, y: 24, duration: 0.8, ease: "power2.out",
    scrollTrigger: { trigger: ".statement", start: "top 70%" }
  });
  gsap.from(".statement-text", {
    opacity: 0, y: 40, duration: 1.1, ease: "power3.out",
    scrollTrigger: { trigger: ".statement", start: "top 62%" }
  });

  // stories header rule draws
  gsap.from(".head-rule", {
    scaleX: 0, transformOrigin: "left center", duration: 1.1, ease: "power3.inOut",
    scrollTrigger: { trigger: ".stories-head", start: "top 80%" }
  });

  // story cards rise in batches (grid groups at slightly different times)
  ScrollTrigger.batch(".story-card", {
    interval: 0.12,
    onEnter: (batch) => gsap.to(batch, { opacity: 1, y: 0, stagger: 0.09, duration: 0.85, ease: "power3.out", overwrite: true }),
    start: "top 86%"
  });
  gsap.set(".story-card", { opacity: 0, y: 56 });

  // engage band: card slides while title rises
  gsap.from(".engage-title", {
    opacity: 0, y: 36, duration: 0.9, ease: "power3.out",
    scrollTrigger: { trigger: ".engage", start: "top 65%" }
  });
  gsap.from(".engage-card", {
    opacity: 0, x: 80, duration: 1.1, ease: "power3.out",
    scrollTrigger: { trigger: ".engage", start: "top 60%" }
  });

  // feature film: slow photo scale + text rise
  gsap.from(".feature-photo", {
    scale: 1.18, duration: 1.8, ease: "power2.out",
    scrollTrigger: { trigger: ".feature", start: "top 70%" }
  });
  gsap.from(".feature-content > *", {
    opacity: 0, y: 30, stagger: 0.12, duration: 0.9, ease: "power3.out",
    scrollTrigger: { trigger: ".feature", start: "top 55%" }
  });
}

/* ============================================================
   HORIZONTAL PAGES — shared driver
   ============================================================ */
function buildHorizontal() {
  const track = document.querySelector(".hgallery-track");
  if (!track) return null;

  const getScroll = () => Math.max(0, track.offsetWidth - window.innerWidth);

  // THE horizontal tween — ease "none" is mandatory for containerAnimation children
  const scrollTween = gsap.to(track, {
    x: () => -getScroll(),
    ease: "none",
    scrollTrigger: {
      trigger: ".hgallery",
      pin: true,
      start: "top top",
      end: () => "+=" + getScroll(),
      scrub: 1,
      invalidateOnRefresh: true,
      anticipatePin: 1
    }
  });

  // progress bar on the intro panel
  const fill = document.querySelector(".pp-fill");
  if (fill) {
    ScrollTrigger.create({
      trigger: ".hgallery",
      start: "top top",
      end: () => "+=" + getScroll(),
      onUpdate: (self) => { fill.style.width = (self.progress * 100).toFixed(2) + "%"; }
    });
  }

  // per-panel text entrance ONCE — no reverse. With full-viewport panels,
  // reverse-on-leave hides copy mid-view (QA pin-shots showed empty quote panels).
  document.querySelectorAll(".panel-copy, .panel-quote, .chapter-copy, .chapter-quote, .sayhi-copy").forEach((el) => {
    gsap.from(el, {
      opacity: 0, y: 46, duration: 0.9, ease: "power3.out",
      scrollTrigger: {
        containerAnimation: scrollTween,
        trigger: el,
        start: "left 92%",
        toggleActions: "play none none none"
      }
    });
  });

  // media blocks ease in once as they enter
  document.querySelectorAll(".panel-media, .chapter-media").forEach((el) => {
    gsap.from(el, {
      opacity: 0, scale: 1.06, duration: 1.1, ease: "power2.out",
      scrollTrigger: {
        containerAnimation: scrollTween,
        trigger: el,
        start: "left 98%",
        toggleActions: "play none none none"
      }
    });
  });

  return scrollTween;
}

if (page === "fields" || page === "practices") {
  buildHorizontal();
}

/* refresh after fonts load — horizontal width depends on track size */
if (document.fonts && document.fonts.ready) {
  document.fonts.ready.then(() => ScrollTrigger.refresh());
}
window.addEventListener("load", () => ScrollTrigger.refresh());

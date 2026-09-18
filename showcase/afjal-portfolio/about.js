// about: horizontal chapters past the fixed chrome model — same ScrollTrigger
// pin pattern; the model rotates with scrub progress (reference about.avi's
// scrolling model, now moving sideways past alternating chapters).
// Reduced motion / JS-less: vertical stack, model static (no-h).

(function () {
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const model = document.querySelector(".model--fixed");

  if (reduced || !window.gsap || !window.ScrollTrigger) {
    document.documentElement.classList.add("no-h");
    return;
  }

  gsap.registerPlugin(ScrollTrigger);

  const wrap = document.getElementById("aboutWrap");
  const track = document.getElementById("aboutTrack");
  const distance = () => track.scrollWidth - window.innerWidth;

  const scrollTween = gsap.to(track, {
    x: () => -distance(),
    ease: "none",
    scrollTrigger: {
      trigger: wrap,
      pin: true,
      scrub: 1,
      start: "top top",
      end: () => "+=" + distance(),
      invalidateOnRefresh: true,
    },
  });

  // model spin follows the horizontal progress (per-page full turn)
  if (model) {
    ScrollTrigger.create({
      trigger: wrap,
      start: "top top",
      end: () => "+=" + distance(),
      scrub: true,
      onUpdate: (self) => {
        model.style.setProperty("--spin", String(self.progress * 360));
      },
    });
  }

  addEventListener("load", () => ScrollTrigger.refresh());
})();

// Floating-card cluster: deterministic SVG art per card (offline, no assets),
// scattered in a ring around the center monogram — the reference's
// "Creative Space" anatomy. Also reveals + light parallax.

(function () {
  // Progressive-enhancement flag: .reveal stays visible without JS (and in
  // full-page captures that never scroll).
  document.documentElement.classList.add("js");

  const cards = [
    { seed: 11, w: 96, h: 122 }, { seed: 22, w: 76, h: 96 },
    { seed: 33, w: 88, h: 88 },  { seed: 47, w: 104, h: 78 },
    { seed: 58, w: 70, h: 108 }, { seed: 69, w: 92, h: 92 },
    { seed: 71, w: 80, h: 120 }, { seed: 83, w: 100, h: 74 },
    { seed: 96, w: 72, h: 102 }, { seed: 108, w: 90, h: 90 },
  ];

  // Seeded pseudo-random → deterministic art on every load.
  function rng(seed) {
    let s = seed >>> 0;
    return () => ((s = (s * 1664525 + 1013904223) >>> 0), s / 2 ** 32);
  }

  function cardSvg(seed, dark) {
    const r = rng(seed);
    const bg = dark ? "#0a0a0a" : "#f6f6f3";
    const fg = dark ? "#f2f2ee" : "#111";
    let shapes = "";
    const n = 3 + Math.floor(r() * 4);
    for (let i = 0; i < n; i++) {
      const cx = 10 + r() * 80, cy = 10 + r() * 100;
      const rad = 4 + r() * 22;
      const op = (0.08 + r() * 0.5).toFixed(2);
      shapes +=
        r() > 0.5
          ? `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${rad.toFixed(1)}" fill="${fg}" opacity="${op}"/>`
          : `<rect x="${(cx - rad).toFixed(1)}" y="${(cy - rad / 1.6).toFixed(1)}" width="${(rad * 2).toFixed(1)}" height="${(rad * 1.6).toFixed(1)}" fill="${fg}" opacity="${op}"/>`;
    }
    const lineY = 20 + r() * 80;
    return `<svg viewBox="0 0 100 130" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg">
      <rect width="100" height="130" fill="${bg}"/>
      <line x1="8" y1="${lineY.toFixed(1)}" x2="92" y2="${lineY.toFixed(1)}" stroke="${fg}" stroke-width="0.6" opacity="0.35"/>
      ${shapes}
    </svg>`;
  }

  const cluster = document.getElementById("cluster");
  if (!cluster) return;

  const N = cards.length;
  cards.forEach((c, i) => {
    const el = document.createElement("div");
    el.className = "card";
    el.style.setProperty("--card-w", c.w + "px");
    el.style.setProperty("--card-h", c.h + "px");

    // Ring placement with jitter — golden-angle spread so no two overlap.
    const angle = i * 137.5 + (i % 3) * 9;
    const radius = 32 + (i % 4) * 9 + Math.sin(i * 2.7) * 4; // %
    const x = 50 + radius * Math.cos((angle * Math.PI) / 180);
    const y = 50 + radius * Math.sin((angle * Math.PI) / 180);
    el.style.left = x.toFixed(1) + "%";
    el.style.top = y.toFixed(1) + "%";
    el.style.rotate = ((i % 5) - 2) * 2.2 + "deg";
    el.style.translate = "-50% -50%";
    el.style.zIndex = String(1 + (i % 3));
    el.style.setProperty("--dur", 6 + (i % 4) * 1.3 + "s");
    el.style.setProperty("--delay", (i * 0.35).toFixed(2) + "s");

    el.innerHTML = cardSvg(c.seed, i % 3 === 0);
    el.title = "Selected work " + String(i + 1).padStart(2, "0");
    cluster.appendChild(el);
  });

  // Reveal-on-scroll.
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          e.target.classList.add("is-in");
          io.unobserve(e.target);
        }
      }
    },
    { threshold: 0.18 }
  );
  document.querySelectorAll(".reveal").forEach((n, i) => {
    n.style.transitionDelay = (i % 4) * 90 + "ms";
    io.observe(n);
  });

  // Very light parallax on the ghost backdrop — gives the motion recorder
  // something honest to film; disabled for reduced-motion users.
  const ghosts = document.querySelectorAll(".ghost");
  if (!matchMedia("(prefers-reduced-motion: reduce)").matches) {
    let ticking = false;
    addEventListener("scroll", () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        const y = scrollY;
        ghosts.forEach((g, i) => {
          g.style.marginTop = (i === 0 ? y * -0.05 : y * 0.04) + "px";
        });
        ticking = false;
      });
    }, { passive: true });
  }
})();

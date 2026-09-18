// projects: the horizontal gallery — GSAP ScrollTrigger pin (containerAnimation
// pattern from the gsap-scrolltrigger skill: pin the wrap, tween the track's
// xPercent with ease:"none", vertical scroll scrubs it). JS-less/reduced
// motion falls back to a vertical stack (no-h class + CSS).
// Offline: panel art is generated SVG (data URIs).

(function () {
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

  function renderSvg(kind) {
    if (kind === "phone") {
      return `<svg viewBox="0 0 400 300" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg">
        <defs><linearGradient id="pg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#9aa4ff"/><stop offset="0.5" stop-color="#4157f0"/><stop offset="1" stop-color="#0a1470"/>
        </linearGradient></defs>
        <rect width="400" height="300" fill="url(#pg)"/>
        <rect x="150" y="40" width="100" height="220" rx="18" fill="#0d0d14" opacity="0.92"/>
        <circle cx="175" cy="70" r="7" fill="#1c1c26"/><circle cx="200" cy="70" r="12" fill="#0d0d14"/><circle cx="225" cy="70" r="7" fill="#1c1c26"/>
        <text x="200" y="160" text-anchor="middle" font-family="IBM Plex Mono, monospace" font-size="20" fill="#fff" letter-spacing="6">AF .77</text>
        <ellipse cx="200" cy="235" rx="18" ry="12" fill="#fff" opacity="0.35"/>
        <ellipse cx="200" cy="272" rx="10" ry="6" fill="#8f7bff" opacity="0.8"/>
      </svg>`;
    }
    if (kind === "pirate") {
      let rows = "";
      for (let i = 0; i < 9; i++) {
        rows += `<rect x="${18 + (i % 4) * 8}" y="${34 + i * 14 - (i % 3) * 4}" width="${260 - i * 12}" height="3" fill="#0d0d0d" opacity="${(0.88 - i * 0.06).toFixed(2)}"/>`;
      }
      return `<svg viewBox="0 0 400 300" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg">
        <rect width="400" height="300" fill="#e3ebe5"/>${rows}
        <text x="200" y="26" text-anchor="middle" font-family="Newsreader, serif" font-size="15" fill="#0d0d0d" letter-spacing="10">THE MERIDIAN</text>
      </svg>`;
    }
    let facets = "";
    const r2 = (() => { let s = 77 >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0), s / 2 ** 32); })();
    for (let i = 0; i < 14; i++) {
      const cx = 200 + (r2() - 0.5) * 180, cy = 150 + (r2() - 0.5) * 110, rad = 10 + r2() * 34;
      facets += `<circle cx="${cx.toFixed(0)}" cy="${cy.toFixed(0)}" r="${rad.toFixed(0)}" fill="hsl(0 0% ${30 + Math.floor(r2() * 120)}%)" opacity="0.94"/>`;
    }
    return `<svg viewBox="0 0 400 300" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg">
      <rect width="400" height="300" fill="#7d1010"/>${facets}<circle cx="200" cy="150" r="28" fill="#f0eded"/>
    </svg>`;
  }

  document.querySelectorAll("[data-art]").forEach((img) => {
    const b64 = btoa(unescape(encodeURIComponent(renderSvg(img.dataset.art))));
    img.src = "data:image/svg+xml;base64," + b64;
  });

  const hwrap = document.getElementById("hwrap");
  const htrack = document.getElementById("htrack");

  // sliver reveals: fire from the containerAnimation for tint panels
  function armSlivers(containerTween) {
    document.querySelectorAll("[data-sliver]").forEach((sliver) => {
      sliver.classList.add("is-in");
      if (containerTween) return; // already inside; keep armed
    });
  }

  if (reduced || !window.gsap || !window.ScrollTrigger) {
    document.documentElement.classList.add("no-h");
    armSlivers(null);
    return;
  }

  gsap.registerPlugin(ScrollTrigger);

  // Pin the wrap; scrub the track sideways. ease:"none" is REQUIRED so
  // vertical scroll maps 1:1 onto horizontal position.
  const distance = () => htrack.scrollWidth - window.innerWidth;
  const scrollTween = gsap.to(htrack, {
    xPercent: -100 * (htrack.scrollWidth / window.innerWidth - 1),
    x: () => -distance(),
    ease: "none",
    scrollTrigger: {
      trigger: hwrap,
      pin: true,
      scrub: 1,
      start: "top top",
      end: () => "+=" + distance(),
      invalidateOnRefresh: true,
    },
  });

  // sliver reveals keyed to horizontal progress (containerAnimation pattern:
  // start/end are LEFT-based positions inside the moving track)
  document.querySelectorAll("[data-sliver]").forEach((sliver) => {
    gsap.to(sliver, {
      scrollTrigger: {
        containerAnimation: scrollTween,
        trigger: sliver,
        start: "left 90%",
        once: true,
        toggleClass: { targets: sliver, className: "is-in" },
      },
    });
  });

  addEventListener("load", () => ScrollTrigger.refresh());
})();

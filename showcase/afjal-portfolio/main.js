// Motion-true rebuild v2 — rebuilt from the frame-studied reference videos:
// (1) hero: scattered thumbnails fly in and form a continuously spinning 3D
//     ring (CSS perspective; near cards big, far cards small);
// (2) projects: image slivers revealed on scroll (clip-path progress);
// (3) about: chrome blob pinned center (sticky), rotating with scroll,
//     while text columns alternate left/right past it.
// Offline: all card art is seeded SVG; no external images.

(function () {
  document.documentElement.classList.add("js");

  // ── seeded SVG art (deterministic, offline) ──
  function rng(seed) {
    let s = seed >>> 0;
    return () => ((s = (s * 1664525 + 1013904223) >>> 0), s / 2 ** 32);
  }

  function artSvg(seed, dark, hue) {
    const r = rng(seed);
    const bg = dark ? "#0d0d0d" : "#f4f4f1";
    const accents =
      hue === null ? ["#111", "#555"] : [`hsl(${hue} 80% 60%)`, `hsl(${(hue + 40) % 360} 70% 45%)`];
    let out = "";
    const n = 4 + Math.floor(r() * 4);
    for (let i = 0; i < n; i++) {
      const x = 8 + r() * 84, y = 8 + r() * 84, rad = 4 + r() * 16;
      const col = r() > 0.6 ? accents[0] : accents[1];
      const op = (0.2 + r() * 0.6).toFixed(2);
      out +=
        r() > 0.5
          ? `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${rad.toFixed(1)}" fill="${col}" opacity="${op}"/>`
          : `<rect x="${(x - rad).toFixed(1)}" y="${(y - rad).toFixed(1)}" width="${(rad * 2).toFixed(1)}" height="${(rad * 1.8).toFixed(1)}" fill="${col}" opacity="${op}"/>`;
    }
    return `<svg viewBox="0 0 100 100" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg">
      <rect width="100" height="100" fill="${bg}"/>${out}</svg>`;
  }

  // ── project render art (tinted-panel style, like the reference's product
  //    renders: outlined logo on cobalt, 3D-ish engine on red) ──
  function renderSvg(kind) {
    if (kind === "phone") {
      // cobalt panel: chrome phone silhouette, outlined "AF .77"
      return `<svg viewBox="0 0 400 300" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <linearGradient id="pg" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stop-color="#9aa4ff"/><stop offset="0.5" stop-color="#4157f0"/><stop offset="1" stop-color="#0a1470"/>
          </linearGradient>
        </defs>
        <rect width="400" height="300" fill="url(#pg)"/>
        <rect x="150" y="40" width="100" height="220" rx="18" fill="#0d0d14" opacity="0.92"/>
        <circle cx="175" cy="70" r="7" fill="#1c1c26"/><circle cx="200" cy="70" r="12" fill="#0d0d14"/>
        <circle cx="225" cy="70" r="7" fill="#1c1c26"/>
        <text x="200" y="160" text-anchor="middle" font-family="IBM Plex Mono, monospace" font-size="20" fill="#fff" letter-spacing="6">AF .77</text>
        <ellipse cx="200" cy="235" rx="18" ry="12" fill="#fff" opacity="0.35"/>
        <ellipse cx="200" cy="272" rx="10" ry="6" fill="#8f7bff" opacity="0.8"/>
      </svg>`;
    }
    if (kind === "pirate") {
      // mint panel: editorial masthead slivers
      let rows = "";
      for (let i = 0; i < 9; i++) {
        const y = 34 + i * 14 - (i % 3) * 4;
        rows += `<rect x="${18 + (i % 4) * 8}" y="${y}" width="${(260 - i * 12).toFixed(0)}" height="3" fill="#0d0d0d" opacity="${(0.88 - i * 0.06).toFixed(2)}"/>`;
      }
      return `<svg viewBox="0 0 400 300" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg">
        <rect width="400" height="300" fill="#e3ebe5"/>${rows}
        <text x="200" y="26" text-anchor="middle" font-family="Newsreader, serif" font-size="15" fill="#0d0d0d" letter-spacing="10">THE MERIDIAN</text>
      </svg>`;
    }
    // red panel: faceted chrome engine blob
    let facets = "";
    const r2 = rng(77);
    for (let i = 0; i < 14; i++) {
      const cx = 200 + (r2() - 0.5) * 180, cy = 150 + (r2() - 0.5) * 110, rad = 10 + r2() * 34;
      const shade = 30 + Math.floor(r2() * 120);
      facets += `<circle cx="${cx.toFixed(0)}" cy="${cy.toFixed(0)}" r="${rad.toFixed(0)}" fill="hsl(0 0% ${shade}%)" opacity="0.94"/>`;
    }
    return `<svg viewBox="0 0 400 300" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg">
      <rect width="400" height="300" fill="#7d1010"/>${facets}
      <circle cx="200" cy="150" r="28" fill="#f0eded"/>
    </svg>`;
  }

  // ── HERO orbit ring ──
  const ring = document.getElementById("orbitRing");
  const orbit = document.getElementById("orbit");
  const CARD_N = 12;
  const R = Math.min(innerWidth * 0.42, 470);
  const cards = [];
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduced) document.body.classList.remove("preload-locked");

  for (let i = 0; i < CARD_N; i++) {
    const card = document.createElement("div");
    card.className = "orb-card";
    const angle = (360 / CARD_N) * i;
    const w = 66 + (i % 3) * 14;
    const dark = i % 3 === 0;
    card.style.setProperty("--w", w + "px");
    card.style.setProperty("--h", w * 1.24 + "px");
    card.style.transform = `rotateY(${angle}deg) translateZ(${R}px)`;
    card.style.opacity = "0";
    // scattered start (pre-fly-in): off-slot + tiny
    card.dataset.slot = `rotateY(${angle}deg) translateZ(${R}px)`;
    const sx = (rng(i + 1)() - 0.5) * innerWidth * 1.2;
    const sy = (rng(i + 7)() - 0.5) * innerHeight;
    card.style.left = `calc(50% + ${sx.toFixed(0)}px)`;
    card.style.top = `calc(50% + ${sy.toFixed(0)}px)`;
    card.style.rotate = `${(rng(i + 3)() - 0.5) * 90}deg`;
    card.style.scale = "0.4";
    card.innerHTML = artSvg(11 + i * 7, dark, dark ? [204, 36, 158][i % 3] : null);
    ring.appendChild(card);
    cards.push(card);
  }

  // fly-in: scattered → ring slots, then spin continuously.
  if (reduced) {
    // No animation: seal every card into its slot immediately.
    cards.forEach((card) => {
      card.style.left = "50%";
      card.style.top = "50%";
      card.style.rotate = "0deg";
      card.style.opacity = "1";
      card.style.scale = "1";
      card.style.transform = card.dataset.slot;
      card.dataset.sealed = "1";
    });
    document.body.classList.remove("preload-locked");
  } else {
  requestAnimationFrame(() => {
    setTimeout(() => {
      document.body.classList.remove("preload-locked");
    }, 1600);

    const t0 = performance.now();
    const FLY = 1500;

    function ease(t) { return 1 - Math.pow(1 - t, 3); }

    function frame(now) {
      const t = Math.min(1, (now - t0) / FLY);
      const spin = ease(t) * 30 + (now - t0) * 0.008; // ease-in spin + constant drift

      ring.style.transform = `rotateX(-8deg) rotateY(${spin}deg)`;

      cards.forEach((card, i) => {
        if (t < 1) {
          // ease opacity + travel: leave scattered pos by transitioning scale/opacity only
          card.style.opacity = String(Math.min(1, t * 1.4));
          card.style.scale = String(0.4 + ease(t) * 0.6);
        } else {
          card.style.opacity = "1";
          card.style.scale = "1";
        }
        // rig: scattered left/top → ring rig. On t=1 seal slot transform.
        if (t >= 1 && !card.dataset.sealed) {
          card.style.left = "50%";
          card.style.top = "50%";
          card.style.rotate = "0deg";
          card.style.transform = card.dataset.slot;
          card.dataset.sealed = "1";
        }
      });

      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);

    // at fly end, seal slots (left/top → 50%, rotate 0) — done in frame()
  });
  }

  // ── scroll: sliver reveals + model rotation ──
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          e.target.classList.add("is-in");
          io.unobserve(e.target);
        }
      }
    },
    { threshold: 0.22 }
  );
  document
    .querySelectorAll(".reveal-node, [data-sliver]")
    .forEach((n, i) => {
      n.style.transitionDelay = (i % 4) * 80 + "ms";
      io.observe(n);
    });

  // project art + built chip (export from renderSvg)
  document.querySelectorAll("[data-art]").forEach((img) => {
    const b64 = btoa(unescape(encodeURIComponent(renderSvg(img.dataset.art))));
    img.src = "data:image/svg+xml;base64," + b64;
  });

  // model rotation with scroll — pinned while the track passes
  const model = document.getElementById("model");
  let ticking = false;
  addEventListener("scroll", () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      const max = document.body.scrollHeight - innerHeight;
      model.style.setProperty("--spin", String((scrollY / Math.max(1, max)) * 300));
      ticking = false;
    });
  }, { passive: true });
})();

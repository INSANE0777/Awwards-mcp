// index: JS-less-safe seeded SVG art + 3D ring fly-in/spin (unchanged motion
// design, page-scoped). GSAP is loaded but unused here — no scroll motion.

(function () {
  document.documentElement.classList.add("js");

  function rng(seed) {
    let s = seed >>> 0;
    return () => ((s = (s * 1664525 + 1013904223) >>> 0), s / 2 ** 32);
  }

  function artSvg(seed, dark, hue) {
    const r = rng(seed);
    const bg = dark ? "#0d0d0d" : "#f4f4f1";
    const accents = hue === null ? ["#111", "#555"] : [`hsl(${hue} 80% 62%)`, `hsl(${(hue + 40) % 360} 70% 46%)`];
    let out = "";
    const n = 4 + Math.floor(r() * 4);
    for (let i = 0; i < n; i++) {
      const x = 8 + r() * 84, y = 8 + r() * 84, rad = 4 + r() * 16;
      const col = r() > 0.6 ? accents[0] : accents[1];
      const op = (0.2 + r() * 0.6).toFixed(2);
      out += r() > 0.5
        ? `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${rad.toFixed(1)}" fill="${col}" opacity="${op}"/>`
        : `<rect x="${(x - rad).toFixed(1)}" y="${(y - rad).toFixed(1)}" width="${(rad * 2).toFixed(1)}" height="${(rad * 1.8).toFixed(1)}" fill="${col}" opacity="${op}"/>`;
    }
    return `<svg viewBox="0 0 100 100" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg"><rect width="100" height="100" fill="${bg}"/>${out}</svg>`;
  }

  const ring = document.getElementById("orbitRing");
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
    card.dataset.slot = `rotateY(${angle}deg) translateZ(${R}px)`;
    const sx = (rng(i + 1)() - 0.5) * innerWidth * 1.2;
    const sy = (rng(i + 7)() - 0.5) * innerHeight;
    card.style.left = `calc(50% + ${sx.toFixed(0)}px)`;
    card.style.top = `calc(50% + ${sy.toFixed(0)}px)`;
    card.style.rotate = `${(rng(i + 3)() - 0.5) * 90}deg`;
    card.style.scale = "0.4";
    card.innerHTML = artSvg(11 + i * 7, dark, dark ? 204 + i * 3 : null);
    ring.appendChild(card);
    cards.push(card);
  }

  function seal(card) {
    card.style.left = "50%";
    card.style.top = "50%";
    card.style.rotate = "0deg";
    card.style.opacity = "1";
    card.style.scale = "1";
    card.style.transform = card.dataset.slot;
    card.dataset.sealed = "1";
  }

  if (reduced) {
    cards.forEach(seal);
    document.body.classList.remove("preload-locked");
    return;
  }

  requestAnimationFrame(() => {
    const t0 = performance.now();
    const FLY = 1500;
    const ease = (t) => 1 - Math.pow(1 - t, 3);

    function frame(now) {
      const t = Math.min(1, (now - t0) / FLY);
      const spin = ease(t) * 30 + (now - t0) * 0.008;
      ring.style.transform = `rotateX(-8deg) rotateY(${spin}deg)`;
      cards.forEach((card) => {
        if (t < 1) {
          card.style.opacity = String(Math.min(1, t * 1.4));
          card.style.scale = String(0.4 + ease(t) * 0.6);
        } else if (!card.dataset.sealed) {
          seal(card);
        }
      });
      if (t >= 1 && !document.body.dataset.unlocked) {
        document.body.dataset.unlocked = "1";
        document.body.classList.remove("preload-locked");
      }
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  });
})();

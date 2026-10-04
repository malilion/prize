/* 抽獎轉盤 — stage renderer.
 * Paints the whole broadcast frame (wheel, pointer, prize panel, evidence footer, REC badge)
 * onto one 1920×1080 canvas. The same canvas is shown on screen and fed to the recorder,
 * so every video is exactly what the room saw. Colours come from the --stage-* / --seg-*
 * tokens in tokens.css. */
(function (root) {
  'use strict';
  const LW = (root.LW = root.LW || {});
  const { rgba, mod } = LW;

  const W = 1920;
  const H = 1080;
  const TAU = Math.PI * 2;
  // Proportions follow MalilionUI's LuckyWheel (a 200-unit SVG: rim 99, groove 87, face 82).
  const U = 454 / 99;
  const WHEEL = { cx: 590, cy: 500, r: 82 * U };
  const RIM_R = 99 * U;
  const GROOVE_R = 87 * U;
  const BULB_RING = 93 * U;
  const BULB_R = 2.6 * U;
  const BULBS = 16;
  const PEG_RING = 79 * U;
  const PEG_R = 1.9 * U;
  const MAX_PEGS = 72;
  const HUB = 25 * U;
  const POINTER = -Math.PI / 2; // top of the wheel
  const PIN_Y = -92.5 * U;
  const MAX_PAINTED_BANDS = 720;
  const INFO = { x: 1150, w: 690 };
  const FOOT_Y = 1000;

  const TOKENS = [
    'stage-bg', 'stage-bloom', 'stage-band', 'stage-ink', 'stage-ink-2', 'stage-ink-3', 'stage-accent',
    'stage-rec', 'seg-1', 'seg-1-hi', 'seg-2', 'seg-2-hi', 'seg-3', 'seg-3-hi', 'seg-4', 'seg-4-hi',
    'seg-ink-light', 'seg-ink-dark', 'seg-empty', 'rim-hi', 'rim', 'rim-mid', 'rim-2', 'rim-shade', 'groove',
    'bulb-on', 'bulb-off', 'bulb-glow', 'peg', 'peg-edge', 'hub-ring', 'pointer-edge',
  ];

  /** The LuckyWheel brushed-metal gradient, top to bottom across [y0, y1]. */
  function metal(g, T, y0, y1) {
    const grad = g.createLinearGradient(0, y0, 0, y1);
    grad.addColorStop(0, rgba(T.rimHi));
    grad.addColorStop(0.22, rgba(T.rim));
    grad.addColorStop(0.48, rgba(T.rimMid));
    grad.addColorStop(0.7, rgba(T.rim2));
    grad.addColorStop(1, rgba(T.rimShade));
    return grad;
  }

  const mix = (a, b, k) => `rgb(${Math.round(a.r + (b.r - a.r) * k)}, ${Math.round(a.g + (b.g - a.g) * k)}, ${Math.round(a.b + (b.b - a.b) * k)})`;

  let pawPath = null;
  /** Paw print in a 24×24 box centred on the origin (MalilionUI's paw glyph). */
  function paw() {
    if (pawPath) return pawPath;
    const p = new Path2D();
    const toe = (x, y, rx, ry, deg) => {
      p.moveTo(x - 12 + rx * Math.cos((deg * Math.PI) / 180), y - 12 + rx * Math.sin((deg * Math.PI) / 180));
      p.ellipse(x - 12, y - 12, rx, ry, (deg * Math.PI) / 180, 0, TAU);
    };
    toe(4.6, 10, 2.1, 2.7, -24);
    toe(9, 5.6, 2.25, 2.95, -8);
    toe(15, 5.6, 2.25, 2.95, 8);
    toe(19.4, 10, 2.1, 2.7, 24);
    const pad = new Path2D('M12 11.6c-3.2 0-6.8 3.7-6.8 6.6 0 2 1.5 3.3 3.4 3.3 1.3 0 2.2-.6 3.4-.6s2.1.6 3.4.6c1.9 0 3.4-1.3 3.4-3.3 0-2.9-3.6-6.6-6.8-6.6z');
    p.addPath(pad, { a: 1, b: 0, c: 0, d: 1, e: -12, f: -12 });
    pawPath = p;
    return p;
  }

  function readTheme() {
    const css = getComputedStyle(document.documentElement);
    const theme = {};
    for (const name of TOKENS) {
      theme[name.replace(/-(\w)/g, (_, c) => c.toUpperCase())] = LW.parseColor(css.getPropertyValue(`--${name}`));
    }
    theme.fontBody = css.getPropertyValue('--font-body').trim() || 'sans-serif';
    theme.fontMono = css.getPropertyValue('--font-mono').trim() || 'monospace';
    return theme;
  }

  /** Spin easing: a short ramp-up, then a long slowdown (velocity ∝ (1 − t)^power). */
  function makeEase(ramp = 0.05, power = 2.2, steps = 2048) {
    const table = new Float64Array(steps + 1);
    let acc = 0;
    for (let i = 1; i <= steps; i++) {
      const t = (i - 0.5) / steps;
      acc += Math.min(1, t / ramp) * Math.pow(1 - t, power);
      table[i] = acc;
    }
    for (let i = 1; i <= steps; i++) table[i] /= acc;
    return (u) => {
      if (u <= 0) return 0;
      if (u >= 1) return 1;
      const p = u * steps;
      const i = Math.floor(p);
      return table[i] + (table[i + 1] - table[i]) * (p - i);
    };
  }
  const spinEase = makeEase();

  /** Cycle the palette, but never let the last slice match its neighbour across the seam. */
  function segmentColors(n, k) {
    const out = Array.from({ length: n }, (_, i) => i % k);
    if (n > 2 && out[n - 1] === out[0]) {
      for (let c = 0; c < k; c++) {
        if (c !== out[0] && c !== out[n - 2]) { out[n - 1] = c; break; }
      }
    }
    return out;
  }

  function truncate(ctx, text, maxWidth) {
    if (ctx.measureText(text).width <= maxWidth) return text;
    const chars = Array.from(text);
    let lo = 0;
    let hi = chars.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (ctx.measureText(chars.slice(0, mid).join('') + '…').width <= maxWidth) lo = mid;
      else hi = mid - 1;
    }
    return chars.slice(0, lo).join('') + '…';
  }

  function roundRect(ctx, x, y, w, h, r) {
    const rr = Math.min(r, h / 2, w / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  class Stage {
    constructor(canvas) {
      this.canvas = canvas;
      canvas.width = W;
      canvas.height = H;
      this.ctx = canvas.getContext('2d', { alpha: false });
      this.theme = readTheme();
      this.reducedMotion = !!(root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches);

      this.labels = [];
      this.rotation = 0;
      this.view = {
        title: '',
        drawNo: 1,
        sessionId: '',
        candidateCount: 0,
        fingerprint: '',
        prize: null,
        prizeWinners: [],
        readout: { label: '指針位置', text: null, tone: 'normal' },
      };
      this.spin = null;
      this.highlight = null;
      this.resultAt = -Infinity;
      this.recording = null;
      this.kick = 0;
      this.lastIndex = -1;
      this.lastTickAt = 0;
      this.confetti = [];
      this.fitCache = new Map();
      this.onTick = null;
      this.dirty = true;
      this.lastSecond = -1;
      this.prevNow = 0;

      this.background = this.paintBackground();
      this.wheel = this.paintWheel([]);
      this.frame = this.frame.bind(this);
      requestAnimationFrame(this.frame);
    }

    /* ---------- public API ---------- */

    setLabels(labels) {
      if (this.spin) return;
      if (labels.length === this.labels.length && labels.every((l, i) => l === this.labels[i])) return;
      this.labels = labels.slice();
      this.wheel = this.paintWheel(this.labels);
      this.highlight = null;
      const n = this.labels.length;
      if (n) this.rotation = mod(POINTER - (this.pointerIndex() + 0.5) * (TAU / n), TAU); // rest mid-slice
      this.lastIndex = this.pointerIndex();
      this.dirty = true;
    }

    setView(patch) {
      Object.assign(this.view, patch);
      this.dirty = true;
    }

    setRecording(startedAt) {
      this.recording = startedAt == null ? null : { startedAt };
      this.dirty = true;
    }

    pointerIndex() {
      const n = this.labels.length;
      if (!n) return -1;
      return Math.min(n - 1, Math.floor(mod(POINTER - this.rotation, TAU) / (TAU / n)));
    }

    labelAtPointer() {
      const i = this.pointerIndex();
      return i < 0 ? null : this.labels[i];
    }

    /** Spin so the pointer stops inside slice `index`. Resolves with the slice actually under the pointer. */
    spinTo(index, durationMs) {
      const n = this.labels.length;
      if (!n) return Promise.resolve(-1);
      const slice = TAU / n;
      const target = (index + 0.2 + 0.6 * LW.randomFloat()) * slice; // never stop on a boundary
      const turns = Math.max(4, Math.round((durationMs / 1000) * 0.75));
      const from = this.rotation;
      const base = from + turns * TAU;
      const to = base + mod(POINTER - target - base, TAU);
      this.highlight = null;
      this.confetti = [];
      return new Promise((resolve) => {
        this.spin = { from, to, t0: performance.now(), duration: durationMs, resolve };
      });
    }

    celebrate() {
      this.resultAt = performance.now();
      this.highlight = { index: this.pointerIndex(), t0: this.resultAt };
      this.dirty = true;
      if (this.reducedMotion) return;
      // Paw-print fireworks bursting from the pointer, in the wheel's metal tones.
      const T = this.theme;
      const colors = [T.seg1Hi, T.seg2Hi, T.seg3, T.seg4Hi, T.bulbOn, T.rim2];
      const ox = WHEEL.cx;
      const oy = WHEEL.cy + PIN_Y;
      for (let i = 0; i < 140; i++) {
        const angle = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.5;
        const speed = 380 + Math.random() * 820;
        this.confetti.push({
          x: ox,
          y: oy,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          rot: (Math.random() - 0.5) * 1.2,
          vr: (Math.random() - 0.5) * 4,
          size: 0.9 + Math.random() * 1.3,
          life: 0,
          ttl: 2.2 + Math.random() * 1.4,
          color: colors[i % colors.length],
        });
      }
    }

    clearResult() {
      this.highlight = null;
      this.confetti = [];
      this.resultAt = -Infinity;
      this.dirty = true;
    }

    /* ---------- loop ---------- */

    frame(now) {
      requestAnimationFrame(this.frame);
      const dt = this.prevNow ? Math.min(0.05, (now - this.prevNow) / 1000) : 0;
      this.prevNow = now;
      let active = false;
      let spinning = false;

      if (this.spin) {
        const s = this.spin;
        const u = (now - s.t0) / s.duration;
        spinning = true;
        active = true;
        if (u >= 1) {
          this.rotation = mod(s.to, TAU);
          this.spin = null;
          s.resolve(this.pointerIndex());
        } else {
          this.rotation = s.from + (s.to - s.from) * spinEase(u);
        }
      }

      const index = this.pointerIndex();
      if (index !== this.lastIndex) {
        this.lastIndex = index;
        if (spinning) {
          if (!this.reducedMotion) this.kick = 1;
          if (now - this.lastTickAt > 45) {
            this.lastTickAt = now;
            if (this.onTick) this.onTick();
          }
        }
      }
      if (this.kick > 0.003) {
        this.kick *= Math.exp(-dt * 12);
        active = true;
      } else {
        this.kick = 0;
      }
      if (this.confetti.length || this.recording || now - this.resultAt < 3800) active = true;
      if (!this.reducedMotion) active = true; // bulbs shimmer while idle; the winning slice breathes

      const second = Math.floor(Date.now() / 1000);
      if (second !== this.lastSecond) {
        this.lastSecond = second;
        this.dirty = true;
      }
      if (active || this.dirty) {
        this.dirty = false;
        this.draw(now, dt);
      }
    }

    draw(now, dt) {
      const ctx = this.ctx;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(this.background, 0, 0);
      this.drawWheel(ctx, now);
      this.drawBulbs(ctx, now);
      this.drawHub(ctx, now);
      this.drawPointer(ctx);
      if (this.labels.length > MAX_PAINTED_BANDS) {
        this.text('大量名單：色帶為縮略示意，抽選依完整名單', WHEEL.cx, 970,
          { size: 22, weight: 500, color: this.theme.stageInk3, align: 'center' });
      }
      this.drawInfo(ctx, now);
      this.drawFooter(ctx);
      if (this.recording) this.drawRecBadge(ctx, now);
      if (this.confetti.length) this.drawConfetti(ctx, dt);
      if (this.onFrame) this.onFrame(this.canvas, this.view);
    }

    /* ---------- cached layers ---------- */

    paintBackground() {
      const T = this.theme;
      const { cx, cy, r } = WHEEL;
      const c = document.createElement('canvas');
      c.width = W;
      c.height = H;
      const g = c.getContext('2d');

      g.fillStyle = rgba(T.stageBg);
      g.fillRect(0, 0, W, H);
      const bloom = g.createRadialGradient(cx, cy, r * 0.4, cx, cy, r * 2.1);
      bloom.addColorStop(0, rgba(T.stageBloom, 0.85));
      bloom.addColorStop(1, rgba(T.stageBloom, 0));
      g.fillStyle = bloom;
      g.fillRect(0, 0, W, H);

      // Brushed-gold rim with a soft drop shadow, then the dark groove the bulbs sit in.
      g.save();
      g.shadowColor = 'rgba(0, 0, 0, 0.55)';
      g.shadowBlur = 74;
      g.shadowOffsetY = 40;
      g.fillStyle = metal(g, T, cy - RIM_R, cy + RIM_R);
      g.beginPath();
      g.arc(cx, cy, RIM_R, 0, TAU);
      g.fill();
      g.restore();
      g.lineWidth = 0.6 * U;
      g.strokeStyle = 'rgba(0, 0, 0, 0.35)';
      g.stroke();
      g.beginPath();
      g.arc(cx, cy, GROOVE_R, 0, TAU);
      g.fillStyle = rgba(T.groove);
      g.fill();
      g.lineWidth = 0.8 * U;
      g.strokeStyle = 'rgba(255, 236, 180, 0.35)';
      g.stroke();

      g.fillStyle = rgba(T.stageBand);
      g.fillRect(0, FOOT_Y, W, H - FOOT_Y);
      g.fillStyle = rgba(T.stageInk3, 0.35);
      g.fillRect(0, FOOT_Y, W, 1);
      return c;
    }

    paintWheel(labels) {
      const T = this.theme;
      const r = WHEEL.r;
      const c = document.createElement('canvas');
      c.width = c.height = r * 2;
      const g = c.getContext('2d');
      g.translate(r, r);
      const n = labels.length;

      if (!n) {
        g.fillStyle = rgba(T.segEmpty);
        g.beginPath();
        g.arc(0, 0, r, 0, TAU);
        g.fill();
        g.strokeStyle = rgba(T.stageInk3, 0.2);
        g.lineWidth = 2;
        g.beginPath();
        for (let i = 0; i < 12; i++) {
          g.moveTo(0, 0);
          g.lineTo(Math.cos((i * TAU) / 12) * r, Math.sin((i * TAU) / 12) * r);
        }
        g.stroke();
        return c;
      }

      // Subpixel slices cannot be distinguished on a 750px wheel. Keep the full
      // roster for the pointer and draw outcome, but bound raster work for large lists.
      const painted = Math.min(n, MAX_PAINTED_BANDS);
      const slice = TAU / painted;
      const tones = [[T.seg1, T.seg1Hi], [T.seg2, T.seg2Hi], [T.seg3, T.seg3Hi], [T.seg4, T.seg4Hi]];
      const fills = tones.map(([deep, hi]) => {
        const grad = g.createRadialGradient(0, 0, 0, 0, 0, r);
        grad.addColorStop(0.2, rgba(deep));
        grad.addColorStop(1, rgba(hi));
        return grad;
      });
      const colorOf = segmentColors(painted, fills.length);

      g.fillStyle = fills[1]; // base coat hides anti-aliasing seams between slices
      g.beginPath();
      g.arc(0, 0, r, 0, TAU);
      g.fill();
      for (let i = 0; i < painted; i++) {
        g.beginPath();
        g.moveTo(0, 0);
        g.arc(0, 0, r, i * slice, (i + 1) * slice);
        g.closePath();
        g.fillStyle = fills[colorOf[i]];
        g.fill();
      }
      if (n > 1 && n <= 400) {
        g.strokeStyle = 'rgba(26, 17, 4, 0.55)';
        g.lineWidth = n > 120 ? 1 : 0.8 * U;
        g.beginPath();
        for (let i = 0; i < n; i++) {
          g.moveTo(0, 0);
          g.lineTo(Math.cos(i * slice) * r, Math.sin(i * slice) * r);
        }
        g.stroke();
      }
      if (n > 1 && n <= MAX_PEGS) {
        g.fillStyle = rgba(T.peg);
        g.strokeStyle = rgba(T.pegEdge);
        g.lineWidth = 0.7 * U;
        for (let i = 0; i < n; i++) {
          g.beginPath();
          g.arc(Math.cos(i * slice) * PEG_RING, Math.sin(i * slice) * PEG_RING, PEG_R, 0, TAU);
          g.fill();
          g.stroke();
        }
      }

      const size = Math.min(44, 0.55 * (r - 70) * slice);
      if (size >= 11) {
        const outer = (n <= MAX_PEGS ? PEG_RING - PEG_R : r) - 18;
        const inner = HUB + 34;
        g.font = `700 ${size.toFixed(1)}px ${T.fontBody}`;
        g.textAlign = 'right';
        g.textBaseline = 'middle';
        g.fillStyle = rgba(T.segInkDark);
        for (let i = 0; i < n; i++) {
          g.save();
          g.rotate((i + 0.5) * slice);
          g.fillText(truncate(g, labels[i], outer - inner), outer, 0);
          g.restore();
        }
      }
      return c;
    }

    /* ---------- per-frame layers ---------- */

    drawWheel(ctx, now) {
      const { cx, cy, r } = WHEEL;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(this.rotation);
      ctx.drawImage(this.wheel, -r, -r, r * 2, r * 2);
      if (this.highlight && this.labels.length > 1) {
        const slice = TAU / this.labels.length;
        const i = this.highlight.index;
        const k = Math.min(1, (now - this.highlight.t0) / 450);
        const e = 1 - Math.pow(1 - k, 3);
        // Dim the losers, light up the winning slice with a slow breathing glow.
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.arc(0, 0, r + 1, (i + 1) * slice, i * slice + TAU);
        ctx.closePath();
        ctx.fillStyle = `rgba(0, 0, 0, ${(0.45 * e).toFixed(3)})`;
        ctx.fill();
        const breath = this.reducedMotion ? 1 : 0.5 - 0.5 * Math.cos(((now - this.highlight.t0) / 1100) * Math.PI);
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.arc(0, 0, r - 2, i * slice, (i + 1) * slice);
        ctx.closePath();
        ctx.fillStyle = `rgba(255, 255, 255, ${(0.12 * breath * e).toFixed(3)})`;
        ctx.fill();
        ctx.lineJoin = 'round';
        ctx.lineWidth = 1.6 * U;
        ctx.shadowColor = `rgba(255, 214, 106, ${(0.95 * breath * e).toFixed(3)})`;
        ctx.shadowBlur = 5 * U;
        ctx.strokeStyle = rgba(this.theme.rimHi, e);
        ctx.stroke();
      }
      ctx.restore();
      this.drawSheen(ctx);
    }

    /** Fixed glassy highlight over the face, like light catching a lacquered wheel. */
    drawSheen(ctx) {
      const { cx, cy, r } = WHEEL;
      const sheen = ctx.createRadialGradient(cx - 0.24 * r, cy - 0.48 * r, 0, cx - 0.24 * r, cy - 0.48 * r, 1.5 * r);
      sheen.addColorStop(0, 'rgba(255, 255, 255, 0.34)');
      sheen.addColorStop(0.45, 'rgba(255, 255, 255, 0.06)');
      sheen.addColorStop(1, 'rgba(0, 0, 0, 0.22)');
      ctx.save();
      ctx.globalCompositeOperation = 'soft-light';
      ctx.fillStyle = sheen;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, TAU);
      ctx.fill();
      ctx.restore();
    }

    /** Marquee bulbs: a slow shimmer at rest, a running chase while spinning, four flashes on the result. */
    drawBulbs(ctx, now) {
      const T = this.theme;
      const { cx, cy } = WHEEL;
      const still = this.reducedMotion; // decorative light shows sit out under reduced motion
      const sinceResult = now - this.resultAt;
      const t = now / 1000;
      for (let k = 0; k < BULBS; k++) {
        const angle = POINTER + (k * TAU) / BULBS;
        const x = cx + Math.cos(angle) * BULB_RING;
        const y = cy + Math.sin(angle) * BULB_RING;
        let level;
        if (still) level = 1;
        else if (this.spin) level = mod(t + k * 0.07, 0.42) < 0.14 ? 1 : 0;
        else if (sinceResult < 2000) level = mod(sinceResult, 500) < 250 ? 1 : 0;
        else {
          const phase = mod(t - k * 0.15 - (k % 2) * 1.2, 2.4) / 2.4;
          level = 0.5 - 0.5 * Math.cos(phase * TAU);
        }
        if (level > 0.05) {
          const halo = ctx.createRadialGradient(x, y, BULB_R * 0.6, x, y, BULB_R * 2.6);
          halo.addColorStop(0, rgba(T.bulbGlow, 0.9 * level));
          halo.addColorStop(1, rgba(T.bulbGlow, 0));
          ctx.fillStyle = halo;
          ctx.beginPath();
          ctx.arc(x, y, BULB_R * 2.6, 0, TAU);
          ctx.fill();
        }
        ctx.beginPath();
        ctx.arc(x, y, BULB_R, 0, TAU);
        ctx.fillStyle = mix(T.bulbOff, T.bulbOn, level);
        ctx.fill();
        ctx.lineWidth = 0.5 * U;
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.4)';
        ctx.stroke();
      }
    }

    drawHub(ctx, now) {
      const T = this.theme;
      const { cx, cy } = WHEEL;
      const ring = RIM_R * 2 * 0.012;
      ctx.save();
      ctx.shadowColor = 'rgba(0, 0, 0, 0.5)';
      ctx.shadowBlur = 51;
      ctx.shadowOffsetY = 23;
      ctx.beginPath();
      ctx.arc(cx, cy, HUB + RIM_R * 2 * 0.022, 0, TAU);
      ctx.fillStyle = rgba(T.rim2);
      ctx.fill();
      ctx.restore();
      ctx.beginPath();
      ctx.arc(cx, cy, HUB + ring, 0, TAU);
      ctx.fillStyle = rgba(T.hubRing);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(cx, cy, HUB, 0, TAU);
      const face = ctx.createLinearGradient(0, cy - HUB, 0, cy + HUB);
      face.addColorStop(0, rgba(T.rimHi));
      face.addColorStop(0.18, rgba(T.rim));
      face.addColorStop(0.42, '#e8a527');
      face.addColorStop(0.58, rgba(T.rimMid));
      face.addColorStop(0.8, rgba(T.rim2));
      face.addColorStop(1, '#8d5a0c');
      ctx.fillStyle = face;
      ctx.fill();
      const gloss = ctx.createRadialGradient(cx - 0.3 * HUB, cy - 0.44 * HUB, 0, cx - 0.3 * HUB, cy - 0.44 * HUB, 0.84 * HUB);
      gloss.addColorStop(0, 'rgba(255, 255, 255, 0.55)');
      gloss.addColorStop(1, 'rgba(255, 255, 255, 0)');
      ctx.fillStyle = gloss;
      ctx.fill();

      ctx.save();
      ctx.translate(cx, cy - 34);
      ctx.scale(1.6, 1.6);
      ctx.fillStyle = rgba(T.segInkDark, 0.85);
      ctx.fill(paw());
      ctx.restore();
      // GO pulses while the wheel turns, like the LuckyWheel button.
      const pulse = this.spin && !this.reducedMotion ? 0.775 + 0.225 * Math.cos((now / 600) * Math.PI) : 1;
      this.text('GO', cx, cy + 52 + 2, { size: 64, weight: 800, color: T.rimHi, align: 'center', alpha: 0.45 * pulse });
      this.text('GO', cx, cy + 52, { size: 64, weight: 800, color: T.segInkDark, align: 'center', alpha: pulse });
    }

    /** Teardrop pointer hanging from a pin on the rim; the passing pegs flick its tip. */
    drawPointer(ctx) {
      const T = this.theme;
      const { cx, cy } = WHEEL;
      ctx.save();
      ctx.translate(cx, cy + PIN_Y);
      ctx.rotate(-this.kick * 0.35);
      ctx.translate(0, -PIN_Y);
      ctx.beginPath();
      ctx.moveTo(0, -73 * U);
      ctx.lineTo(-9.5 * U, -94.5 * U);
      ctx.quadraticCurveTo(0, -101 * U, 9.5 * U, -94.5 * U);
      ctx.closePath();
      ctx.shadowColor = 'rgba(0, 0, 0, 0.45)';
      ctx.shadowBlur = 2 * U;
      ctx.shadowOffsetY = 2 * U;
      ctx.fillStyle = metal(ctx, T, -101 * U, -73 * U);
      ctx.fill();
      ctx.shadowColor = 'transparent';
      ctx.lineJoin = 'round';
      ctx.lineWidth = 0.8 * U;
      ctx.strokeStyle = rgba(T.pointerEdge);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, PIN_Y, 2.6 * U, 0, TAU);
      ctx.fillStyle = rgba(T.rimHi);
      ctx.fill();
      ctx.lineWidth = 0.8 * U;
      ctx.strokeStyle = rgba(T.rimShade);
      ctx.stroke();
      ctx.restore();
    }

    drawInfo(ctx, now) {
      const T = this.theme;
      const v = this.view;
      const x = INFO.x;
      const w = INFO.w;

      const tag = this.text(`第 ${v.drawNo} 抽`, x + w, 116, { size: 30, weight: 600, color: T.stageAccent, align: 'right' });
      if (v.title) this.text(v.title, x, 116, { size: 34, weight: 600, color: T.stageInk2, maxW: w - tag.width - 32, min: 22 });

      this.text('本輪獎項', x, 206, { size: 26, weight: 600, color: T.stageInk3 });
      if (v.prize) {
        this.text(v.prize.name, x, 292, { size: 84, weight: 700, color: T.stageInk, maxW: w, min: 40 });
        this.text(`剩餘 ${v.prize.remaining} / ${v.prize.total} 名`, x, 350, { size: 28, weight: 500, color: T.stageInk2 });
        const drawn = v.prize.total - v.prize.remaining;
        ctx.fillStyle = rgba(T.stageInk3, 0.3);
        roundRect(ctx, x, 374, w, 8, 4);
        ctx.fill();
        if (drawn > 0 && v.prize.total > 0) {
          ctx.fillStyle = rgba(T.stageAccent);
          roundRect(ctx, x, 374, Math.max(8, (w * drawn) / v.prize.total), 8, 4);
          ctx.fill();
        }
      } else {
        this.text('尚未設定獎項', x, 288, { size: 56, weight: 700, color: T.stageInk3 });
      }

      ctx.fillStyle = rgba(T.stageInk3, 0.28);
      ctx.fillRect(x, 432, w, 2);
      const readout = v.readout || {};
      const isWinner = readout.tone === 'winner';
      this.text(readout.label || '', x, 494, { size: 28, weight: 600, color: isWinner ? T.stageAccent : T.stageInk3 });
      if (readout.tone === 'muted') {
        this.text(readout.text || '', x, 590, { size: 46, weight: 600, color: T.stageInk3, maxW: w, min: 28 });
      } else {
        const name = readout.text != null ? readout.text : this.labelAtPointer() || '—';
        let scale = 1;
        let alpha = 1;
        if (isWinner) {
          const k = Math.min(1, (now - this.resultAt) / (this.reducedMotion ? 150 : 480));
          const e = 1 - Math.pow(1 - k, 3);
          scale = this.reducedMotion ? 1 : 0.88 + 0.12 * e;
          alpha = 0.25 + 0.75 * e;
        }
        ctx.save();
        ctx.translate(x, 624);
        ctx.scale(scale, scale);
        const out = this.text(name, 0, 0, { size: 120, weight: 700, color: isWinner ? T.stageAccent : T.stageInk, maxW: w, min: 48, alpha });
        if (isWinner) {
          ctx.fillStyle = rgba(T.stageAccent, alpha);
          roundRect(ctx, 0, 30, Math.min(w, out.width), 8, 4);
          ctx.fill();
        }
        ctx.restore();
        if (isWinner && readout.detail) {
          this.text(readout.detail, x, 690, { size: 34, weight: 600, color: T.stageInk2, maxW: w, min: 24 });
        }
      }

      const winners = v.prizeWinners || [];
      if (winners.length) {
        this.text(`本獎項得獎者・${winners.length} 位`, x, 734, { size: 24, weight: 600, color: T.stageInk3 });
        const col = w / 2;
        winners.slice(0, 8).forEach((winner, i) => {
          const fresh = isWinner && i === 0;
          this.text(winner, x + (i % 2) * col, 784 + Math.floor(i / 2) * 48, {
            size: 30, weight: fresh ? 700 : 500, color: fresh ? T.stageAccent : T.stageInk2, maxW: col - 28, min: 20,
          });
        });
        if (winners.length > 8) {
          this.text(`…另有 ${winners.length - 8} 位`, x, 976, { size: 24, weight: 500, color: T.stageInk3 });
        }
      }
    }

    drawFooter() {
      const T = this.theme;
      const v = this.view;
      const y = FOOT_Y + 50;
      let x = 40;
      const pair = (label, value) => {
        x += this.text(label, x, y, { size: 22, weight: 500, color: T.stageInk3, mono: true }).width + 10;
        x += this.text(value, x, y, { size: 22, weight: 600, color: T.stageInk2, mono: true }).width + 40;
      };
      pair('場次', v.sessionId || '—');
      pair('抽次', String(v.drawNo));
      pair('候選', `${v.candidateCount} 人`);
      pair('名單指紋', LW.shortHash(v.fingerprint));
      pair('亂數', 'Web Crypto');
      const clock = LW.formatDateTime(new Date(), { tenths: !!this.recording });
      this.text(clock, W - 40, y, { size: 22, weight: 600, color: T.stageInk2, mono: true, align: 'right' });
    }

    drawRecBadge(ctx, now) {
      const T = this.theme;
      const elapsed = now - this.recording.startedAt;
      const x = 36;
      const y = 30;
      const w = 250;
      const h = 56;
      ctx.fillStyle = rgba(T.stageBand, 0.88);
      roundRect(ctx, x, y, w, h, h / 2);
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = rgba(T.stageRec, 0.7);
      ctx.stroke();
      if (mod(elapsed, 1000) < 640) {
        ctx.beginPath();
        ctx.arc(x + 30, y + h / 2, 11, 0, TAU);
        ctx.fillStyle = rgba(T.stageRec);
        ctx.fill();
      }
      this.text('REC', x + 52, y + 37, { size: 24, weight: 700, color: T.stageInk });
      this.text(LW.formatClock(elapsed), x + 112, y + 37, { size: 24, weight: 600, color: T.stageInk2, mono: true });
    }

    drawConfetti(ctx, dt) {
      const shape = paw();
      for (const p of this.confetti) {
        p.life += dt;
        p.vy += 900 * dt;
        p.vx *= 1 - 1.2 * dt;
        p.vy *= 1 - 0.6 * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.rot += p.vr * dt;
        const fade = Math.min(1, (p.ttl - p.life) / 0.6);
        ctx.setTransform(p.size, 0, 0, p.size, p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = rgba(p.color, Math.max(0, fade));
        ctx.fill(shape);
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      this.confetti = this.confetti.filter((p) => p.life < p.ttl && p.y < H + 40);
    }

    /* ---------- text ---------- */

    text(value, x, y, o) {
      const ctx = this.ctx;
      const family = o.mono ? this.theme.fontMono : this.theme.fontBody;
      const weight = o.weight || 400;
      let size = o.size;
      let str = String(value);
      if (o.maxW) ({ size, text: str } = this.fit(str, weight, family, o.size, o.min || o.size, o.maxW));
      ctx.font = `${weight} ${size}px ${family}`;
      ctx.textAlign = o.align || 'left';
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = rgba(o.color, o.alpha == null ? 1 : o.alpha);
      ctx.fillText(str, x, y);
      return { width: ctx.measureText(str).width, size };
    }

    /** Shrink to fit, then truncate with an ellipsis; memoised because names repeat every frame. */
    fit(str, weight, family, max, min, maxW) {
      const key = `${weight}|${max}|${min}|${maxW}|${family}|${str}`;
      let hit = this.fitCache.get(key);
      if (hit) return hit;
      const ctx = this.ctx;
      let size = max;
      ctx.font = `${weight} ${size}px ${family}`;
      let width = ctx.measureText(str).width;
      if (width > maxW) {
        size = Math.max(min, Math.floor((max * maxW) / width));
        ctx.font = `${weight} ${size}px ${family}`;
        width = ctx.measureText(str).width;
      }
      hit = { size, text: width > maxW ? truncate(ctx, str, maxW) : str };
      if (this.fitCache.size > 400) this.fitCache.clear();
      this.fitCache.set(key, hit);
      return hit;
    }
  }

  LW.Stage = Stage;
})(typeof window !== 'undefined' ? window : globalThis);

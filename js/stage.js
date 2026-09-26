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
  const WHEEL = { cx: 590, cy: 500, r: 420 };
  const RIM = 34;
  const HUB = 74;
  const BULBS = 28;
  const INFO = { x: 1150, w: 690 };
  const FOOT_Y = 1000;

  const TOKENS = [
    'stage-bg', 'stage-bloom', 'stage-band', 'stage-ink', 'stage-ink-2', 'stage-ink-3', 'stage-accent',
    'stage-rec', 'seg-1', 'seg-2', 'seg-3', 'seg-4', 'seg-ink-light', 'seg-ink-dark', 'seg-empty', 'rim',
    'rim-shade', 'bulb-on', 'bulb-off', 'hub', 'pointer', 'pointer-edge',
  ];

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
      if (n) this.rotation = mod(-(this.pointerIndex() + 0.5) * (TAU / n), TAU); // rest mid-slice
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
      return Math.min(n - 1, Math.floor(mod(-this.rotation, TAU) / (TAU / n)));
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
      const to = base + mod(-target - base, TAU);
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
      const T = this.theme;
      const colors = [T.seg1, T.seg2, T.seg4, T.stageAccent, T.bulbOn, T.seg3];
      for (let i = 0; i < 180; i++) {
        this.confetti.push({
          x: Math.random() * W,
          y: -20 - Math.random() * 360,
          vx: (Math.random() - 0.5) * 260,
          vy: 140 + Math.random() * 240,
          rot: Math.random() * TAU,
          vr: (Math.random() - 0.5) * 9,
          w: 10 + Math.random() * 12,
          h: 6 + Math.random() * 8,
          phase: Math.random() * TAU,
          sway: 1.4 + Math.random() * 2.2,
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
      this.drawHub(ctx);
      this.drawPointer(ctx);
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
      const bloom = g.createRadialGradient(cx, cy, r * 0.4, cx, cy, r * 1.9);
      bloom.addColorStop(0, rgba(T.stageBloom, 0.85));
      bloom.addColorStop(1, rgba(T.stageBloom, 0));
      g.fillStyle = bloom;
      g.fillRect(0, 0, W, H);

      g.save();
      g.shadowColor = rgba(T.stageBand, 0.9);
      g.shadowBlur = 70;
      g.shadowOffsetY = 26;
      g.fillStyle = rgba(T.rimShade);
      g.beginPath();
      g.arc(cx, cy, r + RIM, 0, TAU);
      g.fill();
      g.restore();

      const rim = g.createLinearGradient(cx - r, cy - r - RIM, cx + r, cy + r + RIM);
      rim.addColorStop(0, rgba(T.rim));
      rim.addColorStop(1, rgba(T.rimShade));
      g.fillStyle = rim;
      g.beginPath();
      g.arc(cx, cy, r + RIM, 0, TAU);
      g.fill();
      g.lineWidth = 3;
      g.strokeStyle = rgba(T.pointerEdge, 0.7);
      g.stroke();
      g.beginPath();
      g.arc(cx, cy, r + 3, 0, TAU);
      g.lineWidth = 6;
      g.strokeStyle = rgba(T.rimShade);
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

      const slice = TAU / n;
      const fills = [T.seg1, T.seg2, T.seg3, T.seg4];
      const inks = [T.segInkLight, T.segInkDark, T.segInkLight, T.segInkDark];
      const colorOf = segmentColors(n, fills.length);

      g.fillStyle = rgba(T.seg3); // base coat hides anti-aliasing seams between slices
      g.beginPath();
      g.arc(0, 0, r, 0, TAU);
      g.fill();
      for (let i = 0; i < n; i++) {
        g.beginPath();
        g.moveTo(0, 0);
        g.arc(0, 0, r, i * slice, (i + 1) * slice);
        g.closePath();
        g.fillStyle = rgba(fills[colorOf[i]]);
        g.fill();
      }
      if (n > 1 && n <= 400) {
        g.strokeStyle = rgba(T.rimShade, 0.55);
        g.lineWidth = n > 120 ? 1 : 2;
        g.beginPath();
        for (let i = 0; i < n; i++) {
          g.moveTo(0, 0);
          g.lineTo(Math.cos(i * slice) * r, Math.sin(i * slice) * r);
        }
        g.stroke();
      }

      const size = Math.min(44, 0.55 * (r - 70) * slice);
      if (size >= 11) {
        const outer = r - 24;
        const inner = HUB + 30;
        g.font = `600 ${size.toFixed(1)}px ${T.fontBody}`;
        g.textAlign = 'right';
        g.textBaseline = 'middle';
        for (let i = 0; i < n; i++) {
          g.save();
          g.rotate((i + 0.5) * slice);
          g.fillStyle = rgba(inks[colorOf[i]]);
          g.fillText(truncate(g, labels[i], outer - inner), outer, 0);
          g.restore();
        }
      }

      const shade = g.createRadialGradient(0, 0, r * 0.78, 0, 0, r);
      shade.addColorStop(0, rgba(T.stageBg, 0));
      shade.addColorStop(1, rgba(T.stageBg, 0.3));
      g.fillStyle = shade;
      g.beginPath();
      g.arc(0, 0, r, 0, TAU);
      g.fill();
      return c;
    }

    /* ---------- per-frame layers ---------- */

    drawWheel(ctx, now) {
      const T = this.theme;
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
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.arc(0, 0, r + 1, (i + 1) * slice, i * slice + TAU);
        ctx.closePath();
        ctx.fillStyle = rgba(T.stageBg, 0.6 * e);
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.arc(0, 0, r - 3, i * slice, (i + 1) * slice);
        ctx.closePath();
        ctx.lineJoin = 'round';
        ctx.lineWidth = 6;
        ctx.strokeStyle = rgba(T.stageAccent, e);
        ctx.stroke();
      }
      ctx.restore();
    }

    drawBulbs(ctx, now) {
      const T = this.theme;
      const { cx, cy, r } = WHEEL;
      const ring = r + RIM / 2;
      const still = this.reducedMotion; // decorative light shows sit out under reduced motion
      const flashing = !still && now - this.resultAt < 3600;
      const step = Math.floor(now / 110);
      for (let k = 0; k < BULBS; k++) {
        const angle = ((k + 0.5) * TAU) / BULBS;
        const x = cx + Math.cos(angle) * ring;
        const y = cy + Math.sin(angle) * ring;
        let on = true;
        if (this.spin && !still) on = mod(k - step, 3) === 0;
        else if (flashing) on = Math.floor(now / 180) % 2 === 0;
        if (on) {
          ctx.beginPath();
          ctx.arc(x, y, 13, 0, TAU);
          ctx.fillStyle = rgba(T.bulbOn, 0.16);
          ctx.fill();
        }
        ctx.beginPath();
        ctx.arc(x, y, 7.5, 0, TAU);
        ctx.fillStyle = rgba(on ? T.bulbOn : T.bulbOff);
        ctx.fill();
      }
    }

    drawHub(ctx) {
      const T = this.theme;
      const { cx, cy } = WHEEL;
      ctx.beginPath();
      ctx.arc(cx, cy, HUB + 9, 0, TAU);
      ctx.fillStyle = rgba(T.rim);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(cx, cy, HUB, 0, TAU);
      ctx.fillStyle = rgba(T.hub);
      ctx.fill();
      const count = String(this.view.candidateCount);
      this.text(count, cx, cy + 10, { size: count.length > 3 ? 36 : 46, weight: 700, color: T.stageInk, align: 'center' });
      this.text('候選人', cx, cy + 42, { size: 20, weight: 500, color: T.stageInk3, align: 'center' });
    }

    drawPointer(ctx) {
      const T = this.theme;
      const { cx, cy, r } = WHEEL;
      const pivot = cx + r + RIM + 34;
      const length = pivot - (cx + r - 12);
      const radius = 30;
      const phi = Math.acos(radius / length);
      ctx.save();
      ctx.translate(pivot, cy);
      ctx.rotate(-this.kick * 0.32); // flicks against the passing pegs
      ctx.beginPath();
      ctx.moveTo(-length, 0);
      ctx.lineTo(Math.cos(Math.PI + phi) * radius, Math.sin(Math.PI + phi) * radius);
      ctx.arc(0, 0, radius, Math.PI + phi, Math.PI - phi + TAU);
      ctx.closePath();
      ctx.shadowColor = rgba(T.stageBand, 0.85);
      ctx.shadowBlur = 18;
      ctx.shadowOffsetY = 8;
      const fill = ctx.createLinearGradient(0, -radius, 0, radius);
      fill.addColorStop(0, rgba(T.pointer));
      fill.addColorStop(1, rgba(T.rim));
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;
      ctx.shadowOffsetY = 0;
      ctx.lineWidth = 3;
      ctx.strokeStyle = rgba(T.pointerEdge);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, 0, 9, 0, TAU);
      ctx.fillStyle = rgba(T.pointerEdge);
      ctx.fill();
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
      for (const p of this.confetti) {
        p.vy = Math.min(460, p.vy + 150 * dt);
        p.vx *= 1 - 0.6 * dt;
        p.phase += p.sway * dt;
        p.x += (p.vx + Math.sin(p.phase) * 45) * dt;
        p.y += p.vy * dt;
        p.rot += p.vr * dt;
        ctx.setTransform(1, 0, 0, 1, p.x, p.y);
        ctx.rotate(p.rot);
        ctx.scale(1, Math.cos(p.phase * 2));
        ctx.fillStyle = rgba(p.color);
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      this.confetti = this.confetti.filter((p) => p.y < H + 40);
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

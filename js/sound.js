/* 抽獎轉盤 — synthesized sound effects (no audio files needed).
 * Everything routes through one master gain that feeds both the speakers and a
 * MediaStream destination, so the recorded video carries the same sound the room heard. */
(function (root) {
  'use strict';
  const LW = (root.LW = root.LW || {});

  const VOLUME = 0.8;
  let ctx = null;
  let master = null;
  let tap = null;
  let enabled = true;

  function ensure() {
    if (ctx) return ctx;
    const AC = root.AudioContext || root.webkitAudioContext;
    if (!AC) return null;
    try {
      ctx = new AC({ latencyHint: 'interactive' });
    } catch (_) {
      return null;
    }
    master = ctx.createGain();
    master.gain.value = enabled ? VOLUME : 0;
    master.connect(ctx.destination);
    if (ctx.createMediaStreamDestination) {
      tap = ctx.createMediaStreamDestination();
      master.connect(tap);
    }
    return ctx;
  }

  const live = () => ctx && ctx.state === 'running';

  function voice(type, freq, start, duration, peak, glideTo) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, start);
    if (glideTo) osc.frequency.exponentialRampToValueAtTime(glideTo, start + duration * 0.6);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(peak, start + Math.min(0.012, duration / 4));
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    osc.connect(gain).connect(master);
    osc.start(start);
    osc.stop(start + duration + 0.02);
  }

  const Sound = {
    /** Call synchronously inside a click/keydown handler — browsers only start audio from a gesture. */
    unlock() {
      const c = ensure();
      if (c && c.state !== 'running') c.resume().catch(() => {});
    },

    setEnabled(on) {
      enabled = !!on;
      if (master) master.gain.setTargetAtTime(enabled ? VOLUME : 0, ctx.currentTime, 0.015);
    },

    /** Audio track for the recorder; null until the context is running. */
    track() {
      if (!live() || !tap) return null;
      return tap.stream.getAudioTracks()[0] || null;
    },

    tick() {
      if (!enabled || !live()) return;
      voice('triangle', 1900, ctx.currentTime, 0.05, 0.32, 700);
    },

    fanfare() {
      if (!enabled || !live()) return;
      const t0 = ctx.currentTime + 0.03;
      const notes = [523.25, 659.25, 783.99, 1046.5]; // C5 E5 G5 C6
      notes.forEach((freq, i) => {
        const last = i === notes.length - 1;
        const t = t0 + i * 0.11;
        voice('triangle', freq, t, last ? 1.3 : 0.24, last ? 0.3 : 0.24);
        voice('sine', freq * 2, t, last ? 1.1 : 0.2, 0.06);
      });
      voice('sine', 1318.5, t0 + 0.44, 1.2, 0.07);
      voice('sine', 1568.0, t0 + 0.5, 1.1, 0.05);
    },
  };

  LW.Sound = Sound;
})(typeof window !== 'undefined' ? window : globalThis);

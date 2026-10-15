/**
 * Sound for the live map: synthesized with the Web Audio API, no audio files.
 * Every sound is a few tens of milliseconds long (crackle of lightning, a bright
 * zap, a low thunder thump) so it can follow messages that arrive back to back.
 *
 * Browsers only allow audio after a user gesture: the engine unlocks itself on
 * the first click/tap/key, then plays. The on/off choice and volume persist.
 *
 * by Wisnu Alfian Nur Ashar
 */

const KEY = 'wanarSfx';

function load() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '{}');
    return { on: v.on !== false, volume: Number.isFinite(v.volume) ? Math.min(1, Math.max(0, v.volume)) : 0.55 };
  } catch {
    return { on: true, volume: 0.55 };
  }
}

class Sfx {
  constructor() {
    const s = load();
    this.on = s.on;
    this.volume = s.volume;
    this.ctx = null;
    this.master = null;
    this.noise = null;
    this.lastAt = 0;
    this.active = 0;
    this.unlocked = false;
    this._gesture = () => this.unlock();
    if (typeof window !== 'undefined') {
      for (const ev of ['pointerdown', 'keydown', 'touchstart']) window.addEventListener(ev, this._gesture, { passive: true });
    }
  }

  _save() {
    try { localStorage.setItem(KEY, JSON.stringify({ on: this.on, volume: this.volume })); } catch { /* private mode */ }
  }

  unlock() {
    if (this.unlocked && this.ctx?.state === 'running') return;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      if (!this.ctx) {
        this.ctx = new AC({ latencyHint: 'interactive' });
        const comp = this.ctx.createDynamicsCompressor();
        comp.threshold.value = -14; comp.knee.value = 12; comp.ratio.value = 6; comp.attack.value = 0.002; comp.release.value = 0.12;
        this.master = this.ctx.createGain();
        this.master.gain.value = this.volume;
        this.master.connect(comp).connect(this.ctx.destination);
        // one second of white noise, reused by every crackle
        const len = this.ctx.sampleRate;
        this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
        const d = this.noise.getChannelData(0);
        for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      }
      this.ctx.resume?.().then(() => { this.unlocked = this.ctx.state === 'running'; }).catch(() => {});
      this.unlocked = this.ctx.state === 'running';
    } catch { /* audio unavailable */ }
  }

  setOn(on) {
    this.on = Boolean(on);
    this._save();
    if (this.on) { this.unlock(); this.play('in', 0.7); }
  }

  setVolume(v) {
    this.volume = Math.min(1, Math.max(0, v));
    if (this.master) this.master.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.02);
    this._save();
  }

  /** Short filtered noise burst — the crackle of a spark. */
  _crack(t, { dur = 0.12, f0 = 2500, f1 = 7000, q = 1.2, gain = 0.5, type = 'bandpass' } = {}) {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 0.8 + Math.random() * 0.6;
    const f = this.ctx.createBiquadFilter();
    f.type = type; f.Q.value = q;
    f.frequency.setValueAtTime(f0, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(40, f1), t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(this.master);
    src.start(t, Math.random() * 0.5, dur + 0.02);
    return g;
  }

  /** Pitched tone with a fast sweep. */
  _tone(t, { f0 = 800, f1 = 1600, dur = 0.09, gain = 0.25, wave = 'triangle' } = {}) {
    const o = this.ctx.createOscillator();
    o.type = wave;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(30, f1), t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  /**
   * @param {'in'|'route'|'ok'|'fail'|'tool'|'out'|'alert'|'shield'|'tick'} kind
   * @param {number} [power=1] 0..1.5 scales loudness
   */
  play(kind, power = 1) {
    if (!this.on || !this.ctx || this.ctx.state !== 'running') return;
    const nowMs = performance.now();
    if (nowMs - this.lastAt < 35 || this.active > 7) return; // never a wall of noise
    this.lastAt = nowMs;
    this.active += 1;
    setTimeout(() => { this.active = Math.max(0, this.active - 1); }, 220);
    const t = this.ctx.currentTime + 0.001;
    const p = Math.min(1.5, Math.max(0.2, power));
    try {
      switch (kind) {
        case 'in': // message arrives: sharp lightning crack + low thump
          this._crack(t, { dur: 0.14, f0: 1800, f1: 9000, q: 0.9, gain: 0.55 * p, type: 'highpass' });
          this._crack(t + 0.012, { dur: 0.06, f0: 5200, f1: 2400, q: 3, gain: 0.35 * p });
          this._tone(t, { f0: 130, f1: 38, dur: 0.22, gain: 0.35 * p, wave: 'sine' });
          break;
        case 'route': // request leaves for a model: rising whoosh
          this._crack(t, { dur: 0.11, f0: 600, f1: 5200, q: 2.2, gain: 0.3 * p });
          this._tone(t, { f0: 420, f1: 1500, dur: 0.1, gain: 0.12 * p, wave: 'sawtooth' });
          break;
        case 'ok': // answer is back: bright double zap
          this._crack(t, { dur: 0.08, f0: 4000, f1: 8000, q: 2, gain: 0.35 * p });
          this._tone(t, { f0: 880, f1: 1760, dur: 0.07, gain: 0.22 * p });
          this._tone(t + 0.07, { f0: 1320, f1: 2640, dur: 0.09, gain: 0.18 * p });
          break;
        case 'fail': // failure: low buzz and a broken crackle
          this._tone(t, { f0: 190, f1: 70, dur: 0.2, gain: 0.3 * p, wave: 'sawtooth' });
          this._crack(t, { dur: 0.16, f0: 1500, f1: 300, q: 1, gain: 0.4 * p });
          break;
        case 'tool': // tool call: mechanical double click
          this._tone(t, { f0: 1700, f1: 900, dur: 0.03, gain: 0.2 * p, wave: 'square' });
          this._tone(t + 0.045, { f0: 2300, f1: 1200, dur: 0.03, gain: 0.16 * p, wave: 'square' });
          break;
        case 'out': // reply delivered: descending sweep with a soft thump
          this._crack(t, { dur: 0.16, f0: 7000, f1: 1200, q: 1.6, gain: 0.35 * p });
          this._tone(t, { f0: 1500, f1: 520, dur: 0.14, gain: 0.16 * p });
          this._tone(t + 0.02, { f0: 110, f1: 55, dur: 0.18, gain: 0.25 * p, wave: 'sine' });
          break;
        case 'alert': // security event: two short alarm pulses
          this._tone(t, { f0: 540, f1: 520, dur: 0.07, gain: 0.2 * p, wave: 'square' });
          this._tone(t + 0.1, { f0: 540, f1: 520, dur: 0.07, gain: 0.2 * p, wave: 'square' });
          break;
        case 'shield': // blocked at the perimeter: metallic clang
          this._crack(t, { dur: 0.1, f0: 3000, f1: 1000, q: 6, gain: 0.35 * p });
          this._tone(t, { f0: 1200, f1: 900, dur: 0.18, gain: 0.14 * p, wave: 'triangle' });
          break;
        default:
          this._tone(t, { f0: 1000, f1: 1400, dur: 0.04, gain: 0.12 * p });
      }
    } catch { /* never let sound break the map */ }
  }
}

export const sfx = new Sfx();

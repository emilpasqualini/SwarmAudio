//
//  global.ts
//  HIVE (server)
//
//  Swarm meta-parameters: the whole hive as one signal, signal-processing style.
//
//  `/hive/swarm` answers "how much" (energy, motion, sync). This answers "how"
//  — do people move alike (coherence), are they in step (phaseSync), how fast
//  is the collective rhythm (tempo), is it a sway or a jitter (centroid), is
//  it everyone or a soloist (entropy), how different are the tilts
//  (dispersion), which way does the room lean (leanX/Y), how bursty
//  (onsets), how spiky (crest). Each phone keeps a few seconds of history in
//  a ring buffer; a 30 Hz swarm-level energy series feeds the rhythm features.
//  Every number is cheap: pairs × one second of samples, one 128-point FFT.
//

import type { Registry } from './registry';
import type { GlobalFeatures, Sample } from '../shared/types';

const HISTORY = 256;          // samples per phone (~4 s at 60 Hz)
const WINDOW = 60;            // samples for coherence (~1 s)
const PHASE_WINDOW = 180;     // samples for the phase (~3 s: slow sways still get two crossings)
const SERIES = 128;           // swarm energy samples at the tick rate (~4 s at 30 Hz)
const ONSET_WINDOW_MS = 2000;
const IDLE_THRESHOLD = 0.06;

interface Track {
  relX: Float32Array; relY: Float32Array; relZ: Float32Array; mag: Float32Array; act: Float32Array;
  head: number; filled: number;
  wasActive: boolean;
  onsets: number[];           // timestamps
  lastSeen: number;
  last: Sample | null;
}

/** In-place radix-2 FFT, real input in `re`, `im` zero on entry. n must be a power of two. */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j]!, re[i]!]; [im[i], im[j]] = [im[j]!, im[i]!]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = i + k + len / 2;
        const tr = re[b]! * cr - im[b]! * ci, ti = re[b]! * ci + im[b]! * cr;
        re[b] = re[a]! - tr; im[b] = im[a]! - ti;
        re[a] = re[a]! + tr; im[a] = im[a]! + ti;
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

export class Global {
  private readonly tracks = new Map<string, Track>();
  private readonly series = new Float32Array(SERIES);
  private seriesHead = 0;
  private seriesFilled = 0;
  private readonly listeners: ((g: GlobalFeatures) => void)[] = [];
  private timer: NodeJS.Timeout | null = null;
  latest: GlobalFeatures = Global.empty(Date.now());

  constructor(registry: Registry, private hz: number) {
    registry.on('sample', (s) => this.push(s));
    registry.on('leave', (d) => this.tracks.delete(d.uid));
  }

  static empty(t: number): GlobalFeatures {
    return { t, count: 0, coherence: 0, phaseSync: 0, tempo: 0, centroid: 0, entropy: 0, dispersion: 0, leanX: 0, leanY: 0, onsets: 0, crest: 0 };
  }

  on(fn: (g: GlobalFeatures) => void): void { this.listeners.push(fn); }
  setHz(hz: number): void { this.hz = hz; if (this.timer) { this.stop(); this.start(); } }
  start(): void { this.timer ??= setInterval(() => this.tick(), 1000 / this.hz); }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }

  private push(s: Sample): void {
    let t = this.tracks.get(s.uid);
    if (!t) {
      t = {
        relX: new Float32Array(HISTORY), relY: new Float32Array(HISTORY), relZ: new Float32Array(HISTORY),
        mag: new Float32Array(HISTORY), act: new Float32Array(HISTORY),
        head: 0, filled: 0, wasActive: false, onsets: [], lastSeen: 0, last: null,
      };
      this.tracks.set(s.uid, t);
    }
    const i = t.head;
    t.relX[i] = s.rel[0]; t.relY[i] = s.rel[1]; t.relZ[i] = s.rel[2];
    t.mag[i] = Math.hypot(s.rel[0], s.rel[1], s.rel[2]);
    t.act[i] = s.activity;
    t.head = (i + 1) % HISTORY;
    t.filled = Math.min(HISTORY, t.filled + 1);
    const active = s.activity >= IDLE_THRESHOLD;
    if (active && !t.wasActive) t.onsets.push(s.t);
    t.wasActive = active;
    t.lastSeen = s.t;
    t.last = s;
  }

  /** The last `n` samples of a ring, oldest first. */
  private static window(buf: Float32Array, head: number, filled: number, n: number): Float32Array {
    const k = Math.min(n, filled);
    const out = new Float32Array(k);
    for (let j = 0; j < k; j++) out[j] = buf[(head - k + j + HISTORY) % HISTORY]!;
    return out;
  }

  private static pearson(a: Float32Array, b: Float32Array): number {
    const n = Math.min(a.length, b.length);
    if (n < 8) return 0;
    let ma = 0, mb = 0;
    for (let i = 0; i < n; i++) { ma += a[i]!; mb += b[i]!; }
    ma /= n; mb /= n;
    let sab = 0, saa = 0, sbb = 0;
    for (let i = 0; i < n; i++) { const da = a[i]! - ma, db = b[i]! - mb; sab += da * db; saa += da * da; sbb += db * db; }
    return saa > 1e-6 && sbb > 1e-6 ? sab / Math.sqrt(saa * sbb) : 0;
  }

  /** Phase of an oscillation from its last two same-direction zero crossings; null when there is none. */
  private static phase(x: Float32Array): number | null {
    const n = x.length;
    if (n < 16) return null;
    let mean = 0;
    for (let i = 0; i < n; i++) mean += x[i]!;
    mean /= n;
    const ups: number[] = [];
    for (let i = 1; i < n; i++) if (x[i - 1]! - mean < 0 && x[i]! - mean >= 0) ups.push(i);
    if (ups.length < 2) return null;
    const last = ups[ups.length - 1]!, prev = ups[ups.length - 2]!;
    const period = last - prev;
    if (period < 4) return null;
    return 2 * Math.PI * ((n - 1 - last) / period);
  }

  compute(now = Date.now()): GlobalFeatures {
    const live = [...this.tracks.values()].filter((t) => t.last && now - t.lastSeen < 1500 && t.filled >= 8);
    const count = live.length;
    const g = Global.empty(now);
    g.count = count;

    // swarm energy series at the tick rate: mean |rel| over live phones
    let meanMag = 0;
    for (const t of live) meanMag += t.mag[(t.head - 1 + HISTORY) % HISTORY]!;
    meanMag = count ? meanMag / count : 0;
    this.series[this.seriesHead] = meanMag;
    this.seriesHead = (this.seriesHead + 1) % SERIES;
    this.seriesFilled = Math.min(SERIES, this.seriesFilled + 1);

    if (count === 0) return g;

    // lean, dispersion, entropy, onsets — from the latest samples
    let sx = 0, sy = 0, sz = 0, actSum = 0;
    const acts: number[] = [];
    for (const t of live) {
      const r = t.last!.rel;
      sx += r[0]; sy += r[1]; sz += r[2];
      const a = t.last!.activity;
      acts.push(a); actSum += a;
    }
    g.leanX = sx / count; g.leanY = sy / count;
    const mz = sz / count;
    let disp = 0;
    for (const t of live) {
      const r = t.last!.rel;
      disp += (r[0] - g.leanX) ** 2 + (r[1] - g.leanY) ** 2 + (r[2] - mz) ** 2;
    }
    g.dispersion = Math.sqrt(disp / count);
    if (count > 1 && actSum > 1e-3) {
      let h = 0;
      for (const a of acts) { const p = a / actSum; if (p > 0) h -= p * Math.log(p); }
      g.entropy = h / Math.log(count);
    } else {
      g.entropy = count > 1 ? 1 : 0;
    }
    let onsets = 0;
    for (const t of live) {
      while (t.onsets.length && now - t.onsets[0]! > ONSET_WINDOW_MS) t.onsets.shift();
      onsets += t.onsets.length;
    }
    g.onsets = onsets / (ONSET_WINDOW_MS / 1000);

    // coherence and phase sync — one second of history per phone
    if (count > 1) {
      const mags = live.map((t) => Global.window(t.mag, t.head, t.filled, WINDOW));
      let sum = 0, pairs = 0;
      for (let i = 0; i < count; i++) for (let j = i + 1; j < count; j++) { sum += Global.pearson(mags[i]!, mags[j]!); pairs++; }
      g.coherence = pairs ? sum / pairs : 0;
      let re = 0, im = 0, m = 0;
      for (const t of live) {
        const ph = Global.phase(Global.window(t.relY, t.head, t.filled, PHASE_WINDOW));
        if (ph === null) continue;
        re += Math.cos(ph); im += Math.sin(ph); m++;
      }
      g.phaseSync = m > 1 ? Math.hypot(re, im) / m : 0;
    }

    // rhythm — from the swarm energy series
    const n = this.seriesFilled;
    if (n >= 32) {
      const x = new Float64Array(SERIES);
      let mean = 0;
      for (let j = 0; j < n; j++) { x[j] = this.series[(this.seriesHead - n + j + SERIES) % SERIES]!; mean += x[j]!; }
      mean /= n;
      // crest: peak / rms over the last ~2 s
      const k = Math.min(n, Math.round(2 * this.hz));
      let peak = 0, sq = 0;
      for (let j = n - k; j < n; j++) { peak = Math.max(peak, x[j]!); sq += x[j]! * x[j]!; }
      const rms = Math.sqrt(sq / k);
      g.crest = rms > 1e-4 ? peak / rms : 0;
      // demean + Hann for the spectral features
      const re = new Float64Array(SERIES), im = new Float64Array(SERIES);
      let power = 0;
      for (let j = 0; j < n; j++) { const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * j / (n - 1)); re[j] = (x[j]! - mean) * w; power += re[j]! * re[j]!; }
      if (power > 1e-6) {
        // tempo: the strongest *local* peak of the autocorrelation between
        // 0.5 and 6 Hz — the global maximum would always sit at the smallest
        // lag for any smooth signal.
        const minLag = Math.max(2, Math.round(this.hz / 6)), maxLag = Math.min(n - 3, Math.round(this.hz / 0.5));
        let r0 = 0;
        for (let j = 0; j < n; j++) r0 += re[j]! * re[j]!;
        const ac = new Float64Array(maxLag + 2);
        for (let lag = minLag - 1; lag <= maxLag + 1; lag++) {
          let r = 0;
          for (let j = lag; j < n; j++) r += re[j]! * re[j - lag]!;
          ac[lag] = r / r0;
        }
        let best = 0, bestLag = 0;
        for (let lag = minLag; lag <= maxLag; lag++) {
          if (ac[lag]! > ac[lag - 1]! && ac[lag]! >= ac[lag + 1]! && ac[lag]! > best) { best = ac[lag]!; bestLag = lag; }
        }
        g.tempo = best > 0.3 && bestLag > 0 ? this.hz / bestLag : 0;
        fft(re, im);
        let num = 0, den = 0;
        for (let b = 1; b < SERIES / 2; b++) {
          const p = re[b]! * re[b]! + im[b]! * im[b]!;
          num += p * (b * this.hz / SERIES); den += p;
        }
        g.centroid = den > 0 ? num / den : 0;
      }
    }
    return g;
  }

  private tick(): void {
    this.latest = this.compute();
    for (const fn of this.listeners) fn(this.latest);
  }
}

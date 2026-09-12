//
//  dsp.ts
//  HIVE (server)
//
//  Small signal-processing helpers shared by the swarm's meta-parameters
//  (global.ts) and the camera's crowd field (vision.ts): a radix-2 FFT, and
//  the "what rhythm is this" question answered by the strongest local peak of
//  an autocorrelation.
//

/** In-place radix-2 FFT, real input in `re`, `im` zero on entry. n must be a power of two. */
export function fft(re: Float64Array, im: Float64Array): void {
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

/** Demeaned, Hann-windowed copy of the last `n` values of a series (oldest first). */
export function windowed(x: Float64Array, n: number): { y: Float64Array; power: number } {
  let mean = 0;
  for (let j = 0; j < n; j++) mean += x[j]!;
  mean /= n;
  const y = new Float64Array(n);
  let power = 0;
  for (let j = 0; j < n; j++) { const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * j / (n - 1)); y[j] = (x[j]! - mean) * w; power += y[j]! * y[j]!; }
  return { y, power };
}

/**
 * Dominant rhythm of a windowed series sampled at `hz`: the strongest *local*
 * maximum of the normalised autocorrelation between `fMin` and `fMax` Hz (the
 * global maximum would always sit at the smallest lag for any smooth signal).
 * Returns the frequency and the peak's height (0..1), or 0/0 when nothing
 * repeats (peak below `threshold`).
 */
export function tempoOf(y: Float64Array, hz: number, fMin = 0.5, fMax = 6, threshold = 0.3): { hz: number; strength: number } {
  const n = y.length;
  const minLag = Math.max(2, Math.round(hz / fMax)), maxLag = Math.min(n - 3, Math.round(hz / fMin));
  if (maxLag <= minLag) return { hz: 0, strength: 0 };
  let r0 = 0;
  for (let j = 0; j < n; j++) r0 += y[j]! * y[j]!;
  if (r0 < 1e-9) return { hz: 0, strength: 0 };
  const ac = new Float64Array(maxLag + 2);
  for (let lag = minLag - 1; lag <= maxLag + 1; lag++) {
    let r = 0;
    for (let j = lag; j < n; j++) r += y[j]! * y[j - lag]!;
    ac[lag] = r / r0;
  }
  // all local peaks; a periodic signal repeats at every multiple of its period,
  // so among peaks nearly as high as the highest take the shortest lag — the
  // fundamental, not a sub-harmonic
  const peaks: { lag: number; r: number }[] = [];
  for (let lag = minLag; lag <= maxLag; lag++) {
    if (ac[lag]! > ac[lag - 1]! && ac[lag]! >= ac[lag + 1]! && ac[lag]! > threshold) peaks.push({ lag, r: ac[lag]! });
  }
  if (peaks.length === 0) return { hz: 0, strength: 0 };
  const top = Math.max(...peaks.map((p) => p.r));
  const first = peaks.find((p) => p.r >= 0.8 * top)!;
  return { hz: hz / first.lag, strength: first.r };
}

/** Spectral centroid in Hz of a windowed series (zero-padded to a power of two). */
export function spectralCentroid(y: Float64Array, hz: number): number {
  let n = 1;
  while (n < y.length) n <<= 1;
  const re = new Float64Array(n), im = new Float64Array(n);
  re.set(y);
  fft(re, im);
  let num = 0, den = 0;
  for (let b = 1; b < n / 2; b++) {
    const p = re[b]! * re[b]! + im[b]! * im[b]!;
    num += p * (b * hz / n); den += p;
  }
  return den > 0 ? num / den : 0;
}

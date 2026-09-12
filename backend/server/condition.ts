//
//  condition.ts
//  HIVE (server)
//
//  Per-device signal conditioning: smoothing, an activity level, an adaptive
//  zero, and the rotation about the vertical.
//
//  A phone held at a comfortable angle, or lying on a table, reports a steady
//  gravity vector that means nothing musically — only *change* does. So each
//  device carries a baseline: the acceleration it has been resting at. While a
//  phone is active the baseline holds still; once it has been at rest for a
//  moment, the baseline slides toward the resting value, and the relative
//  acceleration (`rel`) settles back to zero. Everything downstream — OSC,
//  the feed, the wall — gets `rel`, `activity` and `turn` next to the raw values.
//
//  Smoothing is a One-Euro filter (Casiez, Roussel, Vogel 2012) rather than a
//  fixed low-pass: at rest the cutoff is low and the jitter goes away, and as
//  soon as the signal moves the cutoff rises with the speed of change, so a
//  flick of the wrist arrives without the lag a fixed filter would add. Two
//  knobs, both on the dashboard: `minCutoff` (Hz, the rest-state smoothing)
//  and `beta` (how eagerly the cutoff follows speed).
//

export interface ConditionParams {
  /** Seconds at rest before the baseline starts to move. */
  idleAfter: number;
  /** Time constant of the baseline's slide, seconds. */
  baselineTau: number;
  /** One-Euro: cutoff at rest, Hz. Lower = smoother and laggier when still. */
  minCutoff: number;
  /** One-Euro: cutoff gain per unit of speed (m/s² per s). Higher = follows fast moves more tightly. */
  beta: number;
}

const D_CUTOFF = 1.0;        // One-Euro: cutoff of the speed estimate, Hz (the paper's default)
const ACTIVITY_TAU = 0.25;   // activity envelope, seconds
const ACTIVITY_GYRO = 150;   // °/s that counts as fully active
const ACTIVITY_JOLT = 6;     // m/s² change per sample that counts as fully active
const IDLE_THRESHOLD = 0.06;

const alpha = (tau: number, dt: number): number => 1 - Math.exp(-dt / tau);

/** One-Euro smoothing factor for a cutoff in Hz over a step of dt seconds. */
const cutoffAlpha = (cutoff: number, dt: number): number => {
  const r = 2 * Math.PI * cutoff * dt;
  return r / (r + 1);
};

/** One axis of a One-Euro filter. */
class OneEuro {
  private x: number | null = null;
  private dx = 0;

  filter(value: number, dt: number, minCutoff: number, beta: number): number {
    if (this.x === null) { this.x = value; return value; }
    const dxRaw = (value - this.x) / dt;
    this.dx += (dxRaw - this.dx) * cutoffAlpha(D_CUTOFF, dt);
    const cutoff = minCutoff + beta * Math.abs(this.dx);
    this.x += (value - this.x) * cutoffAlpha(cutoff, dt);
    return this.x;
  }
}

export interface Conditioned {
  rel: [number, number, number];
  activity: number;
  idle: number;
  turn: number;
}

export class Conditioner {
  private readonly filters = [new OneEuro(), new OneEuro(), new OneEuro()];
  private base: [number, number, number] | null = null;
  private last: [number, number, number] | null = null;
  private activity = 0;
  private idle = 0;

  constructor(private readonly params: ConditionParams) {}

  process(acc: [number, number, number], gyro: [number, number, number], dt: number): Conditioned {
    dt = Math.min(0.1, Math.max(0.001, dt));
    const { minCutoff, beta } = this.params;
    const smooth: [number, number, number] = [
      this.filters[0]!.filter(acc[0], dt, minCutoff, beta),
      this.filters[1]!.filter(acc[1], dt, minCutoff, beta),
      this.filters[2]!.filter(acc[2], dt, minCutoff, beta),
    ];
    if (!this.base) {
      this.base = [...acc];       // joining at rest means starting at zero
      this.last = acc;
      return { rel: [0, 0, 0], activity: 0, idle: 0, turn: 0 };
    }

    const turnRate = Math.hypot(gyro[0], gyro[1], gyro[2]) / ACTIVITY_GYRO;
    const jolt = this.last
      ? Math.hypot(acc[0] - this.last[0], acc[1] - this.last[1], acc[2] - this.last[2]) / ACTIVITY_JOLT
      : 0;
    this.last = acc;
    const raw = Math.min(1, Math.max(turnRate, jolt));
    this.activity += (raw - this.activity) * alpha(ACTIVITY_TAU, dt);

    if (this.activity < IDLE_THRESHOLD) this.idle += dt;
    else this.idle = 0;
    if (this.idle > this.params.idleAfter) {
      const aB = alpha(this.params.baselineTau, dt);
      for (let i = 0; i < 3; i++) this.base[i]! += (smooth[i]! - this.base[i]!) * aB;
    }

    // Rotation about the vertical: the gyro projected onto the smoothed
    // gravity direction. Independent of how the phone is held — flat on a
    // table it is gyro_z, upright in a pocket it is gyro_y — so "turning
    // around yourself" is the same signal for everyone. Positive =
    // counter-clockwise seen from above.
    const g = Math.hypot(smooth[0], smooth[1], smooth[2]);
    const turn = g > 1 ? (gyro[0] * smooth[0] + gyro[1] * smooth[1] + gyro[2] * smooth[2]) / g : 0;

    return {
      rel: [smooth[0] - this.base[0]!, smooth[1] - this.base[1]!, smooth[2] - this.base[2]!],
      activity: this.activity,
      idle: this.idle,
      turn,
    };
  }
}

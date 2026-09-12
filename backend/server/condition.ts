//
//  condition.ts
//  HIVE (server)
//
//  Per-device signal conditioning: smoothing, an activity level, and an
//  adaptive zero.
//
//  A phone held at a comfortable angle, or lying on a table, reports a steady
//  gravity vector that means nothing musically — only *change* does. So each
//  device carries a baseline: the acceleration it has been resting at. While a
//  phone is active the baseline holds still; once it has been at rest for a
//  moment, the baseline slides toward the resting value, and the relative
//  acceleration (`rel`) settles back to zero. Everything downstream — OSC,
//  the feed, the wall — gets `rel` and `activity` next to the raw values.
//

export interface ConditionParams {
  /** Seconds at rest before the baseline starts to move. */
  idleAfter: number;
  /** Time constant of the baseline's slide, seconds. */
  baselineTau: number;
}

const SMOOTH_TAU = 0.08;     // tilt smoothing, seconds
const ACTIVITY_TAU = 0.25;   // activity smoothing, seconds
const ACTIVITY_GYRO = 150;   // °/s that counts as fully active
const ACTIVITY_JOLT = 6;     // m/s² change per sample that counts as fully active
const IDLE_THRESHOLD = 0.06;

const alpha = (tau: number, dt: number): number => 1 - Math.exp(-dt / tau);

export interface Conditioned {
  rel: [number, number, number];
  activity: number;
  idle: number;
}

export class Conditioner {
  private smooth: [number, number, number] | null = null;
  private base: [number, number, number] | null = null;
  private last: [number, number, number] | null = null;
  private activity = 0;
  private idle = 0;

  constructor(private readonly params: ConditionParams) {}

  process(acc: [number, number, number], gyro: [number, number, number], dt: number): Conditioned {
    dt = Math.min(0.1, Math.max(0.001, dt));
    if (!this.smooth || !this.base) {
      this.smooth = [...acc];
      this.base = [...acc];       // joining at rest means starting at zero
      this.last = acc;
      return { rel: [0, 0, 0], activity: 0, idle: 0 };
    }
    const aS = alpha(SMOOTH_TAU, dt);
    for (let i = 0; i < 3; i++) this.smooth[i]! += (acc[i]! - this.smooth[i]!) * aS;

    const turn = Math.hypot(gyro[0], gyro[1], gyro[2]) / ACTIVITY_GYRO;
    const jolt = this.last
      ? Math.hypot(acc[0] - this.last[0], acc[1] - this.last[1], acc[2] - this.last[2]) / ACTIVITY_JOLT
      : 0;
    this.last = acc;
    const raw = Math.min(1, Math.max(turn, jolt));
    this.activity += (raw - this.activity) * alpha(ACTIVITY_TAU, dt);

    if (this.activity < IDLE_THRESHOLD) this.idle += dt;
    else this.idle = 0;
    if (this.idle > this.params.idleAfter) {
      const aB = alpha(this.params.baselineTau, dt);
      for (let i = 0; i < 3; i++) this.base[i]! += (this.smooth[i]! - this.base[i]!) * aB;
    }

    return {
      rel: [this.smooth[0]! - this.base[0]!, this.smooth[1]! - this.base[1]!, this.smooth[2]! - this.base[2]!],
      activity: this.activity,
      idle: this.idle,
    };
  }
}

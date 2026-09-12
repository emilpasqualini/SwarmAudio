//
//  swarm.ts
//  HIVE (server)
//
//  What the swarm is doing as a whole, at a steady 30 Hz.
//
//  Three numbers for now, deliberately simple and cheap: energy (how hard the
//  phones move, gravity removed), motion (how much they turn), sync (how alike
//  their turning is). They are the first handles for "swarm audio" — more
//  (centroid drift, phase coherence) can be added without touching anything
//  upstream, since this only reads each device's latest sample.
//

import type { Registry } from './registry';
import type { SwarmFeatures } from '../shared/types';

const G = 9.81;

export class Swarm {
  private timer: NodeJS.Timeout | null = null;
  private readonly listeners: ((f: SwarmFeatures) => void)[] = [];
  latest: SwarmFeatures = { t: Date.now(), count: 0, energy: 0, motion: 0, sync: 1 };

  constructor(private readonly registry: Registry, private readonly hz: number) {}

  on(fn: (f: SwarmFeatures) => void): void { this.listeners.push(fn); }

  start(): void {
    this.timer ??= setInterval(() => this.tick(), 1000 / this.hz);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  compute(now = Date.now()): SwarmFeatures {
    const devices = this.registry.list();
    let count = 0, energy = 0, motion = 0;
    const gyroMags: number[] = [];
    for (const d of devices) {
      if (!d.last) continue;
      count++;
      const [ax, ay, az] = d.last.acc;
      energy += Math.abs(Math.hypot(ax, ay, az) - G);
      const gm = Math.hypot(...d.last.gyro);
      motion += gm;
      gyroMags.push(gm);
    }
    if (count === 0) return { t: now, count: 0, energy: 0, motion: 0, sync: 1 };
    energy /= count;
    motion /= count;
    // Coefficient of variation of |gyro|, squashed to 0..1 and inverted: all
    // devices turning at the same rate → 1; one turning and the rest still → 0.
    let variance = 0;
    for (const gm of gyroMags) variance += (gm - motion) ** 2;
    variance /= count;
    const cv = motion > 1e-3 ? Math.sqrt(variance) / motion : 0;
    const sync = 1 / (1 + cv * cv);
    return { t: now, count, energy, motion, sync };
  }

  private tick(): void {
    this.latest = this.compute();
    for (const fn of this.listeners) fn(this.latest);
  }
}

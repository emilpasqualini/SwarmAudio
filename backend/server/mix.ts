//
//  mix.ts
//  HIVE (server)
//
//  Where the two crowds meet: the bees on the wall and the people the camera
//  sees. Neither knows the other — nobody is matched to a phone — but the
//  pictures overlap, both 0..1 across, so the server can say how close the
//  swarm hovers to the crowd, how many bees fly inside a group, whether the
//  queen is among people, whether swarm and crowd drift the same way. These are
//  the first handles for playing the two against each other.
//

import type { MixFeatures } from '../shared/types';
import type { WallState } from './wall';
import type { VisionIn } from './vision';

const TOUCH = 0.1;
const MARGIN = 0.04;

export class Mix {
  private timer: NodeJS.Timeout | null = null;
  private readonly listeners: ((m: MixFeatures) => void)[] = [];
  latest: MixFeatures = Mix.empty(Date.now());
  queenUid = '';

  constructor(private readonly wall: WallState, private readonly vision: VisionIn, private hz: number) {}

  static empty(t: number): MixFeatures {
    return { t, bees: 0, people: 0, distance: 0, beesInCrowd: 0, queenInCrowd: 0, covered: 0, alignment: 0, balance: 0 };
  }

  on(fn: (m: MixFeatures) => void): void { this.listeners.push(fn); }
  setHz(hz: number): void { this.hz = hz; if (this.timer) { this.stop(); this.start(); } }
  start(): void { this.timer ??= setInterval(() => this.tick(), 1000 / this.hz); }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }

  compute(now = Date.now()): MixFeatures {
    const m = Mix.empty(now);
    const bees = this.wall.snapshot().bees;
    const f = this.vision.current;
    m.bees = bees.length;
    m.people = f?.count ?? 0;
    if (m.bees + m.people > 0) m.balance = m.bees / (m.bees + m.people);
    if (!f || m.bees === 0 || m.people === 0) return m;

    let bx = 0, by = 0, hx = 0, hy = 0;
    for (const b of bees) { bx += b.x; by += b.y; hx += Math.cos(b.h); hy += Math.sin(b.h); }
    bx /= m.bees; by /= m.bees;
    m.distance = Math.hypot(bx - f.cx, by - f.cy);

    const inCrowd = (x: number, y: number): boolean => f.clusters.some((c) => Math.hypot(c.x - x, c.y - y) <= c.r + MARGIN);
    let inside = 0;
    for (const b of bees) if (inCrowd(b.x, b.y)) inside++;
    m.beesInCrowd = inside / m.bees;
    const queen = this.queenUid ? bees.find((b) => b.uid === this.queenUid) : undefined;
    m.queenInCrowd = queen && inCrowd(queen.x, queen.y) ? 1 : 0;

    let covered = 0;
    for (const p of f.people) if (bees.some((b) => Math.hypot(b.x - p.x, b.y - p.y) <= TOUCH)) covered++;
    m.covered = covered / m.people;

    const flow = Math.hypot(f.flowX, f.flowY), head = Math.hypot(hx, hy);
    m.alignment = flow > 0.02 && head > 1e-3 ? (hx * f.flowX + hy * f.flowY) / (head * flow) : 0;
    return m;
  }

  private tick(): void {
    this.latest = this.compute();
    for (const fn of this.listeners) fn(this.latest);
  }
}

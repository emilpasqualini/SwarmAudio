//
//  simulate.ts
//  HIVE (server)
//
//  Fake phones, for testing the whole pipeline without a single real one.
//
//  `HIVE_SIMULATE=3` makes three virtual devices that tilt and turn along slow
//  sines with a little noise, at 60 Hz, and pushes frames through the same
//  `registry.push` a network frame would take. So OSC, the feed, the swarm
//  features and the dashboard all see them as ordinary devices — they are
//  marked with platform "other" and a name starting with "sim".
//

import { FrameBuilder, decodeFrame } from '../shared/protocol';
import type { Registry } from './registry';

export function startSimulation(registry: Registry, count: number): () => void {
  const G = 9.81;
  const sims = Array.from({ length: count }, (_, i) => ({
    id: `sim-${String(i + 1).padStart(4, '0')}-${Math.random().toString(36).slice(2, 10)}`,
    name: `sim ${i + 1}`,
    phase: Math.random() * Math.PI * 2,
    rate: 0.15 + Math.random() * 0.35, // Hz of the tilt cycle
    builder: new FrameBuilder('other', false, 8),
  }));

  const period = 1000 / 60;
  let ticks = 0;
  const timer = setInterval(() => {
    const now = Date.now();
    const t = now / 1000;
    ticks++;
    for (const s of sims) {
      const w = 2 * Math.PI * s.rate;
      const tilt = 0.6 * Math.sin(w * t + s.phase);       // radians, about the x axis
      const roll = 0.4 * Math.sin(w * 0.7 * t + s.phase); // about the y axis
      const noise = () => (Math.random() - 0.5) * 0.15;
      const ax = G * Math.sin(roll) + noise();
      const ay = -G * Math.sin(tilt) * Math.cos(roll) + noise();
      const az = G * Math.cos(tilt) * Math.cos(roll) + noise();
      const gx = (0.6 * w * Math.cos(w * t + s.phase)) * (180 / Math.PI) + noise() * 10;
      const gy = (0.4 * 0.7 * w * Math.cos(w * 0.7 * t + s.phase)) * (180 / Math.PI) + noise() * 10;
      const gz = noise() * 5;
      s.builder.push(now, ax, ay, az, gx, gy, gz);
      // Flush every third sample, like a real phone with the default batch size.
      if (ticks % 3 === 0) {
        const frame = s.builder.take();
        if (frame) registry.push(s.id, s.name, 'ws', decodeFrame(frame), now);
      }
    }
  }, period);

  return () => {
    clearInterval(timer);
    for (const s of sims) registry.remove(s.id);
  };
}

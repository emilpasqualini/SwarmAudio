//
//  dots.ts
//  HIVE (client, wall)
//
//  One dot per phone, rolling on a plane the phone tilts.
//
//  Tilt is the accelerometer's gravity vector: hold the phone flat and the dot
//  rests, tip it left and the dot rolls left, as a marble would. Turning the
//  phone — the gyroscope — makes the dot flare. It is the simplest picture in
//  which every person in the room can find themselves within a second, which
//  is what a wall is for.
//

import type { FeedMessage } from '../../../shared/types';
import type { Frame, Visual } from './visual';

const G = 9.81;

interface Dot {
  slot: number;
  name: string;
  x: number; y: number;      // 0..1 of the canvas
  vx: number; vy: number;    // canvas widths per second
  tiltX: number; tiltY: number; // −1..1, from acc
  spin: number;              // 0..1, from |gyro|
  alpha: number;             // fade in/out
  leaving: boolean;
  trail: { x: number; y: number }[];
}

export class Dots implements Visual {
  private readonly dots = new Map<number, Dot>();
  private readonly gravity = 0.9;   // canvas widths / s² at full tilt
  private readonly damping = 1.6;   // 1/s
  private readonly radius = 0.022;  // of the shorter side

  feed(msg: FeedMessage): void {
    if (msg.type === 'join') {
      const existing = this.dots.get(msg.slot);
      if (existing) { existing.leaving = false; existing.name = msg.name; return; }
      this.dots.set(msg.slot, {
        slot: msg.slot, name: msg.name,
        x: 0.5 + (Math.random() - 0.5) * 0.3, y: 0.5 + (Math.random() - 0.5) * 0.3,
        vx: 0, vy: 0, tiltX: 0, tiltY: 0, spin: 0, alpha: 0, leaving: false, trail: [],
      });
    } else if (msg.type === 'leave') {
      const d = this.dots.get(msg.slot);
      if (d) d.leaving = true;
    } else if (msg.type === 'sample') {
      const d = this.dots.get(msg.slot);
      if (!d) return;
      const [ax, ay] = msg.acc;
      // Screen up, top edge away from you: +x is right, +y is toward the top.
      // Tip right → gravity's x component goes negative → dot should roll right.
      d.tiltX = Math.max(-1, Math.min(1, -ax / G));
      d.tiltY = Math.max(-1, Math.min(1, ay / G));
      const spin = Math.min(1, Math.hypot(...msg.gyro) / 300);
      d.spin = d.spin * 0.7 + spin * 0.3;
    }
  }

  draw({ ctx, width, height, dt, time, colour }: Frame): void {
    const r = Math.min(width, height) * this.radius;
    const aspect = width / height;

    for (const [slot, d] of this.dots) {
      // fade
      d.alpha += (d.leaving ? -1 : 1) * dt * 2;
      if (d.alpha <= 0 && d.leaving) { this.dots.delete(slot); continue; }
      d.alpha = Math.min(1, Math.max(0, d.alpha));

      // physics: tilt is acceleration, velocity decays, walls bounce
      d.vx += d.tiltX * this.gravity * dt;
      d.vy += -d.tiltY * this.gravity * dt / aspect;
      const decay = Math.exp(-this.damping * dt);
      d.vx *= decay; d.vy *= decay;
      d.x += d.vx * dt; d.y += d.vy * dt;
      const mx = r / width, my = r / height;
      if (d.x < mx) { d.x = mx; d.vx = Math.abs(d.vx) * 0.5; }
      if (d.x > 1 - mx) { d.x = 1 - mx; d.vx = -Math.abs(d.vx) * 0.5; }
      if (d.y < my) { d.y = my; d.vy = Math.abs(d.vy) * 0.5; }
      if (d.y > 1 - my) { d.y = 1 - my; d.vy = -Math.abs(d.vy) * 0.5; }

      d.trail.push({ x: d.x, y: d.y });
      if (d.trail.length > 40) d.trail.shift();

      const px = d.x * width, py = d.y * height;
      const c = colour(slot);
      ctx.globalAlpha = d.alpha;

      // trail
      ctx.strokeStyle = c;
      ctx.lineWidth = Math.max(1, r * 0.35);
      ctx.lineCap = 'round';
      ctx.beginPath();
      d.trail.forEach((p, i) => { if (i === 0) ctx.moveTo(p.x * width, p.y * height); else ctx.lineTo(p.x * width, p.y * height); });
      ctx.globalAlpha = d.alpha * 0.25;
      ctx.stroke();

      // flare when turning
      if (d.spin > 0.02) {
        const flare = r * (1.4 + d.spin * 3) * (1 + 0.08 * Math.sin(time * 14));
        const grad = ctx.createRadialGradient(px, py, r * 0.8, px, py, flare);
        grad.addColorStop(0, c);
        grad.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.globalAlpha = d.alpha * Math.min(0.9, d.spin * 1.2);
        ctx.fillStyle = grad;
        ctx.beginPath(); ctx.arc(px, py, flare, 0, Math.PI * 2); ctx.fill();
      }

      // the dot
      ctx.globalAlpha = d.alpha;
      ctx.fillStyle = c;
      ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2); ctx.fill();

      // label
      ctx.fillStyle = '#ffffff';
      ctx.font = `${Math.max(12, r * 0.95)}px Bitter, Georgia, serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(d.name || `#${slot}`, px, py + r * 1.35);
    }
    ctx.globalAlpha = 1;
  }
}

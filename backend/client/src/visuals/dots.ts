//
//  dots.ts
//  HIVE (client, wall)
//
//  One dot per phone, rolling on a plane the phone tilts.
//
//  Tilt is the accelerometer's gravity vector: tip the phone left and the dot
//  rolls left, as a marble would. Turning or shaking — activity — makes the
//  dot grow and flare, so the liveliest person in the room is the biggest
//  thing on the wall.
//
//  The tilt used here is the server's `rel` — smoothed acceleration relative
//  to an adaptive zero (server/condition.ts) — and the activity is the
//  server's too, so the wall shows exactly what the OSC side hears. A phone
//  at rest has rel ≈ 0: its dot stops and drifts home to the centre. Only
//  *change* moves a dot.
//

import type { FeedMessage } from '../../../shared/types';
import type { Frame, Visual } from './visual';

const TILT_FULL = 9.81 / 2;     // m/s² of rel that counts as full tilt (45°)
const IDLE_THRESHOLD = 0.06;    // activity below this is "at rest"
const IDLE_AFTER = 1.2;         // seconds at rest before the dot starts drifting home
const HOME_TAU = 3.0;           // how slowly a resting dot drifts back to the centre
const SAMPLE_DT = 1 / 60;

interface Dot {
  slot: number;
  name: string;
  x: number; y: number;         // 0..1 of the canvas
  vx: number; vy: number;       // canvas widths per second
  tiltX: number; tiltY: number; // −1..1, from the server's rel
  activity: number;             // 0..1, from the server
  idle: number;                 // seconds at rest
  alpha: number;
  leaving: boolean;
  trail: { x: number; y: number }[];
}

const alpha = (tau: number, dt: number): number => 1 - Math.exp(-dt / tau);

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
        vx: 0, vy: 0, tiltX: 0, tiltY: 0,
        activity: 0, idle: 0, alpha: 0, leaving: false, trail: [],
      });
    } else if (msg.type === 'leave') {
      const d = this.dots.get(msg.slot);
      if (d) d.leaving = true;
    } else if (msg.type === 'sample') {
      const d = this.dots.get(msg.slot);
      if (!d) return;
      const [rx, ry] = msg.rel;
      // Screen up, top edge away from you: tip right → gravity's x goes negative → roll right.
      d.tiltX = Math.max(-1, Math.min(1, -rx / TILT_FULL));
      d.tiltY = Math.max(-1, Math.min(1, ry / TILT_FULL));
      d.activity = msg.activity;
      if (d.activity < IDLE_THRESHOLD) d.idle += SAMPLE_DT; else d.idle = 0;
    }
  }

  draw({ ctx, width, height, dt, time, colour }: Frame): void {
    const r0 = Math.min(width, height) * this.radius;
    const aspect = width / height;

    for (const [slot, d] of this.dots) {
      d.alpha += (d.leaving ? -1 : 1) * dt * 2;
      if (d.alpha <= 0 && d.leaving) { this.dots.delete(slot); continue; }
      d.alpha = Math.min(1, Math.max(0, d.alpha));

      // Physics: tilt accelerates the dot, velocity decays, walls bounce.
      // At rest, a gentle pull home.
      d.vx += d.tiltX * this.gravity * dt;
      d.vy += -d.tiltY * this.gravity * dt / aspect;
      if (d.idle > IDLE_AFTER) {
        const aH = alpha(HOME_TAU, dt);
        d.x += (0.5 - d.x) * aH;
        d.y += (0.5 - d.y) * aH;
        d.vx *= 1 - aH; d.vy *= 1 - aH;
      }
      const decay = Math.exp(-this.damping * dt);
      d.vx *= decay; d.vy *= decay;
      d.x += d.vx * dt; d.y += d.vy * dt;

      const r = r0 * (1 + 1.8 * d.activity);
      const mx = r / width, my = r / height;
      if (d.x < mx) { d.x = mx; d.vx = Math.abs(d.vx) * 0.5; }
      if (d.x > 1 - mx) { d.x = 1 - mx; d.vx = -Math.abs(d.vx) * 0.5; }
      if (d.y < my) { d.y = my; d.vy = Math.abs(d.vy) * 0.5; }
      if (d.y > 1 - my) { d.y = 1 - my; d.vy = -Math.abs(d.vy) * 0.5; }

      d.trail.push({ x: d.x, y: d.y });
      if (d.trail.length > 40) d.trail.shift();

      const px = d.x * width, py = d.y * height;
      const c = colour(slot);

      // trail
      ctx.strokeStyle = c;
      ctx.lineWidth = Math.max(1, r0 * 0.35);
      ctx.lineCap = 'round';
      ctx.beginPath();
      d.trail.forEach((p, i) => { if (i === 0) ctx.moveTo(p.x * width, p.y * height); else ctx.lineTo(p.x * width, p.y * height); });
      ctx.globalAlpha = d.alpha * 0.25;
      ctx.stroke();

      // flare grows with activity
      if (d.activity > 0.03) {
        const flare = r * (1.5 + d.activity * 2) * (1 + 0.06 * Math.sin(time * 14));
        const grad = ctx.createRadialGradient(px, py, r * 0.8, px, py, flare);
        grad.addColorStop(0, c);
        grad.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.globalAlpha = d.alpha * Math.min(0.9, d.activity * 1.3);
        ctx.fillStyle = grad;
        ctx.beginPath(); ctx.arc(px, py, flare, 0, Math.PI * 2); ctx.fill();
      }

      // the dot, dimmer when resting so the active ones stand out
      ctx.globalAlpha = d.alpha * (0.55 + 0.45 * Math.min(1, d.activity * 3));
      ctx.fillStyle = c;
      ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2); ctx.fill();

      // label
      ctx.globalAlpha = d.alpha;
      ctx.fillStyle = '#ffffff';
      ctx.font = `${Math.max(12, r0 * 0.95)}px Bitter, Georgia, serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(d.name || `#${slot}`, px, py + r * 1.25);
    }
    ctx.globalAlpha = 1;
  }
}

//
//  dots.ts
//  HIVE (client, wall)
//
//  One dot per phone, moving like a creature on a plane.
//
//  A dot has a heading and a speed, and the phone steers it: how much the phone
//  moves sets the speed, turning the phone about the vertical turns the dot's
//  heading by the same angle (turn around yourself and your dot turns around
//  too), and tilting steers it as well. Nothing is integrated straight from the
//  sensors into a position, so two people walking with the phone in a pocket do
//  the same *kind* of thing — a steady, wobbling advance — while the small
//  differences in their gait, their hip rotation and how the phone sits bend
//  their paths differently. Same input, same path, always: the model is
//  deterministic.
//
//  The edge is soft. Beyond a comfort zone a dot is steered back toward the
//  room's centre, harder the farther out it is, so it curves back rather than
//  hitting a wall; dots also keep a little distance from each other, so the
//  swarm spreads over the whole wall instead of piling up. New dots appear
//  away from the edge and as far from everyone else as possible, and all dots
//  shrink as the swarm grows.
//
//  The tilt used here is the server's `rel`, the activity and the turn are the
//  server's too (server/condition.ts), so the wall shows what the OSC side
//  hears. A phone at rest has activity ≈ 0: its dot stops and drifts home.
//

import type { FeedMessage } from '../../../shared/types';
import type { Frame, Visual } from './visual';

// World coordinates: y runs 0..1 top to bottom, x runs 0..aspect. Distances are
// isotropic that way, which the steering needs.

const TILT_FULL = 9.81 / 2;       // m/s² of rel that counts as full tilt (45°)
const IDLE_AFTER = 1.2;           // seconds at rest before the dot starts drifting home
const HOME_TAU = 4.0;             // how slowly a resting dot drifts back to the centre
const SPEED = 0.16;               // world units / s at full activity
const SPEED_TAU = 0.4;            // how quickly speed follows activity
const STEER_TILT = 2.2;           // rad/s of heading change at full sideways tilt
const STEER_TURN = 1.0;           // dot heading per phone rotation about the vertical (1 = one to one)
const COMFORT = 0.10;             // margin (in units of the shorter side) inside which steering home begins
const EDGE = 0.035;               // hard margin — never crossed
const SEPARATION = 0.11;          // world distance under which dots push each other apart
const FULL_SIZE_UP_TO = 6;        // dots keep their full size up to this many; then they shrink
const TRAIL = 70;                 // frames of trail

interface Dot {
  slot: number;
  name: string;
  x: number; y: number;           // world position
  heading: number;                // radians, 0 = right, clockwise on screen
  speed: number;                  // world units per second
  tiltX: number; tiltY: number;   // −1..1, from the server's rel
  activity: number;               // 0..1, from the server
  turn: number;                   // °/s about the vertical, from the server
  idle: number;                   // seconds at rest, from the server
  alpha: number;
  leaving: boolean;
  trail: { x: number; y: number }[];
}

const lerpFactor = (tau: number, dt: number): number => 1 - Math.exp(-dt / tau);
const wrapAngle = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

export class Dots implements Visual {
  private readonly dots = new Map<number, Dot>();
  private aspect = 16 / 9;
  private readonly radius = 0.024;  // of the shorter side, at full size

  resize(width: number, height: number): void { this.aspect = width / height; }

  feed(msg: FeedMessage): void {
    if (msg.type === 'join') {
      const existing = this.dots.get(msg.slot);
      if (existing) { existing.leaving = false; existing.name = msg.name; return; }
      const { x, y } = this.spawnPoint();
      this.dots.set(msg.slot, {
        slot: msg.slot, name: msg.name,
        x, y,
        heading: Math.atan2(0.5 - y, this.aspect / 2 - x),   // set off toward the middle
        speed: 0, tiltX: 0, tiltY: 0, activity: 0, turn: 0, idle: 0,
        alpha: 0, leaving: false, trail: [],
      });
    } else if (msg.type === 'leave') {
      const d = this.dots.get(msg.slot);
      if (d) d.leaving = true;
    } else if (msg.type === 'sample') {
      const d = this.dots.get(msg.slot);
      if (!d) return;
      const [rx, ry] = msg.rel;
      // Screen up, top edge away from you: tip right → gravity's x goes negative → steer right.
      d.tiltX = clamp(-rx / TILT_FULL, -1, 1);
      d.tiltY = clamp(ry / TILT_FULL, -1, 1);
      d.activity = msg.activity;
      d.turn = msg.turn;
      d.idle = msg.idle;
    }
  }

  /** Inside the comfort zone, as far from every other dot as we can find. */
  private spawnPoint(): { x: number; y: number } {
    const m = COMFORT * 1.6, w = this.aspect;
    const others = [...this.dots.values()].filter((d) => !d.leaving);
    if (others.length === 0) return { x: w / 2 + (Math.random() - 0.5) * 0.2, y: 0.5 + (Math.random() - 0.5) * 0.2 };
    let best = { x: w / 2, y: 0.5 }, bestScore = -1;
    for (let i = 0; i < 64; i++) {
      const x = m + Math.random() * (w - 2 * m), y = m + Math.random() * (1 - 2 * m);
      let nearest = Infinity;
      for (const o of others) nearest = Math.min(nearest, Math.hypot(o.x - x, o.y - y));
      if (nearest > bestScore) { bestScore = nearest; best = { x, y }; }
    }
    return best;
  }

  draw({ ctx, width, height, dt, time, colour }: Frame): void {
    this.aspect = width / height;
    const w = this.aspect;
    const live = [...this.dots.values()].filter((d) => !d.leaving).length;
    const shrink = Math.min(1, Math.sqrt(FULL_SIZE_UP_TO / Math.max(1, live)));
    const r0 = Math.min(width, height) * this.radius * shrink;
    const rWorld = r0 / height;

    const all = [...this.dots.values()];
    for (const d of all) {
      d.alpha += (d.leaving ? -1 : 1) * dt * 2;
      if (d.alpha <= 0 && d.leaving) { this.dots.delete(d.slot); continue; }
      d.alpha = clamp(d.alpha, 0, 1);

      // --- steering -----------------------------------------------------------
      // The phone's own rotation about the vertical turns the dot one to one;
      // sideways tilt bends the path; and the closer to the edge, the harder
      // the dot is turned back toward the middle.
      let dHeading = d.turn * (Math.PI / 180) * STEER_TURN + d.tiltX * STEER_TILT;
      const toCentre = Math.atan2(0.5 - d.y, w / 2 - d.x);
      const edgeDist = Math.min(d.x, w - d.x, d.y, 1 - d.y);
      if (edgeDist < COMFORT) {
        const out = 1 - edgeDist / COMFORT;              // 0 at the comfort line, 1 at the edge
        dHeading += wrapAngle(toCentre - d.heading) * out * out * 8;
      }
      // Neighbours: turn a little away from anyone too close, and never overlap.
      for (const o of all) {
        if (o === d || o.leaving) continue;
        const dx = d.x - o.x, dy = d.y - o.y, dist = Math.hypot(dx, dy);
        if (dist < 1e-4 || dist > SEPARATION) continue;
        const away = Math.atan2(dy, dx);
        const closeness = 1 - dist / SEPARATION;
        dHeading += wrapAngle(away - d.heading) * closeness * 1.5;
        const push = Math.max(0, 2 * rWorld - dist) * 0.5;   // overlap only
        d.x += (dx / dist) * push; d.y += (dy / dist) * push;
      }
      d.heading = wrapAngle(d.heading + dHeading * dt);

      // --- speed ----------------------------------------------------------------
      // Activity drives it; tilting forward hurries, tilting back holds.
      const resting = d.idle > IDLE_AFTER;
      const target = resting ? 0 : SPEED * Math.min(1, d.activity * 1.4) * clamp(1 + 0.6 * d.tiltY, 0.3, 1.6);
      d.speed += (target - d.speed) * lerpFactor(SPEED_TAU, dt);
      d.x += Math.cos(d.heading) * d.speed * dt;
      d.y += Math.sin(d.heading) * d.speed * dt;

      if (resting) {
        const aH = lerpFactor(HOME_TAU, dt);
        d.x += (w / 2 - d.x) * aH;
        d.y += (0.5 - d.y) * aH;
      }

      // safety net — the steering should have turned the dot long before
      d.x = clamp(d.x, EDGE + rWorld, w - EDGE - rWorld);
      d.y = clamp(d.y, EDGE + rWorld, 1 - EDGE - rWorld);

      d.trail.push({ x: d.x, y: d.y });
      if (d.trail.length > TRAIL) d.trail.shift();

      // --- draw -----------------------------------------------------------------
      const px = d.x * height, py = d.y * height;
      const r = r0 * (1 + 1.6 * d.activity);
      const c = colour(d.slot);

      ctx.strokeStyle = c;
      ctx.lineWidth = Math.max(1, r0 * 0.3);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      d.trail.forEach((p, i) => { if (i === 0) ctx.moveTo(p.x * height, p.y * height); else ctx.lineTo(p.x * height, p.y * height); });
      ctx.globalAlpha = d.alpha * 0.22;
      ctx.stroke();

      if (d.activity > 0.03) {
        const flare = r * (1.5 + d.activity * 2) * (1 + 0.06 * Math.sin(time * 14));
        const grad = ctx.createRadialGradient(px, py, r * 0.8, px, py, flare);
        grad.addColorStop(0, c);
        grad.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.globalAlpha = d.alpha * Math.min(0.9, d.activity * 1.3);
        ctx.fillStyle = grad;
        ctx.beginPath(); ctx.arc(px, py, flare, 0, Math.PI * 2); ctx.fill();
      }

      // The body: a disc with a nose in the direction of travel, so the heading
      // — and a phone turning on the spot — is visible even when the dot is slow.
      ctx.globalAlpha = d.alpha * (0.55 + 0.45 * Math.min(1, d.activity * 3));
      ctx.fillStyle = c;
      ctx.save();
      ctx.translate(px, py);
      ctx.rotate(d.heading);
      ctx.beginPath();
      ctx.arc(0, 0, r, Math.PI * 0.5 + 0.35, Math.PI * 1.5 - 0.35, false);
      ctx.lineTo(r * 1.9, 0);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill();
      ctx.restore();

      ctx.globalAlpha = d.alpha;
      ctx.fillStyle = '#ffffff';
      ctx.font = `${Math.max(11, r0 * 0.95)}px Bitter, Georgia, serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(d.name || `#${d.slot}`, px, py + r * 1.25);
    }
    ctx.globalAlpha = 1;
  }
}

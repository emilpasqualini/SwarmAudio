//
//  bees.ts
//  HIVE (client, wall)
//
//  One bee per phone, flying over the wall.
//
//  A bee has a heading and a speed, and the phone steers it: how much the phone
//  moves sets the speed and how hard the wings beat, turning the phone about
//  the vertical turns the bee's heading by the same angle (turn around yourself
//  and your bee turns around too), and tilting steers it as well. Nothing is
//  integrated straight from the sensors into a position, so two people walking
//  with the phone in a pocket do the same *kind* of thing — a steady, wobbling
//  advance — while the small differences in their gait, their hip rotation and
//  how the phone sits bend their paths differently. Same input, same path,
//  always: the model is deterministic.
//
//  The edge is soft. Beyond a comfort zone a bee is steered back toward the
//  room's centre, harder the farther out it is, so it curves back rather than
//  hitting a wall; bees also keep a little distance from each other, so the
//  swarm spreads over the whole wall instead of piling up. New bees appear
//  away from the edge and as far from everyone else as possible, and all bees
//  shrink as the swarm grows.
//
//  One slot can be the queen (dashboard: queen). She is larger, golden, wears a
//  halo and beats her wings more slowly — the one the room can pick out. For
//  now that is all she does; her solo is still to come.
//
//  The tilt used here is the server's `rel`, the activity and the turn are the
//  server's too (server/condition.ts), so the wall shows what the OSC side
//  hears. A phone at rest has activity ≈ 0: its bee hovers and drifts home.
//

import type { FeedMessage } from '../../../shared/types';
import type { Frame, Visual } from './visual';

// World coordinates: y runs 0..1 top to bottom, x runs 0..aspect. Distances are
// isotropic that way, which the steering needs.

const TILT_FULL = 9.81 / 2;       // m/s² of rel that counts as full tilt (45°)
const IDLE_AFTER = 1.2;           // seconds at rest before the bee starts drifting home
const HOME_TAU = 4.0;             // how slowly a resting bee drifts back to the centre
const SPEED = 0.16;               // world units / s at full activity
const SPEED_TAU = 0.4;            // how quickly speed follows activity
const STEER_TILT = 2.2;           // rad/s of heading change at full sideways tilt
const STEER_TURN = 1.0;           // bee heading per phone rotation about the vertical (1 = one to one)
const COMFORT = 0.10;             // margin (in units of the shorter side) inside which steering home begins
const EDGE = 0.035;               // hard margin — never crossed
const SEPARATION = 0.11;          // world distance under which bees push each other apart
const FULL_SIZE_UP_TO = 6;        // bees keep their full size up to this many; then they shrink
const TRAIL = 70;                 // frames of trail
const QUEEN_SCALE = 1.7;
const QUEEN_COLOUR = '#f2c14e';

interface Bee {
  slot: number;
  name: string;
  x: number; y: number;           // world position
  heading: number;                // radians, 0 = right, clockwise on screen
  speed: number;                  // world units per second
  wingPhase: number;              // radians, advances with the beat frequency
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

/** Draws a bee in its own frame: origin at the thorax, +x forward, unit r. */
function drawBee(ctx: CanvasRenderingContext2D, r: number, colour: string, wing: number, queen: boolean): void {
  // wings, behind the body: two ellipses swept back and out, swinging with `wing`
  ctx.fillStyle = queen ? 'rgba(255,240,200,0.5)' : 'rgba(255,255,255,0.45)';
  for (const s of [-1, 1]) {
    const phi = s * (Math.PI - 1.05 + wing);
    ctx.save();
    ctx.translate(0.15 * r, s * 0.2 * r);
    ctx.rotate(phi);
    ctx.beginPath();
    ctx.ellipse(0.95 * r, 0, 1.0 * r, 0.4 * r, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  // abdomen with stripes
  const abLen = queen ? 1.35 * r : 1.0 * r;
  ctx.fillStyle = colour;
  ctx.beginPath(); ctx.ellipse(-0.55 * r - (abLen - r), 0, abLen, 0.62 * r, 0, 0, Math.PI * 2); ctx.fill();
  ctx.save();
  ctx.clip();
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  for (let i = 0; i < (queen ? 4 : 3); i++) {
    const x = -0.35 * r - i * 0.5 * r;
    ctx.fillRect(x - 0.11 * r, -r, 0.22 * r, 2 * r);
  }
  ctx.restore();
  // thorax and head
  ctx.fillStyle = colour;
  ctx.beginPath(); ctx.arc(0.35 * r, 0, 0.52 * r, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(1.05 * r, 0, 0.36 * r, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.beginPath(); ctx.arc(1.05 * r, 0, 0.36 * r, 0, Math.PI * 2); ctx.fill();
  // antennae
  ctx.strokeStyle = colour;
  ctx.lineWidth = Math.max(1, 0.08 * r);
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(1.3 * r, -0.15 * r); ctx.lineTo(1.85 * r, -0.55 * r);
  ctx.moveTo(1.3 * r, 0.15 * r); ctx.lineTo(1.85 * r, 0.55 * r);
  ctx.stroke();
}

export class Bees implements Visual {
  private readonly bees = new Map<number, Bee>();
  private aspect = 16 / 9;
  private readonly radius = 0.016;  // of the shorter side, at full size

  resize(width: number, height: number): void { this.aspect = width / height; }

  feed(msg: FeedMessage): void {
    if (msg.type === 'join') {
      const existing = this.bees.get(msg.slot);
      if (existing) { existing.leaving = false; existing.name = msg.name; return; }
      const { x, y } = this.spawnPoint();
      this.bees.set(msg.slot, {
        slot: msg.slot, name: msg.name,
        x, y,
        heading: Math.atan2(0.5 - y, this.aspect / 2 - x),   // set off toward the middle
        speed: 0, wingPhase: Math.random() * Math.PI * 2,
        tiltX: 0, tiltY: 0, activity: 0, turn: 0, idle: 0,
        alpha: 0, leaving: false, trail: [],
      });
    } else if (msg.type === 'leave') {
      const b = this.bees.get(msg.slot);
      if (b) b.leaving = true;
    } else if (msg.type === 'sample') {
      const b = this.bees.get(msg.slot);
      if (!b) return;
      const [rx, ry] = msg.rel;
      // Screen up, top edge away from you: tip right → gravity's x goes negative → steer right.
      b.tiltX = clamp(-rx / TILT_FULL, -1, 1);
      b.tiltY = clamp(ry / TILT_FULL, -1, 1);
      b.activity = msg.activity;
      b.turn = msg.turn;
      b.idle = msg.idle;
    }
  }

  /** Inside the comfort zone, as far from every other bee as we can find. */
  private spawnPoint(): { x: number; y: number } {
    const m = COMFORT * 1.6, w = this.aspect;
    const others = [...this.bees.values()].filter((b) => !b.leaving);
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

  draw({ ctx, width, height, dt, time, colour, queen }: Frame): void {
    this.aspect = width / height;
    const w = this.aspect;
    const live = [...this.bees.values()].filter((b) => !b.leaving).length;
    const shrink = Math.min(1, Math.sqrt(FULL_SIZE_UP_TO / Math.max(1, live)));
    const r0 = Math.min(width, height) * this.radius * shrink;
    const sizeOf = (b: Bee): number => b.slot === queen ? QUEEN_SCALE : 1;

    const all = [...this.bees.values()];
    for (const b of all) {
      b.alpha += (b.leaving ? -1 : 1) * dt * 2;
      if (b.alpha <= 0 && b.leaving) { this.bees.delete(b.slot); continue; }
      b.alpha = clamp(b.alpha, 0, 1);
      const isQueen = b.slot === queen;
      const r = r0 * sizeOf(b);
      const rWorld = r * 2 / height;         // a bee is about 2 r long

      // --- steering -----------------------------------------------------------
      // The phone's own rotation about the vertical turns the bee one to one;
      // sideways tilt bends the path; and the closer to the edge, the harder
      // the bee is turned back toward the middle.
      let dHeading = b.turn * (Math.PI / 180) * STEER_TURN + b.tiltX * STEER_TILT;
      const toCentre = Math.atan2(0.5 - b.y, w / 2 - b.x);
      const edgeDist = Math.min(b.x, w - b.x, b.y, 1 - b.y);
      if (edgeDist < COMFORT) {
        const out = 1 - edgeDist / COMFORT;              // 0 at the comfort line, 1 at the edge
        dHeading += wrapAngle(toCentre - b.heading) * out * out * 8;
      }
      // Neighbours: turn a little away from anyone too close, and never overlap.
      for (const o of all) {
        if (o === b || o.leaving) continue;
        const dx = b.x - o.x, dy = b.y - o.y, dist = Math.hypot(dx, dy);
        if (dist < 1e-4 || dist > SEPARATION) continue;
        const away = Math.atan2(dy, dx);
        const closeness = 1 - dist / SEPARATION;
        dHeading += wrapAngle(away - b.heading) * closeness * 1.5;
        const minDist = rWorld + r0 * sizeOf(o) * 2 / height;
        const push = Math.max(0, minDist - dist) * 0.5;   // overlap only
        b.x += (dx / dist) * push; b.y += (dy / dist) * push;
      }
      b.heading = wrapAngle(b.heading + dHeading * dt);

      // --- speed and wings --------------------------------------------------------
      // Activity drives both; tilting forward hurries, tilting back holds.
      const resting = b.idle > IDLE_AFTER;
      const target = resting ? 0 : SPEED * Math.min(1, b.activity * 1.4) * clamp(1 + 0.6 * b.tiltY, 0.3, 1.6);
      b.speed += (target - b.speed) * lerpFactor(SPEED_TAU, dt);
      b.x += Math.cos(b.heading) * b.speed * dt;
      b.y += Math.sin(b.heading) * b.speed * dt;
      const beat = resting ? 0.6 : (isQueen ? 1.5 + 8 * b.activity : 2 + 16 * b.activity);   // Hz
      const amplitude = resting ? 0.08 : 0.15 + 0.55 * Math.min(1, b.activity * 1.5);        // rad
      b.wingPhase = (b.wingPhase + Math.PI * 2 * beat * dt) % (Math.PI * 2);
      const wing = Math.sin(b.wingPhase) * amplitude;

      if (resting) {
        const aH = lerpFactor(HOME_TAU, dt);
        b.x += (w / 2 - b.x) * aH;
        b.y += (0.5 - b.y) * aH;
      }

      // safety net — the steering should have turned the bee long before
      b.x = clamp(b.x, EDGE + rWorld, w - EDGE - rWorld);
      b.y = clamp(b.y, EDGE + rWorld, 1 - EDGE - rWorld);

      b.trail.push({ x: b.x, y: b.y });
      if (b.trail.length > TRAIL) b.trail.shift();

      // --- draw -----------------------------------------------------------------
      const px = b.x * height, py = b.y * height;
      const c = isQueen ? QUEEN_COLOUR : colour(b.slot);

      ctx.strokeStyle = c;
      ctx.lineWidth = Math.max(1, r * 0.3);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      b.trail.forEach((p, i) => { if (i === 0) ctx.moveTo(p.x * height, p.y * height); else ctx.lineTo(p.x * height, p.y * height); });
      ctx.globalAlpha = b.alpha * 0.22;
      ctx.stroke();

      if (isQueen) {
        // her halo, breathing slowly
        ctx.globalAlpha = b.alpha * (0.35 + 0.2 * Math.sin(time * 2.2));
        ctx.strokeStyle = QUEEN_COLOUR;
        ctx.lineWidth = Math.max(1.5, r * 0.14);
        ctx.setLineDash([r * 0.5, r * 0.35]);
        ctx.beginPath(); ctx.arc(px, py, r * 3.1, time * 0.4, time * 0.4 + Math.PI * 2); ctx.stroke();
        ctx.setLineDash([]);
        const grad = ctx.createRadialGradient(px, py, r * 0.5, px, py, r * 3.4);
        grad.addColorStop(0, 'rgba(242,193,78,0.35)');
        grad.addColorStop(1, 'rgba(242,193,78,0)');
        ctx.globalAlpha = b.alpha;
        ctx.fillStyle = grad;
        ctx.beginPath(); ctx.arc(px, py, r * 3.4, 0, Math.PI * 2); ctx.fill();
      } else if (b.activity > 0.03) {
        // a faint glow, brighter the busier — the size stays put
        const grad = ctx.createRadialGradient(px, py, r * 0.6, px, py, r * 2.4);
        grad.addColorStop(0, c);
        grad.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.globalAlpha = b.alpha * Math.min(0.5, b.activity * 0.7);
        ctx.fillStyle = grad;
        ctx.beginPath(); ctx.arc(px, py, r * 2.4, 0, Math.PI * 2); ctx.fill();
      }

      ctx.globalAlpha = b.alpha * (isQueen ? 1 : 0.6 + 0.4 * Math.min(1, b.activity * 3));
      ctx.save();
      ctx.translate(px, py);
      ctx.rotate(b.heading);
      drawBee(ctx, r, c, wing, isQueen);
      ctx.restore();

      ctx.globalAlpha = b.alpha;
      ctx.fillStyle = isQueen ? QUEEN_COLOUR : '#ffffff';
      ctx.font = `${Math.max(11, r0 * 1.3)}px Bitter, Georgia, serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText((isQueen ? '♛ ' : '') + (b.name || `#${b.slot}`), px, py + r * 2.1);
    }
    ctx.globalAlpha = 1;
  }
}

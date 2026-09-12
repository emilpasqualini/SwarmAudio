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
//  The edge is soft. Inside a margin a bee is nudged back toward the room and
//  gently turned that way, harder the farther out it is, so it drifts back
//  rather than hitting a wall — and a bee in a corner is pushed out of it
//  whatever way it faces. Bees also keep a little distance from each other,
//  so the swarm spreads over the whole wall instead of piling up. New bees appear
//  away from the edge and as far from everyone else as possible, and all bees
//  shrink as the swarm grows.
//
//  One bee is the queen: larger, golden, a halo, a slower beat — the one the
//  room can pick out. The server says who (setting `queenUid`; with no queen
//  it crowns the phone that moved most). The crown passes on the wall: a bee
//  that flies *into* the queen takes it — the mover wins, the queen bumping
//  into a bystander changes nothing — and the wall tells the server. For now
//  the crown is all she has; her solo is still to come.
//
//  The camera (backend/vision) adds a second, anonymous layer: the people it
//  sees are soft shadows on the wall, their groups faint rings. Nobody there is
//  matched to a phone. With coupling on (dashboard), bees are drawn toward the
//  crowds and keep their distance according to how spread out the room is —
//  the room shapes the swarm without anyone holding a phone.
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
const COMFORT = 0.09;             // margin (in units of the shorter side) inside which the edge pushes back
const EDGE_PUSH = 0.14;           // world units / s of push at the very edge (SPEED is 0.16)
const EDGE_STEER = 2.5;           // rad/s of turning back toward the room at the very edge
const EDGE = 0.03;                // hard margin — never crossed
const SEPARATION = 0.05;          // world distance under which bees nudge each other apart — small, collisions are the point
const CROWN_COOLDOWN = 2.5;       // seconds after a crowning before the crown can move again
const FULL_SIZE_UP_TO = 6;        // bees keep their full size up to this many; then they shrink
const TRAIL = 70;                 // frames of trail
const QUEEN_SCALE = 1.7;
const QUEEN_COLOUR = '#f2c14e';
const SHADOW_TTL = 1.0;           // seconds a camera person lingers after the last frame
const SHADOW_TAU = 0.12;          // easing of shadow positions

interface Shadow { x: number; y: number; tx: number; ty: number; depth: number; armsUp: number; energy: number; seen: number }
interface Ring { x: number; y: number; r: number; n: number }

interface Bee {
  slot: number;
  uid: string;
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
  /** A crowning the server has not echoed yet, so the wall never lags its own event. */
  private crowned: { uid: string; at: number } | null = null;
  private round = 0;
  // the camera's layer
  private readonly shadows = new Map<number, Shadow>();
  private rings: Ring[] = [];
  private spread = 0;
  private camCount = 0;
  private camSeen = -Infinity;
  private clock = 0;

  resize(width: number, height: number): void { this.aspect = width / height; }

  snapshot(): { uid: string; slot: number; x: number; y: number; h: number }[] {
    return [...this.bees.values()]
      .filter((b) => !b.leaving)
      .map((b) => ({ uid: b.uid, slot: b.slot, x: +(b.x / this.aspect).toFixed(4), y: +b.y.toFixed(4), h: +b.heading.toFixed(3) }));
  }

  feed(msg: FeedMessage): void {
    if (msg.type === 'join') {
      const existing = this.bees.get(msg.slot);
      if (existing) { existing.leaving = false; existing.name = msg.name; return; }
      const { x, y } = this.spawnPoint();
      this.bees.set(msg.slot, {
        slot: msg.slot, uid: msg.uid, name: msg.name,
        x, y,
        heading: Math.atan2(0.5 - y, this.aspect / 2 - x),   // set off toward the middle
        speed: 0, wingPhase: Math.random() * Math.PI * 2,
        tiltX: 0, tiltY: 0, activity: 0, turn: 0, idle: 0,
        alpha: 0, leaving: false, trail: [],
      });
    } else if (msg.type === 'leave') {
      const b = this.bees.get(msg.slot);
      if (b) b.leaving = true;
    } else if (msg.type === 'vision') {
      const w = this.aspect;
      for (const p of msg.people) {
        const tx = p.x * w, ty = p.y;
        const sh = this.shadows.get(p.id);
        if (sh) { sh.tx = tx; sh.ty = ty; sh.depth = p.depth; sh.armsUp = p.armsUp; sh.energy = p.energy; sh.seen = this.clock; }
        else this.shadows.set(p.id, { x: tx, y: ty, tx, ty, depth: p.depth, armsUp: p.armsUp, energy: p.energy, seen: this.clock });
      }
      this.rings = msg.clusters.map((c) => ({ x: c.x * w, y: c.y, r: c.r * w, n: c.n }));
      this.spread = msg.spread;
      this.camCount = msg.count;
      this.camSeen = this.clock;
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

  draw({ ctx, width, height, dt, time, colour, queen: serverQueen, crown, running, round, coupling }: Frame): void {
    this.aspect = width / height;
    const w = this.aspect;
    this.clock = time;
    this.drawCamera(ctx, height, dt, time);
    // coupling: bees keep their distance according to how spread out the room is
    const camLive = time - this.camSeen < SHADOW_TTL && this.camCount > 0;
    const couple = coupling.on && camLive && running ? coupling.strength : 0;
    const separation = couple > 0 ? SEPARATION * (0.5 + this.spread * 1.5) : SEPARATION;
    if (round !== this.round) {
      // Reset: everyone takes off again from a fresh spot.
      this.round = round;
      this.crowned = null;
      for (const b of this.bees.values()) {
        const p = this.spawnPoint();
        b.x = p.x; b.y = p.y; b.speed = 0; b.trail = [];
        b.heading = Math.atan2(0.5 - p.y, w / 2 - p.x);
      }
    }
    if (this.crowned && (this.crowned.uid === serverQueen || time - this.crowned.at > 10)) this.crowned = null;
    const queen = this.crowned?.uid ?? serverQueen;
    const live = [...this.bees.values()].filter((b) => !b.leaving).length;
    const shrink = Math.min(1, Math.sqrt(FULL_SIZE_UP_TO / Math.max(1, live)));
    const r0 = Math.min(width, height) * this.radius * shrink;
    const sizeOf = (b: Bee): number => b.uid === queen ? QUEEN_SCALE : 1;

    const all = [...this.bees.values()];
    for (const b of all) {
      b.alpha += (b.leaving ? -1 : 1) * dt * 2;
      if (b.alpha <= 0 && b.leaving) { this.bees.delete(b.slot); continue; }
      b.alpha = clamp(b.alpha, 0, 1);
      const isQueen = b.uid === queen;
      const r = r0 * sizeOf(b);
      const rWorld = r * 2 / height;         // a bee is about 2 r long

      // --- steering -----------------------------------------------------------
      // The phone's own rotation about the vertical turns the bee one to one;
      // sideways tilt bends the path. Each edge, on its own, pushes the bee
      // back inward and turns it a little that way — per axis, so a corner
      // pushes diagonally out and the bee cannot get wedged facing the wall.
      let dHeading = b.turn * (Math.PI / 180) * STEER_TURN + b.tiltX * STEER_TILT;
      const outL = Math.max(0, 1 - b.x / COMFORT), outR = Math.max(0, 1 - (w - b.x) / COMFORT);
      const outT = Math.max(0, 1 - b.y / COMFORT), outB = Math.max(0, 1 - (1 - b.y) / COMFORT);
      const pushX = outL * outL - outR * outR, pushY = outT * outT - outB * outB;
      if (pushX !== 0 || pushY !== 0) {
        b.x += pushX * EDGE_PUSH * dt;
        b.y += pushY * EDGE_PUSH * dt;
        const inward = Math.atan2(pushY, pushX);
        const out = Math.min(1, Math.hypot(pushX, pushY));
        dHeading += wrapAngle(inward - b.heading) * out * EDGE_STEER;
      }
      // The crowd the camera sees pulls: toward the nearest group, the bigger
      // the harder, never harder than the tilt itself.
      if (couple > 0 && this.rings.length) {
        let best: Ring | null = null, bestD = Infinity;
        for (const r of this.rings) { const d = Math.hypot(r.x - b.x, r.y - b.y); if (d < bestD) { bestD = d; best = r; } }
        if (best && bestD > best.r) {
          const toward = Math.atan2(best.y - b.y, best.x - b.x);
          dHeading += wrapAngle(toward - b.heading) * couple * STEER_TILT * Math.min(1, best.n / Math.max(1, this.camCount));
        }
      }
      // Neighbours: turn a little away from anyone too close, and never overlap.
      for (const o of all) {
        if (o === b || o.leaving) continue;
        const dx = b.x - o.x, dy = b.y - o.y, dist = Math.hypot(dx, dy);
        if (dist < 1e-4 || dist > separation) continue;
        const away = Math.atan2(dy, dx);
        const closeness = 1 - dist / separation;
        dHeading += wrapAngle(away - b.heading) * closeness * 0.4;
        const minDist = (rWorld + r0 * sizeOf(o) * 2 / height) * 0.6;
        const push = Math.max(0, minDist - dist) * 0.3;   // deep overlap only — touching is allowed
        b.x += (dx / dist) * push; b.y += (dy / dist) * push;
      }
      if (running) b.heading = wrapAngle(b.heading + dHeading * dt);   // paused: hover in place, facing where you were

      // --- speed and wings --------------------------------------------------------
      // Activity drives both, and so does a held tilt — a slow, deliberate lean
      // moves the bee even when nothing shakes. Tilting forward hurries,
      // tilting back holds.
      // Kept simple on purpose: tilt forward = go, tilt sideways = turn,
      // moving about = go. Tilting back does nothing but stop.
      const resting = b.idle > IDLE_AFTER || !running;
      const drive = Math.min(1, Math.max(b.activity * 1.4, b.tiltY));
      const target = resting ? 0 : SPEED * drive;
      b.speed += (target - b.speed) * lerpFactor(SPEED_TAU, dt);
      b.x += Math.cos(b.heading) * b.speed * dt;
      b.y += Math.sin(b.heading) * b.speed * dt;
      const beat = resting ? 0.6 : (isQueen ? 1.5 + 8 * b.activity : 2 + 16 * b.activity);   // Hz
      const amplitude = resting ? 0.08 : 0.15 + 0.55 * Math.min(1, b.activity * 1.5);        // rad
      b.wingPhase = (b.wingPhase + Math.PI * 2 * beat * dt) % (Math.PI * 2);
      const wing = Math.sin(b.wingPhase) * amplitude;

      if (resting && running) {
        // Drift toward a resting spot of one's own on a ring around the middle
        // — not the middle itself, or every resting bee would pile up there and
        // the crown would change hands among people doing nothing.
        const ang = b.slot * 2.399963;             // golden angle: slots spread evenly
        const hx = w / 2 + Math.cos(ang) * 0.22, hy = 0.5 + Math.sin(ang) * 0.22;
        const aH = lerpFactor(HOME_TAU, dt);
        b.x += (hx - b.x) * aH;
        b.y += (hy - b.y) * aH;
      }

      // safety net — the edge push should have kept the bee off it long before
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
        // her halo, breathing slowly — and flaring for a moment when just crowned
        const fresh = this.crowned?.uid === b.uid ? Math.max(0, 1 - (time - this.crowned.at)) : 0;
        ctx.globalAlpha = b.alpha * (0.35 + 0.2 * Math.sin(time * 2.2) + 0.45 * fresh);
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
    if (running) this.passCrown(all, queen, r0 / height, time, crown);
  }

  /** The camera's layer, underneath the bees: soft shadows for people, faint rings for groups. */
  private drawCamera(ctx: CanvasRenderingContext2D, height: number, dt: number, time: number): void {
    const k = lerpFactor(SHADOW_TAU, dt);
    for (const [id, sh] of this.shadows) {
      const age = time - sh.seen;
      if (age > SHADOW_TTL) { this.shadows.delete(id); continue; }
      sh.x += (sh.tx - sh.x) * k; sh.y += (sh.ty - sh.y) * k;
      const px = sh.x * height, py = sh.y * height;
      const r = height * (0.05 + 0.12 * sh.depth);
      const fade = 1 - Math.max(0, age - 0.3) / (SHADOW_TTL - 0.3);
      const bright = 0.10 + 0.08 * sh.energy + 0.12 * (sh.armsUp / 2);
      const grad = ctx.createRadialGradient(px, py, 0, px, py, r);
      grad.addColorStop(0, `rgba(242,184,180,${(bright * fade).toFixed(3)})`);
      grad.addColorStop(1, 'rgba(242,184,180,0)');
      ctx.fillStyle = grad;
      ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2); ctx.fill();
    }
    if (time - this.camSeen < SHADOW_TTL) {
      ctx.strokeStyle = 'rgba(242,184,180,0.18)';
      ctx.lineWidth = 1;
      ctx.setLineDash([6, 8]);
      for (const ring of this.rings) {
        if (ring.n < 2) continue;
        ctx.beginPath(); ctx.arc(ring.x * height, ring.y * height, Math.max(ring.r, 0.04) * height, 0, Math.PI * 2); ctx.stroke();
      }
      ctx.setLineDash([]);
    }
  }

  /** A bee that flies into the queen takes the crown; the queen flying into a bee changes nothing. */
  private passCrown(all: Bee[], queen: string, rUnit: number, time: number, crown: (uid: string) => void): void {
    if (!queen || (this.crowned && time - this.crowned.at < CROWN_COOLDOWN)) return;
    const q = all.find((b) => b.uid === queen && !b.leaving);
    if (!q) return;
    for (const b of all) {
      // Only a bee that is actually flying can take the crown: a phone lying
      // still never does, however close its bee drifts.
      if (b === q || b.leaving || b.alpha < 1 || b.idle > IDLE_AFTER || b.speed < 0.04) continue;
      const dx = q.x - b.x, dy = q.y - b.y, dist = Math.hypot(dx, dy);
      if (dist > (1 + QUEEN_SCALE) * rUnit * 1.6) continue;      // bodies touch
      // Who ran into whom: each one's speed along the line between them.
      const ux = dx / dist, uy = dy / dist;
      const beeIn = (Math.cos(b.heading) * ux + Math.sin(b.heading) * uy) * b.speed;
      const queenIn = -(Math.cos(q.heading) * ux + Math.sin(q.heading) * uy) * q.speed;
      if (beeIn > 0.03 && beeIn > queenIn) {
        this.crowned = { uid: b.uid, at: time };
        crown(b.uid);
        return;
      }
    }
  }
}

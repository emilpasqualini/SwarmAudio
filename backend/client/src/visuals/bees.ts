//
//  bees.ts
//  HIVE (client, wall)
//
//  One animal per phone, moving over the wall — bees, or sheep (dashboard:
//  species). The flight model, the crown and the camera layer are the same
//  for every species; only the drawing differs. A sheep walks (legs swing with
//  its speed), and when it rests it either lies down or grazes — chosen at
//  random each time it comes to rest. The queen sheep is bigger and black.
//
//  The phone is a joystick with two axes, pitch and roll, and nothing else:
//  tip the top edge away and the animal goes up the wall, tip it right and it
//  goes right, the further the faster; hold it level and it stops. That is the
//  whole control. (Turning and shaking do nothing to the position — they are
//  still in the data, for the sound.) The same input always gives the same
//  path: the model is deterministic.
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
//  The camera (backend/vision) adds a second, anonymous layer. In field mode
//  (a full room) it is weather: the optical-flow grid glows where the crowd
//  moves, streaked in the direction of the motion, with a faint warm wash
//  where people stand dense. In people mode (small rounds) the people it
//  sees are soft shadows, their groups faint rings. Nobody is matched to a
//  phone. With coupling on (dashboard), the animals are drawn toward the
//  motion (or the groups), keep their distance according to how coherent
//  (or how spread out) the room is, and when the crowd has a clear beat their
//  wings and legs fall into it — the room shapes the swarm without anyone
//  holding a phone.
//
//  The tilt used here is the server's `rel`, the activity and the turn are the
//  server's too (server/condition.ts), so the wall shows what the OSC side
//  hears. A phone at rest has activity ≈ 0: its bee hovers and drifts home.
//

import { CAM_GRID } from '../../../shared/types';
import type { FeedMessage } from '../../../shared/types';
import type { Frame, Visual } from './visual';

// World coordinates: y runs 0..1 top to bottom, x runs 0..aspect. Distances are
// isotropic that way, which the steering needs.

const TILT_FULL = 9.81 / 2;       // m/s² of rel that counts as full tilt (45°)
const IDLE_AFTER = 1.2;           // seconds at rest before the bee starts drifting home
const HOME_TAU = 4.0;             // how slowly a resting bee drifts back to the centre
const SPEED = 0.24;               // world units / s at full tilt or activity
const SPEED_TAU = 0.25;           // how quickly speed follows the phone
const STEER_TILT = 2.2;           // rad/s the camera coupling may turn an animal at most
const TURN_RATE = 7;              // rad/s the heading swings toward where the tilt points
const DEADZONE = 0.08;            // tilt below this (of full) is "flat"
const COMFORT = 0.09;             // margin (in units of the shorter side) inside which the edge pushes back
const EDGE_PUSH = 0.14;           // world units / s of push at the very edge (SPEED is 0.16)
const EDGE_STEER = 2.5;           // rad/s of turning back toward the room at the very edge
const EDGE = 0.03;                // hard margin — never crossed
const SEPARATION = 0.05;          // world distance under which bees nudge each other apart — small, collisions are the point
const CROWN_COOLDOWN = 2.5;       // seconds after a crowning before the crown can move again
const PUSH = 0.5;                 // how much of the crowd's flow (frame widths/s) an animal picks up when pushed
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
  wingPhase: number;              // radians, advances with the beat frequency (bees) or the gait (sheep)
  idleAnim: 'lie' | 'graze' | null;   // sheep: what it does at rest, picked when it comes to rest
  facing: 1 | -1;                 // sheep: which way it looks — flips with the heading, with some hysteresis
  restingSince: number;           // seconds, for the idle animation's timing
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

/**
 * A sheep seen from the side, in its own frame: origin at the body's centre,
 * +x is the way it faces (the caller mirrors for left), unit r. `gait` swings
 * the legs, `walk` (0..1) is how much; `idle` is what a resting sheep does,
 * with `idleT` seconds into it.
 */
function drawSheep(ctx: CanvasRenderingContext2D, r: number, wool: string, tag: string, gait: number, walk: number,
  idle: 'lie' | 'graze' | null, idleT: number, queen: boolean): void {
  const dark = queen ? '#3a3a3a' : '#2b2b2b';
  const lying = idle === 'lie', graze = idle === 'graze';
  const breathe = lying ? 1 + 0.03 * Math.sin(idleT * 1.6) : 1;
  const ground = 1.15 * r;                       // where the hooves touch
  const bodyY = lying ? 0.45 * r : -0.05 * r;    // a lying sheep sits low
  // legs — four, swinging in diagonal pairs; tucked away when lying
  if (!lying) {
    ctx.strokeStyle = dark;
    ctx.lineWidth = Math.max(1.5, r * 0.2);
    ctx.lineCap = 'round';
    const swing = Math.sin(gait) * 0.3 * r * walk;
    for (const [lx, phase] of [[0.65, 1], [0.4, -1], [-0.4, -1], [-0.65, 1]] as const) {
      ctx.beginPath(); ctx.moveTo(lx * r, 0.45 * r); ctx.lineTo(lx * r + swing * phase, ground); ctx.stroke();
    }
  }
  // wool: an oval of overlapping puffs — the black sheep gets a thin white rim so it reads on the black wall
  const bw = 1.15 * r * breathe, bh = (lying ? 0.6 : 0.72) * r * breathe;
  const woolFill = (grow: number): void => {
    ctx.beginPath(); ctx.ellipse(-0.05 * r, bodyY, bw + grow, bh + grow, 0, 0, Math.PI * 2); ctx.fill();
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2 + 0.3;
      ctx.beginPath(); ctx.arc(-0.05 * r + Math.cos(a) * bw * 0.72, bodyY + Math.sin(a) * bh * 0.7, r * 0.4 * breathe + grow, 0, Math.PI * 2); ctx.fill();
    }
    ctx.beginPath(); ctx.arc(-1.25 * r, bodyY - 0.25 * r, r * 0.18 + grow, 0, Math.PI * 2); ctx.fill();
  };
  if (queen) { ctx.fillStyle = '#ffffff'; woolFill(Math.max(1.5, r * 0.1)); }   // the rim: the same shape, a little larger, in white underneath
  ctx.fillStyle = wool;
  woolFill(0);
  // head: up when walking, down in the grass when grazing, resting low when lying
  const nibble = graze ? 0.05 * r * Math.sin(idleT * 6) : 0;
  const hx = graze ? 1.15 * r + nibble : lying ? 1.05 * r : 1.1 * r;
  const hy = graze ? ground - 0.35 * r : lying ? bodyY - 0.05 * r : bodyY - 0.55 * r;
  ctx.save();
  ctx.translate(hx, hy);
  ctx.rotate(graze ? 0.9 : lying ? 0.1 : -0.15);
  ctx.fillStyle = dark;
  ctx.beginPath(); ctx.ellipse(0, 0, 0.45 * r, 0.32 * r, 0, 0, Math.PI * 2); ctx.fill();
  // ear with the slot's tag, and an eye
  ctx.beginPath(); ctx.ellipse(-0.2 * r, -0.3 * r, 0.22 * r, 0.1 * r, -0.4, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = tag;
  ctx.beginPath(); ctx.arc(-0.24 * r, -0.32 * r, 0.08 * r, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = queen ? '#f2c14e' : '#ffffff';
  ctx.beginPath(); ctx.arc(0.14 * r, -0.08 * r, 0.05 * r, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
  if (graze) {
    // a tuft of grass under the nose
    ctx.strokeStyle = 'rgba(120,180,110,0.85)';
    ctx.lineWidth = Math.max(1, r * 0.08);
    ctx.lineCap = 'round';
    for (const dx of [-0.15, 0, 0.15]) {
      ctx.beginPath(); ctx.moveTo((1.45 + dx) * r, ground); ctx.lineTo((1.45 + dx * 2) * r, ground - 0.3 * r); ctx.stroke();
    }
  }
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
  // the field
  private camMode: 'field' | 'people' = 'field';
  private flow: [number, number, number][] = [];
  private density: number[] = [];
  private flowCoherence = 0;
  private beat = 0;
  private beatStrength = 0;
  private hot: { x: number; y: number; e: number }[] = [];   // the liveliest cells, world coordinates

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
        speed: 0, wingPhase: Math.random() * Math.PI * 2, idleAnim: null, restingSince: 0, facing: 1,
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
      this.camMode = msg.mode;
      this.flow = msg.flow;
      this.density = msg.density;
      this.flowCoherence = msg.flowCoherence;
      this.beat = msg.beat;
      this.beatStrength = msg.beatStrength;
      this.hot = msg.flow
        .map((c, k) => ({ x: ((k % CAM_GRID.w) + 0.5) / CAM_GRID.w * w, y: (Math.floor(k / CAM_GRID.w) + 0.5) / CAM_GRID.h, e: c[2] }))
        .filter((c) => c.e > 0.15)
        .sort((a, b) => b.e - a.e)
        .slice(0, 3);
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

  draw({ ctx, width, height, dt, time, colour, queen: serverQueen, crown, running, round, coupling, species, queenHidden, push }: Frame): void {
    const sheep = species === 'sheep';
    this.aspect = width / height;
    const w = this.aspect;
    this.clock = time;
    this.drawCamera(ctx, height, dt, time);
    // coupling: the animals keep their distance according to the room — how
    // coherent its motion is (field) or how spread out it stands (people)
    const fieldMode = this.camMode === 'field';
    const camLive = time - this.camSeen < SHADOW_TTL && (fieldMode ? this.hot.length > 0 : this.camCount > 0);
    const couple = coupling.on && camLive && running ? coupling.strength : 0;
    const separation = couple > 0
      ? SEPARATION * (fieldMode ? 1.5 - this.flowCoherence : 0.5 + this.spread * 1.5)
      : SEPARATION;
    const beatLocked = couple > 0 && fieldMode && this.beatStrength > 0.4 && this.beat > 0;
    const shove = push && running && time - this.camSeen < SHADOW_TTL && this.flow.length > 0;
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
    const r0 = Math.min(width, height) * this.radius * shrink * (sheep ? 1.5 : 1);   // a sheep is a bigger animal
    const sizeOf = (b: Bee): number => b.uid === queen && !queenHidden ? QUEEN_SCALE : 1;

    const all = [...this.bees.values()];
    for (const b of all) {
      b.alpha += (b.leaving ? -1 : 1) * dt * 2;
      if (b.alpha <= 0 && b.leaving) { this.bees.delete(b.slot); continue; }
      b.alpha = clamp(b.alpha, 0, 1);
      // hidden-queen game: she looks like everyone else (the crown still passes, silently)
      const isQueen = b.uid === queen && !queenHidden;
      const r = r0 * (queenHidden ? 1 : sizeOf(b));
      const rWorld = r * 2 / height;         // a bee is about 2 r long

      // --- steering -----------------------------------------------------------
      // Pitch and roll are the joystick: tip right → right, tip away → up.
      // The heading only follows where the animal goes. Then each edge, on
      // its own, pushes it back inward and turns it a little that way — per
      // axis, so a corner pushes diagonally out.
      const jx = b.tiltX, jy = -b.tiltY;
      const joy = Math.min(1, Math.hypot(jx, jy));
      let dHeading = 0;
      if (joy > DEADZONE) dHeading += wrapAngle(Math.atan2(jy, jx) - b.heading) * TURN_RATE;
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
      if (couple > 0 && fieldMode && this.hot.length) {
        // toward the nearest of the liveliest cells, the livelier the harder
        let best = this.hot[0]!, bestD = Infinity;
        for (const c of this.hot) { const d = Math.hypot(c.x - b.x, c.y - b.y); if (d < bestD) { bestD = d; best = c; } }
        if (bestD > 0.08) {
          const toward = Math.atan2(best.y - b.y, best.x - b.x);
          dHeading += wrapAngle(toward - b.heading) * couple * STEER_TILT * best.e;
        }
      } else if (couple > 0 && this.rings.length) {
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
      // Tilt sets the speed — the further, the faster; level = stop.
      const resting = b.idle > IDLE_AFTER || !running;
      const drive = joy > DEADZONE ? joy : 0;
      const target = resting ? 0 : SPEED * drive;
      b.speed += (target - b.speed) * lerpFactor(SPEED_TAU, dt);
      b.x += Math.cos(b.heading) * b.speed * dt;
      b.y += Math.sin(b.heading) * b.speed * dt;
      const beat = resting ? 0.6 : (isQueen ? 1.5 + 8 * b.activity : 2 + 16 * b.activity);   // Hz
      const amplitude = resting ? 0.08 : 0.15 + 0.55 * Math.min(1, b.activity * 1.5);        // rad
      // bees: wings beat with activity. sheep: legs swing with the distance walked.
      if (beatLocked && !resting) b.wingPhase = (b.wingPhase + Math.PI * 2 * this.beat * dt) % (Math.PI * 2);   // the room's beat
      else if (sheep) b.wingPhase = (b.wingPhase + b.speed * 60 * dt) % (Math.PI * 2);
      else b.wingPhase = (b.wingPhase + Math.PI * 2 * beat * dt) % (Math.PI * 2);
      const wing = Math.sin(b.wingPhase) * amplitude;
      // a sheep that comes to rest decides — by lot — whether to lie down or graze
      if (resting && b.idleAnim === null) { b.idleAnim = Math.random() < 0.5 ? 'lie' : 'graze'; b.restingSince = time; }
      if (!resting && b.speed > 0.02) b.idleAnim = null;

      if (shove) {
        // the crowd's motion under the animal gives it a nudge — a draught, not a current
        const ci = Math.min(CAM_GRID.w - 1, Math.floor(b.x / w * CAM_GRID.w)), cj = Math.min(CAM_GRID.h - 1, Math.floor(b.y * CAM_GRID.h));
        const cell = this.flow[cj * CAM_GRID.w + ci];
        if (cell && cell[2] > 0.05) {
          b.x += cell[0] * w * PUSH * cell[2] * dt;
          b.y += cell[1] * PUSH * cell[2] * dt;
        }
      }

      if (resting && running) {
        // Drift toward a resting spot of one's own on a ring around the middle
        // — not the middle itself, or every resting bee would pile up there and
        // the crown would change hands among people doing nothing.
        const ang = b.slot * 2.399963;             // golden angle: slots spread evenly
        const hx = w / 2 + Math.cos(ang) * 0.2, hy = 0.42 + Math.sin(ang) * 0.18;   // a little high, clear of the QR cards
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

      if (sheep) {
        // sheep leave no trail and no glow; the queen is the big black one
        const wool = isQueen ? '#111111' : '#f1ede6';
        ctx.globalAlpha = b.alpha;

        // a sheep does not turn like a bee: it faces left or right, and flips when its way clearly changes
        const cx = Math.cos(b.heading);
        if (cx > 0.25) b.facing = 1; else if (cx < -0.25) b.facing = -1;
        ctx.save();
        ctx.translate(px, py);
        ctx.scale(b.facing, 1);
        drawSheep(ctx, r, wool, colour(b.slot), b.wingPhase, Math.min(1, b.speed / (SPEED * 0.6)), resting ? b.idleAnim : null, time - b.restingSince, isQueen);
        ctx.restore();
        ctx.globalAlpha = b.alpha;
        ctx.fillStyle = isQueen ? QUEEN_COLOUR : '#ffffff';
        ctx.font = `${Math.max(11, r0 * 1.3)}px Bitter, Georgia, serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillText((isQueen ? '♛ ' : '') + (b.name || `#${b.slot}`), px, py + r * 1.6);
        continue;
      }

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
    const live = time - this.camSeen < SHADOW_TTL;
    if (this.camMode === 'field' && live && this.flow.length) {
      // the field: a glow per cell where the picture moves, streaked with the
      // flow; a fainter warm wash where people stand dense
      const w = this.aspect;
      const cw = w / CAM_GRID.w * height, ch = height / CAM_GRID.h;
      const rad = Math.max(cw, ch) * 0.9;
      for (let k = 0; k < this.flow.length; k++) {
        const [vx, vy, e] = this.flow[k]!;
        const d = this.density[k] ?? 0;
        if (e < 0.02 && d < 0.05) continue;
        const px = ((k % CAM_GRID.w) + 0.5) * cw, py = (Math.floor(k / CAM_GRID.w) + 0.5) * ch;
        if (d > 0.05) {
          const g = ctx.createRadialGradient(px, py, 0, px, py, rad * 1.2);
          g.addColorStop(0, `rgba(242,184,180,${(0.06 * d).toFixed(3)})`);
          g.addColorStop(1, 'rgba(242,184,180,0)');
          ctx.fillStyle = g;
          ctx.beginPath(); ctx.arc(px, py, rad * 1.2, 0, Math.PI * 2); ctx.fill();
        }
        if (e >= 0.02) {
          const g = ctx.createRadialGradient(px, py, 0, px, py, rad);
          g.addColorStop(0, `rgba(242,184,180,${(0.18 * e).toFixed(3)})`);
          g.addColorStop(1, 'rgba(242,184,180,0)');
          ctx.fillStyle = g;
          ctx.beginPath(); ctx.arc(px, py, rad, 0, Math.PI * 2); ctx.fill();
          const mag = Math.hypot(vx, vy);
          if (mag > 0.02) {
            ctx.strokeStyle = `rgba(242,184,180,${(0.35 * e).toFixed(3)})`;
            ctx.lineWidth = Math.max(1, rad * 0.06);
            ctx.lineCap = 'round';
            const L = rad * 0.7 * e;
            ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px + vx / mag * L, py + vy / mag * L); ctx.stroke();
          }
        }
      }
      // the people the model still finds (front rows) and their groups, on top of the field
      this.drawPeople(ctx, height, dt, time, 0.6);
      return;
    }
    this.drawPeople(ctx, height, dt, time, 1);
  }

  /** Shadows for the people the camera sees, rings for their groups; `scale` shrinks them in field mode. */
  private drawPeople(ctx: CanvasRenderingContext2D, height: number, dt: number, time: number, scale: number): void {
    const k = lerpFactor(SHADOW_TAU, dt);
    for (const [id, sh] of this.shadows) {
      const age = time - sh.seen;
      if (age > SHADOW_TTL) { this.shadows.delete(id); continue; }
      sh.x += (sh.tx - sh.x) * k; sh.y += (sh.ty - sh.y) * k;
      const px = sh.x * height, py = sh.y * height;
      const r = height * (0.05 + 0.12 * sh.depth) * scale;
      const fade = 1 - Math.max(0, age - 0.3) / (SHADOW_TTL - 0.3);
      const bright = 0.10 + 0.08 * sh.energy + 0.12 * (sh.armsUp / 2);
      const grad = ctx.createRadialGradient(px, py, 0, px, py, r);
      grad.addColorStop(0, `rgba(242,184,180,${(bright * fade).toFixed(3)})`);
      grad.addColorStop(1, 'rgba(242,184,180,0)');
      ctx.fillStyle = grad;
      ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2); ctx.fill();
    }
    if (time - this.camSeen < SHADOW_TTL) {
      // groups: a dashed ring, the members joined by faint threads, the size in the middle
      ctx.lineWidth = 1;
      for (const ring of this.rings) {
        if (ring.n < 2) continue;
        const cx = ring.x * height, cy = ring.y * height, rr = Math.max(ring.r, 0.04) * height * 1.15;
        ctx.strokeStyle = 'rgba(242,184,180,0.12)';
        ctx.setLineDash([]);
        for (const sh of this.shadows.values()) {
          const dx = sh.x * height - cx, dy = sh.y * height - cy;
          if (Math.hypot(dx, dy) <= rr) { ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + dx, cy + dy); ctx.stroke(); }
        }
        ctx.strokeStyle = 'rgba(242,184,180,0.28)';
        ctx.setLineDash([6, 8]);
        ctx.beginPath(); ctx.arc(cx, cy, rr, time * 0.2, time * 0.2 + Math.PI * 2); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = 'rgba(242,184,180,0.5)';
        ctx.font = `${Math.max(11, height * 0.018)}px Bitter, Georgia, serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(ring.n), cx, cy);
      }
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

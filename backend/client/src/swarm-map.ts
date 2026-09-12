//
//  swarm-map.ts
//  HIVE (client, phone)
//
//  The wall in miniature: one dot per bee, yours ringed, the queen golden.
//
//  Positions come from the wall — the flight model runs there — and reach the
//  phone on the link it already has: as the reply to a POSTed frame, or as a
//  text message down the socket (transport.ts). Ten snapshots a second; the
//  map draws a fifth of a second behind and slides each dot between the two
//  snapshots around that moment, so the picture moves at the wall's pace
//  rather than in ten steps a second. Nothing is polled.
//

import { slotColour } from './dom';

/** `{ v, q, b: [[uid, slot, x, y, h], …] }` — see server/wall.ts. */
interface Wire { v: number; q: string; b: [string, number, number, number, number][] }

const DELAY_MS = 200;           // render this far behind the newest snapshot
const QUEEN_COLOUR = '#f2c14e';

interface Track {
  slot: number;
  // the two snapshots the render time falls between
  x0: number; y0: number; h0: number; t0: number;
  x1: number; y1: number; h1: number; t1: number;
  seen: number;
}

const lerpAngle = (a: number, b: number, k: number): number => a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * k;

export class SwarmMap {
  readonly canvas = document.createElement('canvas');
  slot: number | null = null;
  private queenUid = '';
  private readonly tracks = new Map<string, Track>();
  private raf = 0;
  private version = 0;

  constructor(private readonly myUid: string) {
    this.canvas.className = 'swarm-map';
    const frame = (): void => { this.draw(); this.raf = requestAnimationFrame(frame); };
    this.raf = requestAnimationFrame(frame);
  }

  get iAmQueen(): boolean { return this.queenUid !== '' && this.queenUid === this.myUid; }

  stop(): void { cancelAnimationFrame(this.raf); }

  /** A snapshot from the server, as text. Out-of-order or repeated ones are ignored. */
  receive(text: string): void {
    let w: Wire;
    try { w = JSON.parse(text) as Wire; } catch { return; }
    if (typeof w.v !== 'number' || w.v <= this.version || !Array.isArray(w.b)) return;
    this.version = w.v;
    this.queenUid = w.q;
    const now = performance.now();
    for (const [uid, slot, x, y, h] of w.b) {
      const t = this.tracks.get(uid);
      if (!t) { this.tracks.set(uid, { slot, x0: x, y0: y, h0: h, t0: now, x1: x, y1: y, h1: h, t1: now, seen: now }); continue; }
      // the newest becomes the target; the previous target becomes the start
      t.x0 = t.x1; t.y0 = t.y1; t.h0 = t.h1; t.t0 = t.t1;
      t.x1 = x; t.y1 = y; t.h1 = h; t.t1 = now;
      t.slot = slot; t.seen = now;
    }
    for (const [uid, t] of this.tracks) if (now - t.seen > 2000) this.tracks.delete(uid);
  }

  private draw(): void {
    const c = this.canvas;
    const w = c.clientWidth, h = c.clientHeight;
    if (w === 0) return;
    const dpr = window.devicePixelRatio || 1;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const r = Math.max(3, Math.min(w, h) * 0.035);
    const renderT = performance.now() - DELAY_MS;
    for (const [uid, t] of this.tracks) {
      const span = t.t1 - t.t0;
      const k = span > 0 ? Math.max(0, Math.min(1, (renderT - t.t0) / span)) : 1;
      const x = t.x0 + (t.x1 - t.x0) * k, y = t.y0 + (t.y1 - t.y0) * k, hd = lerpAngle(t.h0, t.h1, k);
      const px = x * w, py = y * h;
      const mine = uid === this.myUid, queen = uid === this.queenUid;
      const colour = queen ? QUEEN_COLOUR : slotColour(t.slot);
      const rr = queen ? r * 1.7 : r;
      // a short tail shows the heading
      ctx.strokeStyle = colour;
      ctx.globalAlpha = mine || queen ? 0.9 : 0.5;
      ctx.lineWidth = Math.max(1, rr * 0.35);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(px - Math.cos(hd) * rr * 2.2, py - Math.sin(hd) * rr * 2.2);
      ctx.stroke();
      ctx.fillStyle = colour;
      ctx.beginPath(); ctx.arc(px, py, rr, 0, Math.PI * 2); ctx.fill();
      if (mine) {
        ctx.globalAlpha = 1;
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(px, py, rr + 4, 0, Math.PI * 2); ctx.stroke();
      }
      if (queen) {
        ctx.globalAlpha = 0.5;
        ctx.strokeStyle = QUEEN_COLOUR;
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.beginPath(); ctx.arc(px, py, rr * 2.2, 0, Math.PI * 2); ctx.stroke();
        ctx.setLineDash([]);
      }
    }
    ctx.globalAlpha = 1;
    // who you are, in the corner
    if (this.slot) {
      ctx.fillStyle = slotColour(this.slot);
      ctx.font = `${Math.max(12, r * 3.2)}px 'Young Serif', Georgia, serif`;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'top';
      ctx.fillText(`#${this.slot}`, w - 8, 6);
    }
  }
}

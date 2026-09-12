//
//  swarm-map.ts
//  HIVE (client, phone)
//
//  The wall in miniature: one dot per bee, yours ringed, the queen golden.
//
//  Positions come from the wall — the flight model runs there — via the
//  server's `/api/wall` snapshot, polled four times a second and eased between
//  polls so the dots glide rather than jump. Polling rather than a socket
//  because iPhones reach the server over POST only (self-signed certificate,
//  no wss), and a small GET every 250 ms is nothing next to the sensor stream.
//

import { slotColour } from './dom';

interface WallBee { uid: string; slot: number; x: number; y: number; h: number }
interface Snapshot { t: number; queenUid: string; bees: WallBee[] }

const POLL_MS = 250;
const QUEEN_COLOUR = '#f2c14e';

export class SwarmMap {
  readonly canvas = document.createElement('canvas');
  slot: number | null = null;
  private queenUid = '';
  private readonly dots = new Map<string, { x: number; y: number; tx: number; ty: number; h: number; slot: number; seen: number }>();
  private timer: number | null = null;
  private raf = 0;
  private inflight = false;

  constructor(private readonly myUid: string) {
    this.canvas.className = 'swarm-map';
    this.timer = window.setInterval(() => void this.poll(), POLL_MS);
    void this.poll();
    const frame = (): void => { this.draw(); this.raf = requestAnimationFrame(frame); };
    this.raf = requestAnimationFrame(frame);
  }

  get iAmQueen(): boolean { return this.queenUid !== '' && this.queenUid === this.myUid; }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    cancelAnimationFrame(this.raf);
    this.timer = null;
  }

  private async poll(): Promise<void> {
    if (this.inflight || document.visibilityState !== 'visible') return;
    this.inflight = true;
    try {
      const res = await fetch('/api/wall', { cache: 'no-store' });
      if (!res.ok) return;
      const snap = (await res.json()) as Snapshot;
      this.queenUid = snap.queenUid;
      const now = performance.now();
      for (const b of snap.bees) {
        const d = this.dots.get(b.uid);
        if (d) { d.tx = b.x; d.ty = b.y; d.h = b.h; d.slot = b.slot; d.seen = now; }
        else this.dots.set(b.uid, { x: b.x, y: b.y, tx: b.x, ty: b.y, h: b.h, slot: b.slot, seen: now });
      }
      for (const [uid, d] of this.dots) if (now - d.seen > 2000) this.dots.delete(uid);
    } catch { /* offline for a moment — keep the last picture */ }
    finally { this.inflight = false; }
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
    const ease = 0.18;
    for (const [uid, d] of this.dots) {
      d.x += (d.tx - d.x) * ease; d.y += (d.ty - d.y) * ease;
      const px = d.x * w, py = d.y * h;
      const mine = uid === this.myUid, queen = uid === this.queenUid;
      const colour = queen ? QUEEN_COLOUR : slotColour(d.slot);
      const rr = queen ? r * 1.7 : r;
      // a short tail shows the heading
      ctx.strokeStyle = colour;
      ctx.globalAlpha = mine || queen ? 0.9 : 0.5;
      ctx.lineWidth = Math.max(1, rr * 0.35);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(px - Math.cos(d.h) * rr * 2.2, py - Math.sin(d.h) * rr * 2.2);
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

//
//  vision.ts
//  HIVE (server)
//
//  The room as the camera sees it.
//
//  A Python process (backend/vision/hive_vision.py — YOLO pose on a webcam)
//  connects to `/vision` on the plain HTTP port and sends one JSON message per
//  processed frame: people (anonymous tracker ids, never matched to phones),
//  clusters, and a few room-level numbers — plus, as binary messages, a small
//  annotated JPEG so the dashboard can show what the camera sees. This class
//  validates, keeps the latest, adds what only a sequence of frames can tell
//  (flow, turbulence, converging, stillness — the crowd's motion), and hands
//  frames on; OSC, the feed, the wall and the dashboard subscribe here. Settings the camera side needs (cluster
//  radius, mirror, preview on/off) are pushed down the same socket.
//

import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import type { VisionCluster, VisionFrame, VisionPerson, VisionStatus } from '../shared/types';

const STALE_MS = 2000;
const MAX_PREVIEW = 512 * 1024;

export interface VisionSettings { eps: number; mirror: boolean; preview: boolean; camera: number }

const num = (v: unknown, lo = -1e9, hi = 1e9): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : 0;
};

export class VisionIn {
  readonly wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PREVIEW, perMessageDeflate: false });
  private client: WebSocket | null = null;
  private latest: VisionFrame | null = null;
  private lastAt = 0;
  private preview: Buffer | null = null;
  private settings: VisionSettings = { eps: 0.12, mirror: true, preview: true, camera: -1 };
  private cameras: string[] = [];
  private backend = '';
  /** Last position per tracker id, for velocities. */
  private readonly prev = new Map<number, { x: number; y: number; t: number }>();
  private lastSpread: { v: number; t: number } | null = null;
  private converge = 0;
  private readonly frameListeners: ((f: VisionFrame) => void)[] = [];
  private readonly previewListeners: ((jpeg: Buffer) => void)[] = [];

  constructor(private readonly log: (line: string) => void) {
    this.wss.on('connection', (socket) => {
      // One camera at a time; a newer connection replaces the old one.
      if (this.client && this.client !== socket) this.client.close(1000, 'replaced');
      this.client = socket;
      this.log('camera attached');
      socket.send(JSON.stringify({ type: 'settings', ...this.settings }));
      socket.on('message', (data, isBinary) => {
        if (isBinary) {
          const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
          this.preview = buf;
          for (const fn of this.previewListeners) fn(buf);
          return;
        }
        let raw: Record<string, unknown>;
        try { raw = JSON.parse(String(data)) as Record<string, unknown>; } catch { return; }
        if (raw['type'] === 'hello') {
          this.cameras = Array.isArray(raw['cameras']) ? (raw['cameras'] as unknown[]).map(String).slice(0, 8) : [];
          this.backend = String(raw['backend'] ?? '');
          return;
        }
        const frame = this.parse(raw);
        if (!frame) return;
        this.motion(frame);
        this.latest = frame;
        this.lastAt = Date.now();
        for (const fn of this.frameListeners) fn(frame);
      });
      socket.on('close', () => { if (this.client === socket) { this.client = null; this.log('camera detached'); } });
      socket.on('error', (err) => this.log(`camera: ${err.message}`));
    });
  }

  onFrame(fn: (f: VisionFrame) => void): void { this.frameListeners.push(fn); }
  onPreview(fn: (jpeg: Buffer) => void): void { this.previewListeners.push(fn); }

  get connected(): boolean { return this.client !== null && Date.now() - this.lastAt < STALE_MS; }
  get current(): VisionFrame | null { return this.connected ? this.latest : null; }
  get lastPreview(): Buffer | null { return this.preview; }

  status(): VisionStatus {
    const f = this.current;
    return {
      connected: this.connected,
      cameras: this.cameras,
      backend: this.backend,
      fps: f?.fps ?? 0,
      count: f?.count ?? 0,
      clusters: f?.clusters.length ?? 0,
      spread: f?.spread ?? 0,
      energy: f?.energy ?? 0,
      flowX: f?.flowX ?? 0, flowY: f?.flowY ?? 0, turbulence: f?.turbulence ?? 0, moveSync: f?.moveSync ?? 0,
      converge: f?.converge ?? 0, nearest: f?.nearest ?? 0, stillness: f?.stillness ?? 0, occupancy: f?.occupancy ?? 0,
    };
  }

  /** Cluster radius, mirror and preview flag; forwarded to the camera process. */
  configure(s: VisionSettings): void {
    if (s.eps === this.settings.eps && s.mirror === this.settings.mirror && s.preview === this.settings.preview && s.camera === this.settings.camera) return;
    this.settings = { ...s };
    if (this.client?.readyState === this.client?.OPEN) this.client?.send(JSON.stringify({ type: 'settings', ...this.settings }));
  }

  /** The crowd's motion: needs the previous frame, so it lives here rather than in Python. */
  private motion(f: VisionFrame): void {
    const t = f.t / 1000;
    const vel: { x: number; y: number }[] = [];
    let still = 0;
    for (const p of f.people) {
      const q = this.prev.get(p.id);
      if (q && t - q.t > 0 && t - q.t < 1) vel.push({ x: (p.x - q.x) / (t - q.t), y: (p.y - q.y) / (t - q.t) });
      this.prev.set(p.id, { x: p.x, y: p.y, t });
      if (p.energy < 0.05) still++;
    }
    for (const [id, q] of this.prev) if (t - q.t > 2) this.prev.delete(id);
    const n = vel.length;
    if (n) {
      let fx = 0, fy = 0;
      for (const v of vel) { fx += v.x; fy += v.y; }
      fx /= n; fy /= n;
      let turb = 0;
      for (const v of vel) turb += (v.x - fx) ** 2 + (v.y - fy) ** 2;
      f.flowX = fx; f.flowY = fy; f.turbulence = Math.sqrt(turb / n);
      // moving people only: cosine similarity of their velocities, pairwise
      const moving = vel.filter((v) => Math.hypot(v.x, v.y) > 0.03);
      let sum = 0, pairs = 0;
      for (let i = 0; i < moving.length; i++) for (let j = i + 1; j < moving.length; j++) {
        const a = moving[i]!, b = moving[j]!;
        sum += (a.x * b.x + a.y * b.y) / (Math.hypot(a.x, a.y) * Math.hypot(b.x, b.y)); pairs++;
      }
      f.moveSync = pairs ? sum / pairs : 0;
    }
    if (this.lastSpread && t - this.lastSpread.t > 0) {
      const d = (f.spread - this.lastSpread.v) / (t - this.lastSpread.t);
      this.converge += (d - this.converge) * 0.15;
    }
    this.lastSpread = { v: f.spread, t };
    f.converge = f.count > 1 ? this.converge : 0;
    if (f.count > 1) {
      let sumNearest = 0;
      for (const p of f.people) {
        let best = Infinity;
        for (const q of f.people) if (q !== p) best = Math.min(best, Math.hypot(p.x - q.x, p.y - q.y));
        sumNearest += best;
      }
      f.nearest = sumNearest / f.count;
    }
    f.stillness = f.count ? still / f.count : 0;
    const cells = new Set<number>();
    for (const p of f.people) cells.add(Math.min(3, Math.floor(p.x * 4)) + 4 * Math.min(2, Math.floor(p.y * 3)));
    f.occupancy = cells.size / 12;
  }

  private parse(raw: Record<string, unknown>): VisionFrame | null {
    if (raw['type'] !== 'frame') return null;
    const people: VisionPerson[] = Array.isArray(raw['people'])
      ? (raw['people'] as Record<string, unknown>[]).slice(0, 64).map((p) => ({
        id: Math.round(num(p['id'], 0, 1e6)),
        x: num(p['x'], 0, 1), y: num(p['y'], 0, 1), depth: num(p['depth'], 0, 1),
        armsUp: Math.round(num(p['armsUp'], 0, 2)), crouch: num(p['crouch'], 0, 1), energy: num(p['energy'], 0, 1),
      }))
      : [];
    const clusters: VisionCluster[] = Array.isArray(raw['clusters'])
      ? (raw['clusters'] as Record<string, unknown>[]).slice(0, 64).map((c) => ({
        n: Math.round(num(c['n'], 0, 64)), x: num(c['x'], 0, 1), y: num(c['y'], 0, 1), r: num(c['r'], 0, 1),
      }))
      : [];
    return {
      t: Date.now(),
      fps: num(raw['fps'], 0, 240),
      count: people.length,
      clusters,
      people,
      spread: num(raw['spread'], 0, 2),
      energy: num(raw['energy'], 0, 1),
      cx: num(raw['cx'], 0, 1),
      cy: num(raw['cy'], 0, 1),
      armsUp: num(raw['armsUp'], 0, 2),
      flowX: 0, flowY: 0, turbulence: 0, moveSync: 0, converge: 0, nearest: 0, stillness: 0, occupancy: 0,
    };
  }
}

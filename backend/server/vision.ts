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
//  validates, keeps the latest, and hands frames on; OSC, the feed, the wall
//  and the dashboard subscribe here. Settings the camera side needs (cluster
//  radius, mirror, preview on/off) are pushed down the same socket.
//

import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import type { VisionCluster, VisionFrame, VisionPerson, VisionStatus } from '../shared/types';

const STALE_MS = 2000;
const MAX_PREVIEW = 512 * 1024;

export interface VisionSettings { eps: number; mirror: boolean; preview: boolean }

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
  private settings: VisionSettings = { eps: 0.12, mirror: true, preview: true };
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
        const frame = this.parse(String(data));
        if (!frame) return;
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
      fps: f?.fps ?? 0,
      count: f?.count ?? 0,
      clusters: f?.clusters.length ?? 0,
      spread: f?.spread ?? 0,
      energy: f?.energy ?? 0,
    };
  }

  /** Cluster radius, mirror and preview flag; forwarded to the camera process. */
  configure(s: VisionSettings): void {
    if (s.eps === this.settings.eps && s.mirror === this.settings.mirror && s.preview === this.settings.preview) return;
    this.settings = { ...s };
    if (this.client?.readyState === this.client?.OPEN) this.client?.send(JSON.stringify({ type: 'settings', ...this.settings }));
  }

  private parse(text: string): VisionFrame | null {
    let raw: Record<string, unknown>;
    try { raw = JSON.parse(text) as Record<string, unknown>; } catch { return null; }
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
    };
  }
}

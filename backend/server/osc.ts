//
//  osc.ts
//  HIVE (server)
//
//  Every sample out as OSC, to every enabled target.
//
//  The messages are built from shared/osc-schema.ts — read that file (or
//  docs/OSC.md, generated from it) for what each field means. Two shapes of
//  the same data go out: a wide `/hive/sample` with everything in a fixed
//  order, and per-field `/hive/dev/<slot>/…` messages for quick patching.
//  Either can be switched off on the dashboard. One UDP socket, no
//  per-target state beyond a counter and the last error.
//

import { createSocket } from 'node:dgram';
import type { Socket } from 'node:dgram';
import { encodeBundle, encodeMessage } from './osc-encode';
import type { OscArg } from './osc-encode';
import type { Targets } from './targets';
import type { Registry } from './registry';
import { OSC_SCHEMA_VERSION } from '../shared/osc-schema';
import type { DeviceInfo, GlobalFeatures, Sample, SwarmFeatures, VisionFrame } from '../shared/types';

export interface OscFlags { wide: boolean; perField: boolean; roster: boolean; swarm: boolean; global: boolean; cam: boolean; camPersons: boolean }

/** Arguments of `/hive/sample`. Order and meaning: SAMPLE_FIELDS in shared/osc-schema.ts. Append only. */
export function sampleArgs(s: Sample, t: number): OscArg[] {
  const [ax, ay, az] = s.acc;
  const [rx, ry, rz] = s.rel;
  const [gx, gy, gz] = s.gyro;
  return [
    { i: s.slot }, s.uid, t,
    ax, ay, az,
    rx, ry, rz,
    gx, gy, gz,
    s.activity, s.idle,
    Math.hypot(ax, ay, az), Math.hypot(rx, ry, rz), Math.hypot(gx, gy, gz),
    s.turn,
  ];
}

/** Arguments of `/hive/swarm`. Order and meaning: SWARM_FIELDS. Append only. */
export function swarmArgs(f: SwarmFeatures, t: number): OscArg[] {
  return [t, { i: f.count }, f.energy, f.motion, f.sync];
}

/** Arguments of `/hive/global`. Order and meaning: GLOBAL_FIELDS. Append only. */
export function globalArgs(g: GlobalFeatures, t: number): OscArg[] {
  return ['global', t, { i: g.count }, g.coherence, g.phaseSync, g.tempo, g.centroid, g.entropy, g.dispersion, g.leanX, g.leanY, g.onsets, g.crest];
}

/** Arguments of `/hive/cam`. Order and meaning: CAM_FIELDS. Append only. */
export function camArgs(f: VisionFrame, t: number): OscArg[] {
  return [t, { i: f.count }, { i: f.clusters.length }, f.spread, f.energy, f.cx, f.cy, f.armsUp];
}

export class OscOut {
  private readonly socket: Socket;
  private readonly startedAt = Date.now();
  private rosterTimer: NodeJS.Timeout | null = null;
  flags: OscFlags = { wide: true, perField: true, roster: true, swarm: true, global: true, cam: true, camPersons: true };
  /** Whether a camera process is attached, and its rate — repeated with the roster. */
  camStatus: { connected: boolean; fps: number } = { connected: false, fps: 0 };

  constructor(private readonly targets: Targets, private readonly registry: Registry) {
    this.socket = createSocket('udp4');
    this.socket.on('error', (err) => console.error(`[osc] socket error: ${err.message}`));
    this.socket.bind(0);
  }

  /** Seconds since the server started — the `t` of every wide message. */
  private clock(ms = Date.now()): number { return (ms - this.startedAt) / 1000; }

  start(): void {
    this.rosterTimer ??= setInterval(() => this.roster(), 1000);
  }

  // --- per sample ----------------------------------------------------------------

  sample(s: Sample): void {
    if (!this.flags.wide && !this.flags.perField) return;
    const [ax, ay, az] = s.acc;
    const [rx, ry, rz] = s.rel;
    const [gx, gy, gz] = s.gyro;
    const accMag = Math.hypot(ax, ay, az), relMag = Math.hypot(rx, ry, rz), gyroMag = Math.hypot(gx, gy, gz);
    const parts: Buffer[] = [];

    if (this.flags.wide) parts.push(encodeMessage('/hive/sample', sampleArgs(s, this.clock(s.t))));
    if (this.flags.perField) {
      const base = `/hive/dev/${s.slot}`;
      parts.push(
        encodeMessage(`${base}/acc`, [ax, ay, az]),
        encodeMessage(`${base}/rel`, [rx, ry, rz]),
        encodeMessage(`${base}/gyro`, [gx, gy, gz]),
        encodeMessage(`${base}/activity`, [s.activity]),
        encodeMessage(`${base}/mag`, [accMag, relMag, gyroMag]),
        encodeMessage(`${base}/turn`, [s.turn]),
      );
    }
    this.send(encodeBundle(parts));
  }

  // --- events ---------------------------------------------------------------------

  join(d: DeviceInfo, count: number): void {
    this.send(encodeBundle([
      encodeMessage('/hive/join', [{ i: d.slot }, d.uid, d.name, d.platform]),
      encodeMessage(`/hive/dev/${d.slot}/join`, [d.platform, { i: d.slot }]),
      encodeMessage('/hive/swarm/count', [{ i: count }]),
    ]));
  }

  leave(d: DeviceInfo, count: number): void {
    this.send(encodeBundle([
      encodeMessage('/hive/leave', [{ i: d.slot }, d.uid]),
      encodeMessage(`/hive/dev/${d.slot}/leave`, [{ i: d.slot }]),
      encodeMessage('/hive/swarm/count', [{ i: count }]),
    ]));
  }

  /** The uid of the queen, kept here so the roster can repeat it. */
  queenUid = '';

  /** `/hive/queen s uid · i slot` — '' and 0 when there is none. */
  private queenMessage(): Buffer {
    const d = this.queenUid ? this.registry.list().find((x) => x.uid === this.queenUid) : undefined;
    return encodeMessage('/hive/queen', [this.queenUid, { i: d?.slot ?? 0 }]);
  }

  queen(uid: string): void {
    this.queenUid = uid;
    this.send(this.queenMessage());
  }

  private roster(): void {
    if (!this.flags.roster) return;
    const devices = this.registry.list();
    const args: OscArg[] = [{ i: devices.length }];
    for (const d of devices) args.push({ i: d.slot }, d.uid, d.name);
    this.send(encodeBundle([
      encodeMessage('/hive/schema', [{ i: OSC_SCHEMA_VERSION }]),
      encodeMessage('/hive/roster', args),
      this.queenMessage(),
      encodeMessage('/hive/cam/status', [{ i: this.camStatus.connected ? 1 : 0 }, this.camStatus.fps]),
    ]));
  }

  global(g: GlobalFeatures): void {
    if (!this.flags.global) return;
    const parts = [encodeMessage('/hive/global', globalArgs(g, this.clock(g.t)))];
    for (const [k, v] of Object.entries(g)) {
      if (k === 't' || k === 'count') continue;
      parts.push(encodeMessage(`/hive/global/${k}`, [v as number]));
    }
    this.send(encodeBundle(parts));
  }

  cam(f: VisionFrame): void {
    if (!this.flags.cam) return;
    const parts = [
      encodeMessage('/hive/cam', camArgs(f, this.clock(f.t))),
      encodeMessage('/hive/cam/count', [{ i: f.count }]),
      encodeMessage('/hive/cam/clusters', [{ i: f.clusters.length }]),
      encodeMessage('/hive/cam/spread', [f.spread]),
      encodeMessage('/hive/cam/energy', [f.energy]),
      encodeMessage('/hive/cam/centroid', [f.cx, f.cy]),
      encodeMessage('/hive/cam/armsUp', [f.armsUp]),
    ];
    f.clusters.forEach((c, i) => parts.push(encodeMessage('/hive/cam/cluster', [{ i }, { i: c.n }, c.x, c.y, c.r])));
    if (this.flags.camPersons) {
      for (const p of f.people) parts.push(encodeMessage('/hive/cam/person', [{ i: p.id }, p.x, p.y, p.depth, p.armsUp, p.crouch, p.energy]));
    }
    this.send(encodeBundle(parts));
  }

  swarm(f: SwarmFeatures): void {
    if (!this.flags.swarm) return;
    this.send(encodeBundle([
      encodeMessage('/hive/swarm', swarmArgs(f, this.clock(f.t))),
      encodeMessage('/hive/swarm/count', [{ i: f.count }]),
      encodeMessage('/hive/swarm/energy', [f.energy]),
      encodeMessage('/hive/swarm/motion', [f.motion]),
      encodeMessage('/hive/swarm/sync', [f.sync]),
    ]));
  }

  ping(targetId: string, n: number): boolean {
    const t = this.targets.get(targetId);
    if (!t) return false;
    this.sendTo(t, encodeMessage('/hive/ping', [{ i: n }]));
    return true;
  }

  // --- transport -------------------------------------------------------------------

  private send(packet: Buffer): void {
    for (const t of this.targets.enabled()) this.sendTo(t, packet);
  }

  private sendTo(t: { host: string; port: number; sent?: number; error?: string | null }, packet: Buffer): void {
    this.socket.send(packet, t.port, t.host, (err) => {
      if (err) t.error = err.message;
      else { t.sent = (t.sent ?? 0) + 1; }
    });
  }

  close(): void {
    if (this.rosterTimer) clearInterval(this.rosterTimer);
    this.socket.close();
  }
}

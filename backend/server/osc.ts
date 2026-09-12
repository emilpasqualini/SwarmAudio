//
//  osc.ts
//  HIVE (server)
//
//  Every sample out as OSC, to every enabled target.
//
<<<<<<< HEAD
//  The messages are built from shared/osc-schema.ts — read that file (or
//  docs/OSC.md, generated from it) for what each field means. Two shapes of
//  the same data go out: a wide `/hive/sample` with everything in a fixed
//  order, and per-field `/hive/dev/<slot>/…` messages for quick patching.
//  Either can be switched off on the dashboard. One UDP socket, no
//  per-target state beyond a counter and the last error.
=======
//  One UDP socket, no per-target state beyond a counter and the last error.
//  Addresses use the slot number so a Pd patch can `route 1 2 3`. Per-sample
//  data is one bundle so acc and gyro arrive atomically.
//
//    /hive/dev/<slot>/acc    f f f     m/s²
//    /hive/dev/<slot>/gyro   f f f     °/s
//    /hive/dev/<slot>/mag    f f       |acc| |gyro|
//    /hive/dev/<slot>/join   s i       platform, slot
//    /hive/dev/<slot>/leave  i         slot
//    /hive/swarm/count       i
//    /hive/swarm/energy      f
//    /hive/swarm/motion      f
//    /hive/swarm/sync        f
//    /hive/ping              i         from the dashboard's Ping button
>>>>>>> 791460b3b24265c8bbf40de2d4abdf0497736a94
//

import { createSocket } from 'node:dgram';
import type { Socket } from 'node:dgram';
import { encodeBundle, encodeMessage } from './osc-encode';
<<<<<<< HEAD
import type { OscArg } from './osc-encode';
import type { Targets } from './targets';
import type { Registry } from './registry';
import { OSC_SCHEMA_VERSION } from '../shared/osc-schema';
import type { DeviceInfo, Sample, SwarmFeatures } from '../shared/types';

export interface OscFlags { wide: boolean; perField: boolean; roster: boolean; swarm: boolean }

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

export class OscOut {
  private readonly socket: Socket;
  private readonly startedAt = Date.now();
  private rosterTimer: NodeJS.Timeout | null = null;
  flags: OscFlags = { wide: true, perField: true, roster: true, swarm: true };

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
=======
import type { Targets } from './targets';
import type { DeviceInfo, Sample, SwarmFeatures } from '../shared/types';

export interface OscFlags { perSample: boolean; mag: boolean; swarm: boolean }

export class OscOut {
  private readonly socket: Socket;
  flags: OscFlags = { perSample: true, mag: true, swarm: true };

  constructor(private readonly targets: Targets) {
    this.socket = createSocket('udp4');
    this.socket.on('error', (err) => console.error(`[osc] socket error: ${err.message}`));
    // Unbound send would bind lazily on the first packet; do it now so errors surface at boot.
    this.socket.bind(0);
  }

  sample(s: Sample): void {
    if (!this.flags.perSample && !this.flags.mag) return;
    const [ax, ay, az] = s.acc;
    const [gx, gy, gz] = s.gyro;
    const base = `/hive/dev/${s.slot}`;
    const parts: Buffer[] = [];
    if (this.flags.perSample) {
      parts.push(encodeMessage(`${base}/acc`, [ax, ay, az]), encodeMessage(`${base}/gyro`, [gx, gy, gz]));
    }
    if (this.flags.mag) parts.push(encodeMessage(`${base}/mag`, [Math.hypot(ax, ay, az), Math.hypot(gx, gy, gz)]));
    this.send(encodeBundle(parts));
  }

  join(d: DeviceInfo, count: number): void {
    this.send(encodeBundle([
>>>>>>> 791460b3b24265c8bbf40de2d4abdf0497736a94
      encodeMessage(`/hive/dev/${d.slot}/join`, [d.platform, { i: d.slot }]),
      encodeMessage('/hive/swarm/count', [{ i: count }]),
    ]));
  }

  leave(d: DeviceInfo, count: number): void {
    this.send(encodeBundle([
<<<<<<< HEAD
      encodeMessage('/hive/leave', [{ i: d.slot }, d.uid]),
=======
>>>>>>> 791460b3b24265c8bbf40de2d4abdf0497736a94
      encodeMessage(`/hive/dev/${d.slot}/leave`, [{ i: d.slot }]),
      encodeMessage('/hive/swarm/count', [{ i: count }]),
    ]));
  }

<<<<<<< HEAD
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
    ]));
  }

  swarm(f: SwarmFeatures): void {
    if (!this.flags.swarm) return;
    this.send(encodeBundle([
      encodeMessage('/hive/swarm', swarmArgs(f, this.clock(f.t))),
=======
  swarm(f: SwarmFeatures): void {
    if (!this.flags.swarm) return;
    this.send(encodeBundle([
>>>>>>> 791460b3b24265c8bbf40de2d4abdf0497736a94
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

<<<<<<< HEAD
  // --- transport -------------------------------------------------------------------

=======
>>>>>>> 791460b3b24265c8bbf40de2d4abdf0497736a94
  private send(packet: Buffer): void {
    for (const t of this.targets.enabled()) this.sendTo(t, packet);
  }

  private sendTo(t: { host: string; port: number; sent?: number; error?: string | null }, packet: Buffer): void {
    this.socket.send(packet, t.port, t.host, (err) => {
      if (err) t.error = err.message;
      else { t.sent = (t.sent ?? 0) + 1; }
    });
  }

<<<<<<< HEAD
  close(): void {
    if (this.rosterTimer) clearInterval(this.rosterTimer);
    this.socket.close();
  }
=======
  close(): void { this.socket.close(); }
>>>>>>> 791460b3b24265c8bbf40de2d4abdf0497736a94
}

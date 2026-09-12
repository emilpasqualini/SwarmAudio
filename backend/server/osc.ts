//
//  osc.ts
//  HIVE (server)
//
//  Every sample out as OSC, to every enabled target.
//
//  One UDP socket, no per-target state beyond a counter and the last error.
//  Addresses use the slot number so a Pd patch can `route 1 2 3`. Per-sample
//  data is one bundle so acc and gyro arrive atomically.
//
//    /hive/dev/<slot>/acc      f f f   m/s², raw (gravity included)
//    /hive/dev/<slot>/rel      f f f   m/s², smoothed and relative to the adaptive zero — 0 at rest
//    /hive/dev/<slot>/gyro     f f f   °/s
//    /hive/dev/<slot>/activity f       0..1, turning or jolting
//    /hive/dev/<slot>/mag      f f f   |acc| |rel| |gyro|
//    /hive/dev/<slot>/join   s i       platform, slot
//    /hive/dev/<slot>/leave  i         slot
//    /hive/swarm/count       i
//    /hive/swarm/energy      f
//    /hive/swarm/motion      f
//    /hive/swarm/sync        f
//    /hive/ping              i         from the dashboard's Ping button
//

import { createSocket } from 'node:dgram';
import type { Socket } from 'node:dgram';
import { encodeBundle, encodeMessage } from './osc-encode';
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
    const [rx, ry, rz] = s.rel;
    const [gx, gy, gz] = s.gyro;
    const base = `/hive/dev/${s.slot}`;
    const parts: Buffer[] = [];
    if (this.flags.perSample) {
      parts.push(
        encodeMessage(`${base}/acc`, [ax, ay, az]),
        encodeMessage(`${base}/rel`, [rx, ry, rz]),
        encodeMessage(`${base}/gyro`, [gx, gy, gz]),
        encodeMessage(`${base}/activity`, [s.activity]),
      );
    }
    if (this.flags.mag) parts.push(encodeMessage(`${base}/mag`, [Math.hypot(ax, ay, az), Math.hypot(rx, ry, rz), Math.hypot(gx, gy, gz)]));
    this.send(encodeBundle(parts));
  }

  join(d: DeviceInfo, count: number): void {
    this.send(encodeBundle([
      encodeMessage(`/hive/dev/${d.slot}/join`, [d.platform, { i: d.slot }]),
      encodeMessage('/hive/swarm/count', [{ i: count }]),
    ]));
  }

  leave(d: DeviceInfo, count: number): void {
    this.send(encodeBundle([
      encodeMessage(`/hive/dev/${d.slot}/leave`, [{ i: d.slot }]),
      encodeMessage('/hive/swarm/count', [{ i: count }]),
    ]));
  }

  swarm(f: SwarmFeatures): void {
    if (!this.flags.swarm) return;
    this.send(encodeBundle([
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

  private send(packet: Buffer): void {
    for (const t of this.targets.enabled()) this.sendTo(t, packet);
  }

  private sendTo(t: { host: string; port: number; sent?: number; error?: string | null }, packet: Buffer): void {
    this.socket.send(packet, t.port, t.host, (err) => {
      if (err) t.error = err.message;
      else { t.sent = (t.sent ?? 0) + 1; }
    });
  }

  close(): void { this.socket.close(); }
}

//
//  registry.ts
//  HIVE (server)
//
//  Who is in the swarm, and the one place every sample passes through.
//
//  A device joins on its first frame and is given the lowest free slot; it
//  leaves when its socket closes or when it has been silent for a few seconds
//  (the POST fallback has no socket to close). Consumers — OSC, the swarm
//  features, the raw feed, the dashboard — subscribe here and never learn
//  about transports. This is the `SwarmSource` seam: a replayed dataset would
//  call `push` the same way a phone does.
//

import type { DecodedFrame } from '../shared/protocol';
import type { DeviceInfo, Platform, Sample, Transport } from '../shared/types';

export interface RegistryEvents {
  join: (device: DeviceInfo) => void;
  leave: (device: DeviceInfo) => void;
  sample: (sample: Sample, device: DeviceInfo) => void;
}

interface Device extends DeviceInfo {
  /** Recent inter-sample interval, EWMA in ms, for the Hz readout. */
  interval: number;
}

export class Registry {
  private readonly devices = new Map<string, Device>();
  private readonly bySlot = new Map<number, Device>();
  private readonly listeners: { [K in keyof RegistryEvents]: RegistryEvents[K][] } = { join: [], leave: [], sample: [] };
  private sweeper: NodeJS.Timeout | null = null;

  constructor(private readonly timeoutMs: number) {}

  on<K extends keyof RegistryEvents>(event: K, fn: RegistryEvents[K]): void {
    this.listeners[event].push(fn);
  }

  start(): void {
    this.sweeper ??= setInterval(() => this.sweep(), Math.max(250, this.timeoutMs / 4));
  }

  stop(): void {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
  }

  list(): DeviceInfo[] {
    return [...this.bySlot.values()].sort((a, b) => a.slot - b.slot);
  }

  get count(): number { return this.devices.size; }

  /** Ingest a decoded frame. Joins the device if new. */
  push(id: string, name: string, transport: Transport, frame: DecodedFrame, now = Date.now()): void {
    let device = this.devices.get(id);
    if (!device) device = this.join(id, name, frame.platform, transport, now);
    else if (device.transport !== transport) device.transport = transport;

    const n = frame.samples.length;
    if (n === 0) { device.lastSeen = now; return; }

    // Back-date each sample by its distance to the batch's last one, so that
    // `t` approximates when the phone measured it rather than when the batch
    // landed. Client and server clocks are not compared — only differences.
    const last = frame.samples[n - 1]!;
    for (let i = 0; i < n; i++) {
      const s = frame.samples[i]!;
      const sample: Sample = {
        slot: device.slot,
        t: now - (last.tClient - s.tClient),
        tClient: s.tClient,
        acc: s.acc,
        gyro: s.gyro,
      };
      if (device.last) {
        const dt = s.tClient - device.last.tClient;
        if (dt > 0 && dt < 1000) device.interval = device.interval ? device.interval * 0.9 + dt * 0.1 : dt;
      }
      device.last = sample;
      for (const fn of this.listeners.sample) fn(sample, device);
    }
    device.lastSeen = now;
    device.hz = device.interval > 0 ? 1000 / device.interval : 0;
  }

  /** Explicit leave (socket closed). */
  remove(id: string): void {
    const device = this.devices.get(id);
    if (!device) return;
    this.devices.delete(id);
    this.bySlot.delete(device.slot);
    for (const fn of this.listeners.leave) fn(device);
  }

  private join(id: string, name: string, platform: Platform, transport: Transport, now: number): Device {
    let slot = 1;
    while (this.bySlot.has(slot)) slot++;
    const device: Device = {
      id, slot, name, platform, transport,
      hz: 0, interval: 0, joinedAt: now, lastSeen: now, last: null,
    };
    this.devices.set(id, device);
    this.bySlot.set(slot, device);
    for (const fn of this.listeners.join) fn(device);
    return device;
  }

  private sweep(): void {
    const cutoff = Date.now() - this.timeoutMs;
    for (const device of this.devices.values()) {
      if (device.lastSeen < cutoff) this.remove(device.id);
    }
  }
}

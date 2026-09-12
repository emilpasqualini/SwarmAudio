//
//  tones.ts
//  HIVE (client, dashboard)
//
//  Debug sound: one sine per phone, right here on the Mac.
//
//  Not the installation — that is Pd's job — but the quickest proof that the
//  whole chain works: if tilting a phone bends a tone, the sensor is read, the
//  frame crossed the network, the server decoded it and the feed carries it.
//  Each slot has its own note from a pentatonic ladder so several phones stay
//  tellable apart; tilt bends the pitch, turning speed opens the volume, and
//  left/right tilt pans.
//

import type { FeedMessage } from '../../shared/types';

const G = 9.81;
// Pentatonic over two octaves from A3; slot n takes step (n − 1) mod 10.
const LADDER = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21].map((semi) => 220 * 2 ** (semi / 12));

interface Voice {
  osc: OscillatorNode;
  gain: GainNode;
  pan: StereoPannerNode;
  base: number;
}

export class Tones {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private readonly voices = new Map<number, Voice>();
  private volume = 0.5;

  get running(): boolean { return this.ctx !== null; }

  /** Must be called from a click: browsers only start audio on a gesture. */
  async start(): Promise<void> {
    if (this.ctx) return;
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    this.master = this.ctx.createGain();
    this.master.gain.value = this.volume;
    this.master.connect(this.ctx.destination);
    await this.ctx.resume();
  }

  stop(): void {
    for (const slot of [...this.voices.keys()]) this.remove(slot);
    void this.ctx?.close();
    this.ctx = null;
    this.master = null;
  }

  setVolume(v: number): void {
    this.volume = v;
    this.master?.gain.setTargetAtTime(v, this.ctx?.currentTime ?? 0, 0.02);
  }

  handle(msg: FeedMessage): void {
    if (!this.ctx) return;
    if (msg.type === 'join') this.ensure(msg.slot);
    else if (msg.type === 'leave') this.remove(msg.slot);
    else if (msg.type === 'sample') this.update(msg.slot, msg.acc, msg.gyro);
  }

  private ensure(slot: number): Voice {
    let v = this.voices.get(slot);
    if (v || !this.ctx || !this.master) return v!;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    const pan = this.ctx.createStereoPanner();
    const base = LADDER[(slot - 1) % LADDER.length]! * (1 + Math.floor((slot - 1) / LADDER.length));
    osc.type = 'sine';
    osc.frequency.value = base;
    gain.gain.value = 0;
    osc.connect(gain).connect(pan).connect(this.master);
    osc.start();
    v = { osc, gain, pan, base };
    this.voices.set(slot, v);
    return v;
  }

  private remove(slot: number): void {
    const v = this.voices.get(slot);
    if (!v || !this.ctx) return;
    const now = this.ctx.currentTime;
    v.gain.gain.setTargetAtTime(0, now, 0.05);
    v.osc.stop(now + 0.3);
    this.voices.delete(slot);
  }

  private update(slot: number, acc: [number, number, number], gyro: [number, number, number]): void {
    const v = this.ensure(slot);
    if (!v || !this.ctx) return;
    const now = this.ctx.currentTime;
    const [ax, ay] = acc;
    // Tilt forward/back (y) bends the pitch up to a fifth either way.
    const tilt = Math.max(-1, Math.min(1, ay / G));
    v.osc.frequency.setTargetAtTime(v.base * 2 ** (tilt * 7 / 12), now, 0.03);
    // Turning opens the tone: still phones hum quietly, moving ones sing.
    const turn = Math.min(1, Math.hypot(...gyro) / 250);
    v.gain.gain.setTargetAtTime(0.08 + 0.5 * turn, now, 0.04);
    v.pan.pan.setTargetAtTime(Math.max(-1, Math.min(1, ax / G)), now, 0.05);
  }
}

//
//  protocol.ts
//  HIVE (shared)
//
//  The binary frame a phone sends, and how to read it back.
//
//  Little-endian, one frame per batch:
//
//    u8   version   = 1
//    u8   flags     bit 0: acc is linear (gravity removed) rather than including gravity
//    u8   n         sample count
//    u8   platform  see PLATFORM_CODE
//    f64  t0        client epoch ms of the first sample
//    n × 7 × f32    [dt ms since t0, ax, ay, az, gx, gy, gz]
//
//  12 + 28·n bytes. Three samples — about 50 ms at 60 Hz — are 96 bytes. The
//  frame is the same over WebSocket and over the POST fallback; only the
//  envelope differs. Device identity is carried out of band (query string or
//  URL path) so the hot path never re-sends a UUID.
//

import { PLATFORM_CODE, PLATFORM_FROM_CODE } from './types';
import type { Platform } from './types';

export const PROTOCOL_VERSION = 1;
export const HEADER_BYTES = 12;
export const SAMPLE_FLOATS = 7;
export const SAMPLE_BYTES = SAMPLE_FLOATS * 4;
export const MAX_SAMPLES = 255;

export const FLAG_LINEAR_ACC = 1 << 0;

export interface DecodedSample {
  /** Client epoch ms. */
  tClient: number;
  acc: [number, number, number];
  gyro: [number, number, number];
}

export interface DecodedFrame {
  platform: Platform;
  linearAcc: boolean;
  samples: DecodedSample[];
}

/**
 * Accumulates samples and hands out a finished frame. One instance per phone;
 * `push` is called from the devicemotion handler, `take` when the batch is
 * due. Allocation-free on the hot path: the buffer is reused until `take`
 * copies out the exact number of bytes.
 */
export class FrameBuilder {
  private readonly buffer: ArrayBuffer;
  private readonly view: DataView;
  private readonly floats: Float32Array;
  private count = 0;
  private t0 = 0;

  constructor(
    private readonly platform: Platform,
    private readonly linearAcc = false,
    readonly capacity = 16,
  ) {
    this.buffer = new ArrayBuffer(HEADER_BYTES + capacity * SAMPLE_BYTES);
    this.view = new DataView(this.buffer);
    this.floats = new Float32Array(this.buffer, HEADER_BYTES, capacity * SAMPLE_FLOATS);
  }

  get length(): number { return this.count; }
  get full(): boolean { return this.count >= this.capacity; }

  push(tClient: number, ax: number, ay: number, az: number, gx: number, gy: number, gz: number): void {
    if (this.count >= this.capacity) return; // caller should have flushed; drop rather than grow
    if (this.count === 0) this.t0 = tClient;
    const o = this.count * SAMPLE_FLOATS;
    this.floats[o] = tClient - this.t0;
    this.floats[o + 1] = ax; this.floats[o + 2] = ay; this.floats[o + 3] = az;
    this.floats[o + 4] = gx; this.floats[o + 5] = gy; this.floats[o + 6] = gz;
    this.count++;
  }

  /** Returns the encoded frame and resets, or null if empty. */
  take(): Uint8Array<ArrayBuffer> | null {
    if (this.count === 0) return null;
    this.view.setUint8(0, PROTOCOL_VERSION);
    this.view.setUint8(1, this.linearAcc ? FLAG_LINEAR_ACC : 0);
    this.view.setUint8(2, this.count);
    this.view.setUint8(3, PLATFORM_CODE[this.platform]);
    this.view.setFloat64(4, this.t0, true);
    const bytes = HEADER_BYTES + this.count * SAMPLE_BYTES;
    // Float32Array writes above are native-endian; the header says little-endian.
    // Every phone and Mac we can meet is little-endian, but be honest about it.
    if (!LITTLE_ENDIAN) swapFloats(this.floats, this.count * SAMPLE_FLOATS);
    const out = new Uint8Array(this.buffer.slice(0, bytes) as ArrayBuffer);
    this.count = 0;
    return out;
  }
}

const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

function swapFloats(floats: Float32Array, n: number): void {
  const bytes = new Uint8Array(floats.buffer, floats.byteOffset, n * 4);
  for (let i = 0; i < bytes.length; i += 4) {
    const a = bytes[i]!, b = bytes[i + 1]!;
    bytes[i] = bytes[i + 3]!; bytes[i + 1] = bytes[i + 2]!;
    bytes[i + 2] = b; bytes[i + 3] = a;
  }
}

/** Throws on a malformed frame; the caller decides whether to drop the sender. */
export function decodeFrame(data: ArrayBufferLike | Uint8Array): DecodedFrame {
  const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (u8.byteLength < HEADER_BYTES) throw new Error(`frame too short: ${u8.byteLength} bytes`);
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const version = view.getUint8(0);
  if (version !== PROTOCOL_VERSION) throw new Error(`unknown protocol version ${version}`);
  const flags = view.getUint8(1);
  const n = view.getUint8(2);
  const platform = PLATFORM_FROM_CODE[view.getUint8(3)] ?? 'unknown';
  const t0 = view.getFloat64(4, true);
  const expected = HEADER_BYTES + n * SAMPLE_BYTES;
  if (u8.byteLength !== expected) throw new Error(`frame length ${u8.byteLength}, expected ${expected} for ${n} samples`);

  const samples: DecodedSample[] = new Array(n);
  let o = HEADER_BYTES;
  for (let i = 0; i < n; i++, o += SAMPLE_BYTES) {
    samples[i] = {
      tClient: t0 + view.getFloat32(o, true),
      acc: [view.getFloat32(o + 4, true), view.getFloat32(o + 8, true), view.getFloat32(o + 12, true)],
      gyro: [view.getFloat32(o + 16, true), view.getFloat32(o + 20, true), view.getFloat32(o + 24, true)],
    };
  }
  return { platform, linearAcc: (flags & FLAG_LINEAR_ACC) !== 0, samples };
}

// Round-trip self-test for the binary frame. `npm run protocol:test`.
import assert from 'node:assert/strict';
import { FrameBuilder, decodeFrame, HEADER_BYTES, SAMPLE_BYTES } from './protocol';

const b = new FrameBuilder('ios', false, 4);
assert.equal(b.take(), null);
const t0 = 1_757_674_000_000.5;
b.push(t0, 0.1, -0.2, 9.81, 10, 20, -30);
b.push(t0 + 16.67, 0.3, 0.4, 9.7, -1, -2, -3);
b.push(t0 + 33.33, 0, 0, 0, 0, 0, 0);
const frame = b.take()!;
assert.equal(frame.byteLength, HEADER_BYTES + 3 * SAMPLE_BYTES);
assert.equal(b.length, 0);

const d = decodeFrame(frame);
assert.equal(d.platform, 'ios');
assert.equal(d.linearAcc, false);
assert.equal(d.samples.length, 3);
const s0 = d.samples[0]!, s1 = d.samples[1]!;
assert.ok(Math.abs(s0.tClient - t0) < 0.01);
assert.ok(Math.abs(s1.tClient - (t0 + 16.67)) < 0.01);
assert.ok(Math.abs(s0.acc[2] - 9.81) < 1e-5);
assert.ok(Math.abs(s0.gyro[2] + 30) < 1e-5);
assert.ok(Math.abs(s1.gyro[0] + 1) < 1e-5);

// capacity: the fifth push is dropped, not grown
for (let i = 0; i < 6; i++) b.push(t0 + i, 1, 1, 1, 1, 1, 1);
assert.equal(b.length, 4);
assert.ok(b.full);
b.take();

// malformed frames are rejected loudly
assert.throws(() => decodeFrame(new Uint8Array(5)));
assert.throws(() => decodeFrame(frame.subarray(0, frame.byteLength - 1)));
const bad = new Uint8Array(frame); bad[0] = 9;
assert.throws(() => decodeFrame(bad));

console.log('protocol round-trip ok');

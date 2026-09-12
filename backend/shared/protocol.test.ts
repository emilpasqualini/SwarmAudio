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

// The wide OSC messages must match the schema they are documented by.
import { CAM_FIELDS, GLOBAL_FIELDS, SAMPLE_FIELDS, SWARM_FIELDS, typeTags } from './osc-schema';
import { camArgs, globalArgs, sampleArgs, swarmArgs } from '../server/osc';
import { decodePacket, encodeMessage } from '../server/osc-encode';
const tagOf = (a: unknown): string => typeof a === 'string' ? 's' : typeof a === 'number' ? 'f' : 'i';
const sample = { slot: 3, uid: 'abcd1234', t: 0, tClient: 0, acc: [0, 0, 9.81] as [number, number, number], gyro: [1, 2, 3] as [number, number, number], rel: [0, 0, 0] as [number, number, number], activity: 0.1, idle: 2, turn: 0 };
assert.equal(sampleArgs(sample, 1.5).map(tagOf).join(''), typeTags(SAMPLE_FIELDS), '/hive/sample args must match SAMPLE_FIELDS');
assert.equal(swarmArgs({ t: 0, count: 2, energy: 0.1, motion: 5, sync: 0.9 }, 1).map(tagOf).join(''), typeTags(SWARM_FIELDS), '/hive/swarm args must match SWARM_FIELDS');
assert.equal(globalArgs({ t: 0, count: 2, coherence: 0, phaseSync: 0, tempo: 0, centroid: 0, entropy: 0, dispersion: 0, leanX: 0, leanY: 0, onsets: 0, crest: 0 }, 1).map(tagOf).join(''), typeTags(GLOBAL_FIELDS), '/hive/global args must match GLOBAL_FIELDS');
assert.equal(camArgs({ t: 0, fps: 25, count: 1, clusters: [], people: [], spread: 0, energy: 0, cx: 0.5, cy: 0.5, armsUp: 0 }, 1).map(tagOf).join(''), typeTags(CAM_FIELDS), '/hive/cam args must match CAM_FIELDS');
const [wide] = decodePacket(encodeMessage('/hive/sample', sampleArgs(sample, 1.5)));
assert.equal(wide!.args.length, SAMPLE_FIELDS.length);
assert.equal(wide!.args[1], 'abcd1234');
assert.ok(Math.abs((wide!.args[5] as number) - 9.81) < 1e-5);

console.log('protocol round-trip ok · osc schema matches');

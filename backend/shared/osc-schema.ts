//
//  osc-schema.ts
//  HIVE (shared)
//
//  The OSC protocol, as data.
//
//  This file is the single source of truth: the server builds every message
//  from these tables, `npm run docs:osc` renders docs/OSC.md from them, and
//  the dashboard shows them. Change the protocol here and nowhere else.
//
//  Rule for the wide messages: fields are only ever APPENDED. A patch built
//  against version 1 keeps working when version 2 adds columns at the end.
//

export const OSC_SCHEMA_VERSION = 2;

export type OscType = 'i' | 'f' | 's';

export interface Field {
  name: string;
  type: OscType;
  unit: string;
  description: string;
}

/** `/hive/sample` — one message per sensor sample of one phone, in this order. */
export const SAMPLE_FIELDS: Field[] = [
  { name: 'slot',     type: 'i', unit: '',     description: 'Session-local device number 1..N; freed when the phone leaves, reused by the next joiner. Convenient for route/select.' },
  { name: 'uid',      type: 's', unit: '',     description: 'Stable 8-character id of the phone; survives reconnects and server restarts. Use this when identity matters.' },
  { name: 't',        type: 'f', unit: 's',    description: 'Seconds since the server started (float32 — enough resolution for a day).' },
  { name: 'acc_x',    type: 'f', unit: 'm/s²', description: 'Raw acceleration including gravity, x (phone right). Flat phone ≈ 0.' },
  { name: 'acc_y',    type: 'f', unit: 'm/s²', description: 'Raw acceleration including gravity, y (phone top). Flat phone ≈ 0.' },
  { name: 'acc_z',    type: 'f', unit: 'm/s²', description: 'Raw acceleration including gravity, z (out of the screen). Flat phone ≈ +9.81 on iOS and Android alike.' },
  { name: 'rel_x',    type: 'f', unit: 'm/s²', description: 'One-Euro-smoothed acceleration relative to the adaptive zero, x. Settles to 0 when the phone rests, at any angle.' },
  { name: 'rel_y',    type: 'f', unit: 'm/s²', description: 'Same, y.' },
  { name: 'rel_z',    type: 'f', unit: 'm/s²', description: 'Same, z.' },
  { name: 'gyro_x',   type: 'f', unit: '°/s',  description: 'Rotation rate about x (pitch).' },
  { name: 'gyro_y',   type: 'f', unit: '°/s',  description: 'Rotation rate about y (roll).' },
  { name: 'gyro_z',   type: 'f', unit: '°/s',  description: 'Rotation rate about z (yaw).' },
  { name: 'activity', type: 'f', unit: '0..1', description: 'How much the phone is turning or being jolted right now, smoothed (~0.25 s). 0 at rest.' },
  { name: 'idle',     type: 'f', unit: 's',    description: 'How long the phone has been at rest. 0 while active.' },
  { name: 'acc_mag',  type: 'f', unit: 'm/s²', description: '|acc|. ≈ 9.81 when only gravity acts; deviates when shaken.' },
  { name: 'rel_mag',  type: 'f', unit: 'm/s²', description: '|rel|. How far from the resting position, regardless of direction.' },
  { name: 'gyro_mag', type: 'f', unit: '°/s',  description: '|gyro|. How fast the phone turns, regardless of axis.' },
  // --- v2 ---
  { name: 'turn',     type: 'f', unit: '°/s',  description: 'Rotation about the vertical (gravity) axis, however the phone is held: turning around yourself. Positive = counter-clockwise seen from above.' },
];

/** `/hive/swarm` — the whole swarm, at the configured swarm rate. */
export const SWARM_FIELDS: Field[] = [
  { name: 't',      type: 'f', unit: 's',    description: 'Seconds since the server started.' },
  { name: 'count',  type: 'i', unit: '',     description: 'Phones currently streaming.' },
  { name: 'energy', type: 'f', unit: 'm/s²', description: 'Mean |acc − g| over phones: how hard the swarm moves.' },
  { name: 'motion', type: 'f', unit: '°/s',  description: 'Mean |gyro| over phones: how much it turns.' },
  { name: 'sync',   type: 'f', unit: '0..1', description: '1 when all phones turn equally hard, → 0 when one moves and the rest are still.' },
];

/** Events and housekeeping, with their argument lists. */
export interface MessageDoc {
  address: string;
  args: string;
  when: string;
  description: string;
}

export const EVENT_MESSAGES: MessageDoc[] = [
  { address: '/hive/join',   args: 'i slot · s uid · s name · s platform', when: 'a phone joins',      description: 'platform is ios, android, other (fake phones) or unknown. name may be empty.' },
  { address: '/hive/leave',  args: 'i slot · s uid',                        when: 'a phone leaves',     description: 'Sent on an explicit leave or after the device timeout.' },
  { address: '/hive/roster', args: 'i count · (i slot · s uid · s name)…',  when: 'every second',       description: 'Everyone currently in the swarm, so a receiver started late still learns the names.' },
  { address: '/hive/schema', args: 'i version',                             when: 'every second',       description: `Protocol version, currently ${OSC_SCHEMA_VERSION}. Wide messages only append fields between versions.` },
  { address: '/hive/ping',   args: 'i n',                                   when: 'dashboard Ping',     description: 'For checking that a target receives anything at all.' },
];

/** Per-field addresses — the same data as /hive/sample, one small message each. */
export const PER_FIELD_MESSAGES: MessageDoc[] = [
  { address: '/hive/dev/<slot>/acc',      args: 'f x · f y · f z', when: 'every sample', description: 'Raw acceleration, gravity included.' },
  { address: '/hive/dev/<slot>/rel',      args: 'f x · f y · f z', when: 'every sample', description: 'Relative to the adaptive zero.' },
  { address: '/hive/dev/<slot>/gyro',     args: 'f x · f y · f z', when: 'every sample', description: 'Rotation rate.' },
  { address: '/hive/dev/<slot>/activity', args: 'f a',             when: 'every sample', description: '0..1.' },
  { address: '/hive/dev/<slot>/mag',      args: 'f |acc| · f |rel| · f |gyro|', when: 'every sample', description: 'Magnitudes.' },
  { address: '/hive/dev/<slot>/turn',     args: 'f turn',          when: 'every sample', description: 'Rotation about the vertical, °/s (v2).' },
  { address: '/hive/dev/<slot>/join',     args: 's platform · i slot', when: 'join',    description: 'Slot-addressed twin of /hive/join.' },
  { address: '/hive/dev/<slot>/leave',    args: 'i slot',          when: 'leave',        description: 'Slot-addressed twin of /hive/leave.' },
  { address: '/hive/swarm/count',         args: 'i',               when: 'swarm rate',   description: 'Twin of the count field.' },
  { address: '/hive/swarm/energy',        args: 'f',               when: 'swarm rate',   description: 'Twin of the energy field.' },
  { address: '/hive/swarm/motion',        args: 'f',               when: 'swarm rate',   description: 'Twin of the motion field.' },
  { address: '/hive/swarm/sync',          args: 'f',               when: 'swarm rate',   description: 'Twin of the sync field.' },
];

/** OSC type-tag string of a wide message, e.g. "isfffffffffffffff". */
export const typeTags = (fields: Field[]): string => fields.map((f) => f.type).join('');

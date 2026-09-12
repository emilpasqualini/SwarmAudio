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

export const OSC_SCHEMA_VERSION = 3;

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
  // --- v3 ---
  { name: 'queen',    type: 'i', unit: '0/1',  description: '1 if this phone is the queen right now — the same information as /hive/queen, but on every sample so a patch needs no bookkeeping.' },
];

/** `/hive/swarm` — the whole swarm, at the configured swarm rate. */
export const SWARM_FIELDS: Field[] = [
  { name: 't',      type: 'f', unit: 's',    description: 'Seconds since the server started.' },
  { name: 'count',  type: 'i', unit: '',     description: 'Phones currently streaming.' },
  { name: 'energy', type: 'f', unit: 'm/s²', description: 'Mean |acc − g| over phones: how hard the swarm moves.' },
  { name: 'motion', type: 'f', unit: '°/s',  description: 'Mean |gyro| over phones: how much it turns.' },
  { name: 'sync',   type: 'f', unit: '0..1', description: '1 when all phones turn equally hard, → 0 when one moves and the rest are still.' },
];

/** `/hive/global` — swarm meta-parameters, signal-processing style, at the swarm rate (v3). */
export const GLOBAL_FIELDS: Field[] = [
  { name: 'id',         type: 's', unit: '',     description: 'Always "global" — so a patch can route on the first argument like it does on slot/uid.' },
  { name: 't',          type: 'f', unit: 's',    description: 'Seconds since the server started.' },
  { name: 'count',      type: 'i', unit: '',     description: 'Phones the features were computed over.' },
  { name: 'coherence',  type: 'f', unit: '−1..1', description: 'Mean pairwise correlation of the phones\' rel vectors over the last second. 1 = everyone moves alike, 0 = unrelated, negative = counter-movement.' },
  { name: 'phaseSync',  type: 'f', unit: '0..1', description: 'Kuramoto order parameter of the movement phase (from the sign changes of rel_y). 1 = in step, 0 = phases all over the place.' },
  { name: 'tempo',      type: 'f', unit: 'Hz',   description: 'Dominant movement frequency of the whole swarm, by autocorrelation of the summed |rel| over 4 s (0.5–6 Hz; walking ≈ 2). 0 when still.' },
  { name: 'centroid',   type: 'f', unit: 'Hz',   description: 'Spectral centroid of the swarm\'s energy (128-point FFT over ~2 s). Low = slow sways, high = jitter.' },
  { name: 'entropy',    type: 'f', unit: '0..1', description: 'Normalised Shannon entropy of activity across phones. 1 = everyone equally active, 0 = one soloist.' },
  { name: 'dispersion', type: 'f', unit: 'm/s²', description: 'Standard deviation of rel across phones — how different the tilts are right now.' },
  { name: 'leanX',      type: 'f', unit: 'm/s²', description: 'Mean rel_x over phones: where the swarm leans, left/right.' },
  { name: 'leanY',      type: 'f', unit: 'm/s²', description: 'Mean rel_y over phones: where the swarm leans, forward/back.' },
  { name: 'onsets',     type: 'f', unit: '1/s',  description: 'Activity onsets (rest → moving) per second across the swarm, over the last 2 s. Bursts.' },
  { name: 'crest',      type: 'f', unit: '',     description: 'Peak / RMS of the swarm energy over 2 s. ≈1 steady, high = spiky.' },
];

/** `/hive/cam` — the room as the camera sees it (backend/vision), per processed frame (v3). */
export const CAM_FIELDS: Field[] = [
  { name: 't',        type: 'f', unit: 's',    description: 'Seconds since the server started.' },
  { name: 'count',    type: 'i', unit: '',     description: 'People in view.' },
  { name: 'clusters', type: 'i', unit: '',     description: 'Groups of people closer than the cluster radius (dashboard).' },
  { name: 'spread',   type: 'f', unit: '0..1', description: 'Mean pairwise distance between people, in frame widths. 0 when fewer than two.' },
  { name: 'energy',   type: 'f', unit: '0..1', description: 'Mean movement speed of people in the frame, smoothed.' },
  { name: 'cx',       type: 'f', unit: '0..1', description: 'Centroid of everyone, left→right.' },
  { name: 'cy',       type: 'f', unit: '0..1', description: 'Centroid of everyone, top→bottom.' },
  { name: 'armsUp',   type: 'f', unit: '0..2', description: 'Mean number of raised arms per person.' },
  // --- how the crowd moves, from frame to frame (computed on the server) ---
  { name: 'flowX',    type: 'f', unit: '1/s',  description: 'Mean velocity of everyone, left→right, in frame widths per second. Where the crowd drifts.' },
  { name: 'flowY',    type: 'f', unit: '1/s',  description: 'Mean velocity, top→bottom.' },
  { name: 'turbulence', type: 'f', unit: '1/s', description: 'Spread of the velocities around the mean flow. 0 = everyone drifts together, high = milling about.' },
  { name: 'moveSync', type: 'f', unit: '−1..1', description: 'Mean pairwise cosine similarity of velocities: 1 = moving the same way, −1 = toward/away from each other, 0 = unrelated. Only counts people who move.' },
  { name: 'converge', type: 'f', unit: '1/s',  description: 'Rate of change of spread, smoothed. Negative = people are coming together, positive = dispersing.' },
  { name: 'nearest',  type: 'f', unit: '0..1', description: 'Mean distance to one\'s nearest neighbour, in frame widths. Small = close contact.' },
  { name: 'stillness', type: 'f', unit: '0..1', description: 'Fraction of people who are standing still.' },
  { name: 'occupancy', type: 'f', unit: '0..1', description: 'Fraction of a 4×3 grid over the picture that has someone in it — how much of the room is in use.' },
];

/** `/hive/mix` — where the bees on the wall and the people the camera sees meet (v3). */
export const MIX_FIELDS: Field[] = [
  { name: 't',            type: 'f', unit: 's',    description: 'Seconds since the server started.' },
  { name: 'bees',         type: 'i', unit: '',     description: 'Bees on the wall (phones in the swarm).' },
  { name: 'people',       type: 'i', unit: '',     description: 'People the camera sees.' },
  { name: 'distance',     type: 'f', unit: '0..1', description: 'Distance between the bees\' centroid and the crowd\'s centroid (both 0..1 across their picture). 0 = the swarm hovers over the crowd.' },
  { name: 'beesInCrowd',  type: 'f', unit: '0..1', description: 'Fraction of bees flying inside one of the camera\'s groups (cluster circle, plus a margin).' },
  { name: 'queenInCrowd', type: 'i', unit: '0/1',  description: '1 when the queen bee is inside a group.' },
  { name: 'covered',      type: 'f', unit: '0..1', description: 'Fraction of people who have a bee within 0.1 of them — how much of the crowd the swarm "touches".' },
  { name: 'alignment',    type: 'f', unit: '−1..1', description: 'Cosine between the bees\' mean heading and the crowd\'s flow. 1 = swarm and crowd move the same way.' },
  { name: 'balance',      type: 'f', unit: '0..1', description: 'bees / (bees + people): 0.5 = as many phones as bodies, 1 = only phones, 0 = only bodies.' },
];

/**
 * Every small message that can be muted on its own (dashboard: osc parameters).
 * The key is the address without the /hive/ prefix and without the slot; the wide
 * messages are governed by their family switches instead.
 */
export const MUTABLE: { family: string; key: string }[] = [
  ...['acc', 'rel', 'gyro', 'activity', 'mag', 'turn', 'queen'].map((k) => ({ family: 'dev', key: `dev/${k}` })),
  ...['count', 'energy', 'motion', 'sync'].map((k) => ({ family: 'swarm', key: `swarm/${k}` })),
  ...['coherence', 'phaseSync', 'tempo', 'centroid', 'entropy', 'dispersion', 'leanX', 'leanY', 'onsets', 'crest'].map((k) => ({ family: 'global', key: `global/${k}` })),
  ...['count', 'clusters', 'spread', 'energy', 'centroid', 'armsUp', 'flow', 'turbulence', 'moveSync', 'converge', 'nearest', 'stillness', 'occupancy', 'cluster', 'person', 'status'].map((k) => ({ family: 'cam', key: `cam/${k}` })),
  ...['distance', 'beesInCrowd', 'queenInCrowd', 'covered', 'alignment', 'balance'].map((k) => ({ family: 'mix', key: `mix/${k}` })),
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
  { address: '/hive/queen',  args: 's uid · i slot',                        when: 'the crown moves, and every second', description: 'Who the queen bee is (v2). uid "" and slot 0 when there is none. She is crowned by hand on the dashboard, by moving most while the throne is vacant, or by another bee flying into her on the wall.' },
  { address: '/hive/schema', args: 'i version',                             when: 'every second',       description: `Protocol version, currently ${OSC_SCHEMA_VERSION}. Wide messages only append fields between versions.` },
  { address: '/hive/ping',   args: 'i n',                                   when: 'dashboard Ping',     description: 'For checking that a target receives anything at all.' },
];

/** Camera messages besides the wide /hive/cam. */
export const CAM_MESSAGES: MessageDoc[] = [
  { address: '/hive/cam/<field>', args: 'i / f',                                                              when: 'every camera frame',              description: 'Twins of the wide fields, one each (count, clusters, spread, energy, armsUp, turbulence, moveSync, converge, nearest, stillness, occupancy) — handy for REAPER\'s Learn.' },
  { address: '/hive/cam/centroid', args: 'f x · f y',                                                          when: 'every camera frame',              description: 'Where everyone is on average.' },
  { address: '/hive/cam/flow',     args: 'f x · f y',                                                          when: 'every camera frame',              description: 'Where the crowd drifts, frame widths per second.' },
  { address: '/hive/cam/cluster', args: 'i index · i n · f x · f y · f r',                                     when: 'every camera frame, per cluster', description: 'x, y centre and r radius in frame widths; n people in it. Index 0..clusters−1.' },
  { address: '/hive/cam/person',  args: 'i id · f x · f y · f depth · f armsUp · f crouch · f energy',        when: 'every camera frame, per person (switchable)', description: 'id is the tracker\'s, stable while the person stays in view — not a phone, never matched to one. depth = box height / frame height (closer = bigger). armsUp 0..2 wrists above shoulders, crouch 0..1.' },
  { address: '/hive/cam/status',  args: 'i connected · f fps',                                                   when: 'every second',                    description: 'Whether the camera process is attached and how fast it runs.' },
];

/** Per-field addresses — the same data as /hive/sample, one small message each. */
export const PER_FIELD_MESSAGES: MessageDoc[] = [
  { address: '/hive/dev/<slot>/acc',      args: 'f x · f y · f z', when: 'every sample', description: 'Raw acceleration, gravity included.' },
  { address: '/hive/dev/<slot>/rel',      args: 'f x · f y · f z', when: 'every sample', description: 'Relative to the adaptive zero.' },
  { address: '/hive/dev/<slot>/gyro',     args: 'f x · f y · f z', when: 'every sample', description: 'Rotation rate.' },
  { address: '/hive/dev/<slot>/activity', args: 'f a',             when: 'every sample', description: '0..1.' },
  { address: '/hive/dev/<slot>/mag',      args: 'f |acc| · f |rel| · f |gyro|', when: 'every sample', description: 'Magnitudes.' },
  { address: '/hive/dev/<slot>/turn',     args: 'f turn',          when: 'every sample', description: 'Rotation about the vertical, °/s (v2).' },
  { address: '/hive/dev/<slot>/queen',    args: 'i queen',         when: 'every sample', description: '1 while this slot holds the crown, else 0 (v3).' },
  { address: '/hive/dev/<slot>/join',     args: 's platform · i slot', when: 'join',    description: 'Slot-addressed twin of /hive/join.' },
  { address: '/hive/dev/<slot>/leave',    args: 'i slot',          when: 'leave',        description: 'Slot-addressed twin of /hive/leave.' },
  { address: '/hive/swarm/count',         args: 'i',               when: 'swarm rate',   description: 'Twin of the count field.' },
  { address: '/hive/swarm/energy',        args: 'f',               when: 'swarm rate',   description: 'Twin of the energy field.' },
  { address: '/hive/swarm/motion',        args: 'f',               when: 'swarm rate',   description: 'Twin of the motion field.' },
  { address: '/hive/swarm/sync',          args: 'f',               when: 'swarm rate',   description: 'Twin of the sync field.' },
];

/** OSC type-tag string of a wide message, e.g. "isfffffffffffffff". */
export const typeTags = (fields: Field[]): string => fields.map((f) => f.type).join('');

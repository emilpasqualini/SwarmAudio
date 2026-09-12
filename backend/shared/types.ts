//
//  types.ts
//  HIVE (shared)
//
//  The vocabulary both ends agree on.
//
//  A phone is a *device*; once it joins it holds a *slot*, a small integer that
//  is what the sound side addresses (`/hive/dev/3/acc`). UUIDs stay on the
//  server. A *Sample* is one reading — six axes plus time — and is the only
//  thing downstream code ever sees, whether it came from a phone or, later,
//  from a replayed dataset.
//

export type Platform = 'unknown' | 'ios' | 'android' | 'other';

/** Wire encoding of the platform, one byte. */
export const PLATFORM_CODE: Record<Platform, number> = { unknown: 0, ios: 1, android: 2, other: 3 };
export const PLATFORM_FROM_CODE: Platform[] = ['unknown', 'ios', 'android', 'other'];

export interface Sample {
  /** Slot of the device that produced it (1..N). */
  slot: number;
  /** Server arrival time, ms since epoch. */
  t: number;
  /** Client-side timestamp, ms since epoch (client clock). */
  tClient: number;
  /** Acceleration including gravity, m/s², normalized so a flat phone reads (0, 0, +9.81). */
  acc: [number, number, number];
  /** Rotation rate, °/s, around x (beta), y (gamma), z (alpha). */
  gyro: [number, number, number];
}

export type Transport = 'ws' | 'post';

export interface DeviceInfo {
  id: string;
  slot: number;
  name: string;
  platform: Platform;
  transport: Transport;
  /** Estimated incoming sample rate, Hz. */
  hz: number;
  joinedAt: number;
  lastSeen: number;
  last: Sample | null;
}

export interface SwarmFeatures {
  t: number;
  count: number;
  /** Mean |acc − g| over devices: how hard the swarm is moving. */
  energy: number;
  /** Mean |gyro| over devices, °/s: how much it is turning. */
  motion: number;
  /** 0..1, 1 = every device turning equally hard. */
  sync: number;
}

export interface OscTarget {
  id: string;
  label: string;
  host: string;
  port: number;
  enabled: boolean;
  /** Runtime only, not persisted. */
  sent?: number;
  error?: string | null;
}

// --- runtime settings (editable on the dashboard, persisted) -----------------

export interface Settings {
  /** Rate of /hive/swarm/* messages. */
  swarmHz: number;
  /** A device silent for this long has left. */
  deviceTimeoutMs: number;
  /** Fake phones; 0 = off. */
  simulate: number;
  /** Send /hive/dev/<slot>/acc, /gyro per sample. */
  oscPerSample: boolean;
  /** Send /hive/dev/<slot>/mag per sample. */
  oscMag: boolean;
  /** Send /hive/swarm/* at swarmHz. */
  oscSwarm: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  swarmHz: 30,
  deviceTimeoutMs: 3000,
  simulate: 0,
  oscPerSample: true,
  oscMag: true,
  oscSwarm: true,
};

export const SETTINGS_LIMITS = {
  swarmHz: { min: 1, max: 120 },
  deviceTimeoutMs: { min: 500, max: 60_000 },
  simulate: { min: 0, max: 50 },
} as const;

// --- monitor feed (server → dashboard, JSON at ~10 Hz) ----------------------

export interface MonitorHello {
  type: 'hello';
  urls: string[];
  qrUrl: string;
  httpPort: number;
  httpsPort: number;
  /** Where hive.config.json lives, for the dashboard to say so. */
  configFile: string;
}

export interface MonitorState {
  type: 'state';
  t: number;
  devices: DeviceInfo[];
  targets: OscTarget[];
  feedSubscribers: number;
  swarm: SwarmFeatures;
  settings: Settings;
}

export type MonitorMessage = MonitorHello | MonitorState;

// --- raw feed (server → teammates' code, JSON) --------------------------------

export type FeedMessage =
  | { type: 'sample'; slot: number; t: number; acc: [number, number, number]; gyro: [number, number, number] }
  | { type: 'join'; slot: number; platform: Platform; name: string }
  | { type: 'leave'; slot: number }
  | ({ type: 'swarm' } & SwarmFeatures);

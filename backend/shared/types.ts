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
  /** Stable 8-character id of the phone. */
  uid: string;
  /** Server arrival time, ms since epoch. */
  t: number;
  /** Client-side timestamp, ms since epoch (client clock). */
  tClient: number;
  /** Acceleration including gravity, m/s², normalized so a flat phone reads (0, 0, +9.81). */
  acc: [number, number, number];
  /** Rotation rate, °/s, around x (beta), y (gamma), z (alpha). */
  gyro: [number, number, number];
  /** One-Euro-smoothed acceleration relative to the device's adaptive zero (m/s²); settles to 0 at rest. */
  rel: [number, number, number];
  /** 0..1, how much the phone is turning or being jolted right now. */
  activity: number;
  /** Seconds the phone has been at rest. */
  idle: number;
  /** Rotation rate about the vertical (gravity) axis, °/s; positive = counter-clockwise seen from above. */
  turn: number;
}

export type Transport = 'ws' | 'post';

export interface DeviceInfo {
  id: string;
  /** First 8 characters of `id`; what the OSC side sees. */
  uid: string;
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
  /** Send the wide /hive/sample message per sample. */
  oscWide: boolean;
  /** Send the per-field /hive/dev/<slot>/* messages per sample. */
  oscPerField: boolean;
  /** Send /hive/roster and /hive/schema every second. */
  oscRoster: boolean;
  /** Send /hive/swarm (wide) and /hive/swarm/* at swarmHz. */
  oscSwarm: boolean;
  /** Seconds at rest before the zero starts to follow. */
  zeroIdleAfter: number;
  /** Seconds — time constant of the zero's slide. */
  zeroTau: number;
  /** One-Euro filter: cutoff at rest, Hz. */
  filterMinCutoff: number;
  /** One-Euro filter: how much the cutoff rises with speed of change. */
  filterBeta: number;
  /** uid of the queen bee; '' = none. Set by hand, by the wall (a bee that flies into her), or after queenAfter seconds. */
  queenUid: string;
  /** Seconds without a queen after which the device that moved most becomes one. */
  queenAfter: number;
  /** Wi-Fi the phones must be on; the wall and the dashboard show it as a QR code. '' = none. */
  wifiSsid: string;
  wifiPassword: string;
  /** true: the network is an iPhone personal hotspot (hints and wording follow); false: any other Wi-Fi. */
  wifiHotspot: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  swarmHz: 30,
  deviceTimeoutMs: 3000,
  simulate: 0,
  oscWide: true,
  oscPerField: true,
  oscRoster: true,
  oscSwarm: true,
  zeroIdleAfter: 1.2,
  zeroTau: 2.5,
  filterMinCutoff: 1.0,
  filterBeta: 0.3,
  queenUid: '',
  queenAfter: 20,
  wifiSsid: 'Emilio Algieba',      // Emil's iPhone hotspot — the default network at the venue
  wifiPassword: '4zs83ffnac5jy',
  wifiHotspot: true,
};

export const SETTINGS_LIMITS = {
  swarmHz: { min: 1, max: 120 },
  deviceTimeoutMs: { min: 500, max: 60_000 },
  simulate: { min: 0, max: 50 },
  zeroIdleAfter: { min: 0, max: 30 },
  zeroTau: { min: 0.1, max: 60 },
  filterMinCutoff: { min: 0.05, max: 30 },
  filterBeta: { min: 0, max: 5 },
  queenAfter: { min: 1, max: 600 },
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
  /** Changes on every server start; a page that sees a new one reloads itself. */
  bootId: string;
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
  | { type: 'sample'; slot: number; uid: string; t: number; acc: [number, number, number]; gyro: [number, number, number]; rel: [number, number, number]; activity: number; idle: number; turn: number }
  | { type: 'join'; slot: number; uid: string; platform: Platform; name: string }
  | { type: 'leave'; slot: number; uid: string }
  | ({ type: 'swarm' } & SwarmFeatures);

// --- wi-fi QR ------------------------------------------------------------------

/**
 * The string a phone camera understands as "join this network"
 * (the de-facto WIFI: scheme used by Android and iOS). Backslash-escapes the
 * characters the scheme reserves; an empty password means an open network.
 */
export function wifiQrText(ssid: string, password: string, hidden = false): string {
  const esc = (v: string): string => v.replace(/([\;,":])/g, '\\$1');
  const auth = password ? `T:WPA;S:${esc(ssid)};P:${esc(password)};` : `T:nopass;S:${esc(ssid)};`;
  return `WIFI:${auth}${hidden ? 'H:true;' : ''};`;
}

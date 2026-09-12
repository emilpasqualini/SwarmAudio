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

// --- camera (backend/vision, YOLO pose on a webcam) ------------------------------

export interface VisionPerson {
  /** Tracker id; stable while the person stays in view. Not a phone. */
  id: number;
  /** 0..1 across the frame (mirrored if the camera setting says so). */
  x: number;
  /** 0..1 down the frame. */
  y: number;
  /** Box height / frame height, 0..1 — bigger = closer. */
  depth: number;
  /** Wrists above shoulders: 0, 1 or 2. */
  armsUp: number;
  /** 0..1, how far the hips have dropped toward the knees. */
  crouch: number;
  /** 0..1, how fast the person moves in the frame, smoothed. */
  energy: number;
}

export interface VisionCluster { n: number; x: number; y: number; r: number }

export interface VisionFrame {
  t: number;
  fps: number;
  count: number;
  clusters: VisionCluster[];
  people: VisionPerson[];
  /** Mean pairwise distance, 0..1 of the frame width. */
  spread: number;
  /** Mean person energy, 0..1. */
  energy: number;
  /** Centroid of everyone, 0..1. */
  cx: number;
  cy: number;
  /** Mean armsUp, 0..2. */
  armsUp: number;
  /** Crowd motion, computed on the server from frame to frame (see CAM_FIELDS). */
  flowX: number;
  flowY: number;
  turbulence: number;
  moveSync: number;
  converge: number;
  nearest: number;
  stillness: number;
  occupancy: number;
}

/** Where the bees and the camera's people meet (see MIX_FIELDS). */
export interface MixFeatures {
  t: number;
  bees: number;
  people: number;
  distance: number;
  beesInCrowd: number;
  queenInCrowd: number;
  covered: number;
  alignment: number;
  balance: number;
}

export interface VisionStatus {
  connected: boolean;
  /** Camera names as the camera process sees them, in index order. */
  cameras: string[];
  /** mps · coreml · cpu — what the model runs on. */
  backend: string;
  fps: number;
  count: number;
  clusters: number;
  spread: number;
  energy: number;
  flowX: number;
  flowY: number;
  turbulence: number;
  moveSync: number;
  converge: number;
  nearest: number;
  stillness: number;
  occupancy: number;
}

// --- swarm meta-parameters (/hive/global) ---------------------------------------

export interface GlobalFeatures {
  t: number;
  count: number;
  /** Mean pairwise correlation of rel over the last second, −1..1. */
  coherence: number;
  /** Kuramoto order parameter of the movement phase, 0..1. */
  phaseSync: number;
  /** Dominant movement frequency of the swarm, Hz. */
  tempo: number;
  /** Spectral centroid of the swarm's energy, Hz. */
  centroid: number;
  /** How evenly activity is spread over people, 0..1. */
  entropy: number;
  /** Std of rel across devices, m/s². */
  dispersion: number;
  /** Mean rel x / y: where the swarm leans. */
  leanX: number;
  leanY: number;
  /** Activity onsets per second across the swarm. */
  onsets: number;
  /** Peak / RMS of energy over 2 s. */
  crest: number;
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

/** What the wall draws. Same mechanics for all; the queen is the big one. */
export const SPECIES = ['bees', 'sheep'] as const;
export type Species = typeof SPECIES[number];

export interface Settings {
  /** false: the swarm is gathered but nothing starts — bees hover, no queen race, phones wait. Start/Pause on the dashboard. */
  running: boolean;
  /** Bumped by Reset: a new round — queen cleared, tallies cleared, bees re-spawned. */
  round: number;
  /** What the wall draws. */
  species: Species;
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
  /** Show the wi-fi / join QR codes on the wall. Switch them off once everyone is in. */
  wallWifiCode: boolean;
  wallJoinCode: boolean;
  /** Camera: send /hive/cam (frame + clusters) and /hive/cam/person. */
  oscCam: boolean;
  oscCamPersons: boolean;
  /** Camera: bees are drawn toward crowds on the wall, with this strength. */
  camCoupling: boolean;
  camStrength: number;
  /** Camera: cluster radius, fraction of the frame width. */
  camEps: number;
  /** Camera: mirror x so the picture behaves like a mirror. */
  camMirror: boolean;
  /** Camera: encode the annotated preview for the dashboard. */
  camPreview: boolean;
  /** Camera: which one, by index; −1 = the first that opens. */
  camIndex: number;
  /** Send /hive/global. */
  oscGlobal: boolean;
  /** Send /hive/mix (bees ⇄ camera). */
  oscMix: boolean;
  /** Small messages switched off individually (keys from MUTABLE in osc-schema.ts) — saves traffic for what nobody uses. */
  oscMute: string[];
}

export const DEFAULT_SETTINGS: Settings = {
  running: false,
  round: 1,
  species: 'bees',
  swarmHz: 30,
  deviceTimeoutMs: 3000,
  simulate: 0,
  oscWide: true,
  oscPerField: true,
  oscRoster: true,
  oscSwarm: true,
  zeroIdleAfter: 2.5,
  zeroTau: 6,
  filterMinCutoff: 1.0,
  filterBeta: 0.3,
  queenUid: '',
  queenAfter: 20,
  wifiSsid: 'Emilio Algieba',      // Emil's iPhone hotspot — the default network at the venue
  wifiPassword: 'jointhehive',
  wifiHotspot: true,
  wallWifiCode: true,
  wallJoinCode: true,
  oscCam: true,
  oscCamPersons: true,
  camCoupling: false,
  camStrength: 0.5,
  camEps: 0.12,
  camMirror: true,
  camPreview: true,
  camIndex: -1,
  oscGlobal: true,
  oscMix: true,
  oscMute: [],
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
  camStrength: { min: 0, max: 1 },
  camEps: { min: 0.02, max: 0.5 },
  camIndex: { min: -1, max: 7 },
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
  global: GlobalFeatures;
  vision: VisionStatus;
  mix: MixFeatures;
  settings: Settings;
}

export type MonitorMessage = MonitorHello | MonitorState;

// --- raw feed (server → teammates' code, JSON) --------------------------------

export type FeedMessage =
  | { type: 'sample'; slot: number; uid: string; t: number; acc: [number, number, number]; gyro: [number, number, number]; rel: [number, number, number]; activity: number; idle: number; turn: number; queen: boolean }
  | { type: 'join'; slot: number; uid: string; platform: Platform; name: string }
  | { type: 'leave'; slot: number; uid: string }
  | ({ type: 'swarm' } & SwarmFeatures)
  | ({ type: 'global' } & GlobalFeatures)
  | ({ type: 'vision' } & VisionFrame)
  | ({ type: 'mix' } & MixFeatures);

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

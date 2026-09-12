//
//  settings.ts
//  HIVE (server)
//
//  Runtime settings: validated, applied to the running pieces, persisted.
//
//  Whatever the dashboard can change goes through `apply`, so the swarm rate,
//  the device timeout, the fake phones and the OSC switches all take effect
//  immediately and are the same after a restart.
//

import { CAM_MODES, DEFAULT_SETTINGS, SETTINGS_LIMITS, SPECIES } from '../shared/types';
import { MUTABLE } from '../shared/osc-schema';
import type { CamMode, Settings, Species } from '../shared/types';
import type { Store } from './store';
import type { Registry } from './registry';
import type { Swarm } from './swarm';
import type { OscOut } from './osc';
import { startSimulation } from './simulate';
import type { Global } from './global';
import type { VisionIn } from './vision';
import type { Mix } from './mix';
import type { Feed } from './feed';

export class SettingsController {
  private stopSimulation: (() => void) | null = null;
  private readonly changed: (() => void)[] = [];

  constructor(
    private readonly store: Store,
    private readonly registry: Registry,
    private readonly swarm: Swarm,
    private readonly osc: OscOut,
    private readonly global: Global,
    private readonly vision: VisionIn,
    private readonly mix: Mix,
    private readonly feed: Feed,
  ) {}

  get current(): Settings { return this.store.settings; }

  onChange(fn: () => void): void { this.changed.push(fn); }

  /** Push the stored settings into every component; call once at boot. */
  applyAll(): void {
    this.applyTo(this.store.settings, { ...DEFAULT_SETTINGS, simulate: -1 });
  }

  /** Validates and applies a partial update. Returns an error message, or null. */
  update(patch: Record<string, unknown>): string | null {
    const next: Settings = { ...this.store.settings };
    for (const key of ['swarmHz', 'deviceTimeoutMs', 'simulate', 'queenAfter', 'camIndex', 'camDetectFps'] as const) {
      if (patch[key] === undefined) continue;
      const n = Number(patch[key]);
      const { min, max } = SETTINGS_LIMITS[key];
      if (!Number.isFinite(n) || n < min || n > max) return `${key} must be between ${min} and ${max}`;
      next[key] = Math.round(n);
    }
    for (const key of ['zeroIdleAfter', 'zeroTau', 'filterMinCutoff', 'filterBeta', 'camStrength', 'camEps', 'camPushStrength'] as const) {
      if (patch[key] === undefined) continue;
      const n = Number(patch[key]);
      const { min, max } = SETTINGS_LIMITS[key];
      if (!Number.isFinite(n) || n < min || n > max) return `${key} must be between ${min} and ${max}`;
      next[key] = Math.round(n * 100) / 100;
    }
    for (const key of ['oscWide', 'oscPerField', 'oscRoster', 'oscSwarm', 'wifiHotspot', 'wallWifiCode', 'wallJoinCode', 'running', 'oscCam', 'oscCamPersons', 'camCoupling', 'camMirror', 'camPreview', 'oscGlobal', 'oscMix', 'queenHidden', 'camPush', 'camEnabled'] as const) {
      if (patch[key] !== undefined) next[key] = Boolean(patch[key]);
    }
    for (const key of ['wifiSsid', 'wifiPassword'] as const) {
      if (patch[key] === undefined) continue;
      const v = String(patch[key]);
      if (v.length > 64) return `${key} is too long`;
      next[key] = v;
    }
    // Reset: a new round. The queen is cleared, the wall re-spawns, the queen
    // keeper starts counting afresh, and the swarm waits for Start again.
    if (patch['reset']) { next.round = (next.round || 0) + 1; next.queenUid = ''; next.running = false; }
    if (patch['camMode'] !== undefined) {
      const m = String(patch['camMode']);
      if (!(CAM_MODES as readonly string[]).includes(m)) return `camMode must be one of ${CAM_MODES.join(', ')}`;
      next.camMode = m as CamMode;
    }
    if (patch['species'] !== undefined) {
      const sp = String(patch['species']);
      if (!(SPECIES as readonly string[]).includes(sp)) return `species must be one of ${SPECIES.join(', ')}`;
      next.species = sp as Species;
    }
    if (patch['oscMute'] !== undefined) {
      const list = patch['oscMute'];
      if (!Array.isArray(list)) return 'oscMute must be a list of keys';
      const known = new Set(MUTABLE.map((m) => m.key));
      next.oscMute = [...new Set(list.map(String).filter((k) => known.has(k)))];
    }
    if (patch['queenUid'] !== undefined) {
      const uid = String(patch['queenUid']);
      if (!/^[0-9a-z]{0,8}$/.test(uid)) return 'queenUid must be an 8-character uid or empty';
      next.queenUid = uid;
    }
    const previous = this.store.settings;
    this.store.settings = next;
    this.applyTo(next, previous);
    this.store.save();
    for (const fn of this.changed) fn();
    return null;
  }

  private applyTo(s: Settings, previous: Settings): void {
    if (s.swarmHz !== previous.swarmHz) this.swarm.setHz(s.swarmHz);
    if (s.deviceTimeoutMs !== previous.deviceTimeoutMs) this.registry.setTimeout(s.deviceTimeoutMs);
    this.osc.flags = { wide: s.oscWide, perField: s.oscPerField, roster: s.oscRoster, swarm: s.oscSwarm, global: s.oscGlobal, cam: s.oscCam, camPersons: s.oscCamPersons, mix: s.oscMix };
    this.osc.muted = new Set(s.oscMute);
    this.mix.setHz(s.swarmHz);
    this.mix.queenUid = s.queenUid;
    this.feed.queenUid = s.queenUid;
    this.global.setHz(s.swarmHz);
    this.vision.configure({ eps: s.camEps, mirror: s.camMirror, preview: s.camPreview, camera: s.camIndex, mode: s.camMode, detectFps: s.camDetectFps, enabled: s.camEnabled });
    this.registry.condition.idleAfter = s.zeroIdleAfter;
    this.registry.condition.baselineTau = s.zeroTau;
    this.registry.condition.minCutoff = s.filterMinCutoff;
    this.registry.condition.beta = s.filterBeta;
    this.osc.queenUid = s.queenUid;
    if (s.simulate !== previous.simulate) {
      this.stopSimulation?.();
      this.stopSimulation = s.simulate > 0 ? startSimulation(this.registry, s.simulate) : null;
    }
  }
}

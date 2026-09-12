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

import { DEFAULT_SETTINGS, SETTINGS_LIMITS } from '../shared/types';
import type { Settings } from '../shared/types';
import type { Store } from './store';
import type { Registry } from './registry';
import type { Swarm } from './swarm';
import type { OscOut } from './osc';
import { startSimulation } from './simulate';

export class SettingsController {
  private stopSimulation: (() => void) | null = null;
  private readonly changed: (() => void)[] = [];

  constructor(
    private readonly store: Store,
    private readonly registry: Registry,
    private readonly swarm: Swarm,
    private readonly osc: OscOut,
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
<<<<<<< HEAD
    for (const key of ['swarmHz', 'deviceTimeoutMs', 'simulate', 'queenAfter'] as const) {
=======
    for (const key of ['swarmHz', 'deviceTimeoutMs', 'simulate'] as const) {
>>>>>>> 791460b3b24265c8bbf40de2d4abdf0497736a94
      if (patch[key] === undefined) continue;
      const n = Number(patch[key]);
      const { min, max } = SETTINGS_LIMITS[key];
      if (!Number.isFinite(n) || n < min || n > max) return `${key} must be between ${min} and ${max}`;
      next[key] = Math.round(n);
    }
<<<<<<< HEAD
    for (const key of ['zeroIdleAfter', 'zeroTau', 'filterMinCutoff', 'filterBeta'] as const) {
      if (patch[key] === undefined) continue;
      const n = Number(patch[key]);
      const { min, max } = SETTINGS_LIMITS[key];
      if (!Number.isFinite(n) || n < min || n > max) return `${key} must be between ${min} and ${max}`;
      next[key] = Math.round(n * 100) / 100;
    }
    for (const key of ['oscWide', 'oscPerField', 'oscRoster', 'oscSwarm', 'wifiHotspot', 'wallWifiCode', 'wallJoinCode', 'running'] as const) {
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
    if (patch['queenUid'] !== undefined) {
      const uid = String(patch['queenUid']);
      if (!/^[0-9a-z]{0,8}$/.test(uid)) return 'queenUid must be an 8-character uid or empty';
      next.queenUid = uid;
    }
=======
    for (const key of ['oscPerSample', 'oscMag', 'oscSwarm'] as const) {
      if (patch[key] !== undefined) next[key] = Boolean(patch[key]);
    }
>>>>>>> 791460b3b24265c8bbf40de2d4abdf0497736a94
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
<<<<<<< HEAD
    this.osc.flags = { wide: s.oscWide, perField: s.oscPerField, roster: s.oscRoster, swarm: s.oscSwarm };
    this.registry.condition.idleAfter = s.zeroIdleAfter;
    this.registry.condition.baselineTau = s.zeroTau;
    this.registry.condition.minCutoff = s.filterMinCutoff;
    this.registry.condition.beta = s.filterBeta;
    this.osc.queenUid = s.queenUid;
=======
    this.osc.flags = { perSample: s.oscPerSample, mag: s.oscMag, swarm: s.oscSwarm };
>>>>>>> 791460b3b24265c8bbf40de2d4abdf0497736a94
    if (s.simulate !== previous.simulate) {
      this.stopSimulation?.();
      this.stopSimulation = s.simulate > 0 ? startSimulation(this.registry, s.simulate) : null;
    }
  }
}

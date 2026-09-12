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
    for (const key of ['swarmHz', 'deviceTimeoutMs', 'simulate'] as const) {
      if (patch[key] === undefined) continue;
      const n = Number(patch[key]);
      const { min, max } = SETTINGS_LIMITS[key];
      if (!Number.isFinite(n) || n < min || n > max) return `${key} must be between ${min} and ${max}`;
      next[key] = Math.round(n);
    }
    for (const key of ['oscPerSample', 'oscMag', 'oscSwarm'] as const) {
      if (patch[key] !== undefined) next[key] = Boolean(patch[key]);
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
    this.osc.flags = { perSample: s.oscPerSample, mag: s.oscMag, swarm: s.oscSwarm };
    if (s.simulate !== previous.simulate) {
      this.stopSimulation?.();
      this.stopSimulation = s.simulate > 0 ? startSimulation(this.registry, s.simulate) : null;
    }
  }
}

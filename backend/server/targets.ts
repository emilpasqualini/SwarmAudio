//
//  targets.ts
//  HIVE (server)
//
//  The list of machines that receive OSC, and its persistence.
//
//  Teammates add their laptop from the dashboard; the list lives in the
//  Store (hive.config.json) so the team's setup is not rebuilt every morning.
//

import { randomUUID } from 'node:crypto';
import type { OscTarget } from '../shared/types';
import type { Store } from './store';

export class Targets {
  private readonly changed: (() => void)[] = [];

  constructor(private readonly store: Store, initial: string) {
    if (this.list.length === 0) {
      for (const spec of initial.split(',')) {
        const parsed = parseHostPort(spec.trim());
        if (parsed) this.list.push({ id: randomUUID(), label: parsed.host === '127.0.0.1' ? 'this Mac' : '', ...parsed, enabled: true, sent: 0, error: null });
      }
      this.save();
    }
  }

  private get list(): OscTarget[] { return this.store.targets; }
  private set list(v: OscTarget[]) { this.store.targets = v; }

  onChange(fn: () => void): void { this.changed.push(fn); }

  all(): OscTarget[] { return this.list; }
  enabled(): OscTarget[] { return this.list.filter((t) => t.enabled); }
  get(id: string): OscTarget | undefined { return this.list.find((t) => t.id === id); }

  add(host: string, port: number, label = ''): OscTarget | null {
    if (!validHost(host) || !validPort(port)) return null;
    const existing = this.list.find((t) => t.host === host && t.port === port);
    if (existing) return existing;
    const target: OscTarget = { id: randomUUID(), label, host, port, enabled: true, sent: 0, error: null };
    this.list.push(target);
    this.save();
    return target;
  }

  update(id: string, patch: Partial<Pick<OscTarget, 'enabled' | 'label' | 'host' | 'port'>>): OscTarget | null {
    const t = this.get(id);
    if (!t) return null;
    if (patch.host !== undefined) { if (!validHost(patch.host)) return null; t.host = patch.host; }
    if (patch.port !== undefined) { if (!validPort(patch.port)) return null; t.port = patch.port; }
    if (patch.label !== undefined) t.label = String(patch.label).slice(0, 40);
    if (patch.enabled !== undefined) t.enabled = Boolean(patch.enabled);
    t.error = null;
    this.save();
    return t;
  }

  remove(id: string): boolean {
    const before = this.list.length;
    this.list = this.list.filter((t) => t.id !== id);
    if (this.list.length === before) return false;
    this.save();
    return true;
  }

  private save(): void {
    this.store.save();
    for (const fn of this.changed) fn();
  }
}

export function parseHostPort(spec: string): { host: string; port: number } | null {
  const m = /^([^:\s]+):(\d{1,5})$/.exec(spec);
  if (!m) return null;
  const port = Number(m[2]);
  return validHost(m[1]!) && validPort(port) ? { host: m[1]!, port } : null;
}

const validHost = (h: string): boolean => /^[a-zA-Z0-9.-]{1,253}$/.test(h);
const validPort = (p: number): boolean => Number.isInteger(p) && p > 0 && p < 65536;

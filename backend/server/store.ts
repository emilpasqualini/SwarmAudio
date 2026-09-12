//
//  store.ts
//  HIVE (server)
//
//  hive.config.json: everything the dashboard can change, and nothing else.
//
//  One file, two keys — the OSC targets and the runtime settings — so the
//  team's setup survives a restart. Ports are not in here: they come from the
//  environment and need a restart, which the dashboard says rather than hides.
//

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { OscTarget, Settings } from '../shared/types';
import { DEFAULT_SETTINGS } from '../shared/types';

interface FileShape {
  targets?: OscTarget[];
  settings?: Partial<Settings>;
}

export class Store {
  targets: OscTarget[] = [];
  settings: Settings = { ...DEFAULT_SETTINGS };

  constructor(private readonly file: string) {
    if (!existsSync(file)) return;
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as FileShape;
      this.targets = (parsed.targets ?? []).map((t) => ({ ...t, sent: 0, error: null }));
      this.settings = { ...DEFAULT_SETTINGS, ...(parsed.settings ?? {}) };
    } catch (err) {
      console.warn(`[hive] could not read ${file}: ${(err as Error).message}`);
    }
  }

  save(): void {
    const targets = this.targets.map(({ id, label, host, port, enabled }) => ({ id, label, host, port, enabled }));
    writeFileSync(this.file, JSON.stringify({ targets, settings: this.settings }, null, 2) + '\n');
  }
}

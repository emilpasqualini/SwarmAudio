//
//  queen.ts
//  HIVE (server)
//
//  Who the queen is, when nobody has said.
//
//  The queen is a setting (`queenUid`) so that the dashboard, the wall and,
//  later, the OSC side all agree on her. The wall passes the crown on when a
//  bee flies into her; the dashboard crowns by hand. This keeper fills the
//  gaps: while there is no queen it adds up how much every phone moves, and
//  after `queenAfter` seconds the one that moved most is crowned — earned,
//  not drawn by lot. A queen whose phone drops out keeps the crown for a
//  short grace so a flaky connection does not dethrone her; after that the
//  race starts again.
//

import type { Registry } from './registry';
import type { SettingsController } from './settings';

const GRACE_MS = 10_000;

export class QueenKeeper {
  /** uid → integrated activity (activity × seconds) since the throne became vacant. */
  private readonly moved = new Map<string, number>();
  private vacantSince: number | null = null;
  private missingSince: number | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly registry: Registry, private readonly settings: SettingsController) {
    registry.on('sample', (s, d) => {
      if (this.settings.current.queenUid) return;
      this.moved.set(s.uid, (this.moved.get(s.uid) ?? 0) + s.activity / Math.max(10, d.hz || 60));
    });
  }

  start(): void {
    this.timer ??= setInterval(() => this.tick(), 1000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private tick(now = Date.now()): void {
    const queen = this.settings.current.queenUid;
    const devices = this.registry.list();
    if (queen) {
      this.vacantSince = null;
      this.moved.clear();
      if (devices.some((d) => d.uid === queen)) { this.missingSince = null; return; }
      this.missingSince ??= now;
      if (now - this.missingSince > GRACE_MS) {
        this.missingSince = null;
        this.settings.update({ queenUid: '' });
        console.log('[hive] the queen has left — the throne is vacant');
      }
      return;
    }
    if (devices.length === 0) { this.vacantSince = null; this.moved.clear(); return; }
    this.vacantSince ??= now;
    if (now - this.vacantSince < this.settings.current.queenAfter * 1000) return;
    let best: { uid: string; moved: number } | null = null;
    for (const d of devices) {
      const m = this.moved.get(d.uid) ?? 0;
      if (!best || m > best.moved) best = { uid: d.uid, moved: m };
    }
    if (!best) return;
    const d = devices.find((x) => x.uid === best!.uid)!;
    console.log(`[hive] #${d.slot} ${d.name ? `"${d.name}" ` : ''}moved most (${best.moved.toFixed(1)}) — crowned queen`);
    this.settings.update({ queenUid: best.uid });
  }
}

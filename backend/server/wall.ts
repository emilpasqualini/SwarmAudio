//
//  wall.ts
//  HIVE (server)
//
//  Where the bees are — as the wall last reported it.
//
//  The bees' positions live on the wall page, not here: the flight model runs
//  in the projector's browser. Phones want to see the swarm too, so the wall
//  posts a snapshot ten times a second and the server hands it on — not by
//  making phones ask, but riding on the stream they already send: as the
//  reply to a POSTed frame, or as a text message down the ingest socket
//  (ingest.ts). No extra requests, and every phone sees the same picture the
//  wall shows within a tenth of a second.
//

export interface WallBee { uid: string; slot: number; x: number; y: number; h: number }

/** The wire form phones receive: `{ v, q, b: [[uid, slot, x, y, h], …] }`. */
export interface WallWire { v: number; q: string; b: [string, number, number, number, number][] }

export class WallState {
  private bees: WallBee[] = [];
  private t = 0;
  /** Bumps on every set; phones are handed each version once. */
  version = 0;
  private queenUid = '';
  private wire = '';
  private readonly listeners: ((text: string) => void)[] = [];

  constructor(queenUid: string) {
    this.queenUid = queenUid;
    this.encode();   // so phones learn who the queen is even before the wall reports any bees
  }

  onChange(fn: (text: string) => void): void { this.listeners.push(fn); }

  setQueen(uid: string): void {
    if (uid === this.queenUid) return;
    this.queenUid = uid;
    this.encode();
  }

  set(bees: unknown): void {
    if (!Array.isArray(bees)) return;
    this.bees = bees
      .filter((b): b is WallBee => typeof b === 'object' && b !== null && typeof b.uid === 'string')
      .slice(0, 255)
      .map((b) => ({ uid: b.uid, slot: Number(b.slot) || 0, x: Number(b.x) || 0, y: Number(b.y) || 0, h: Number(b.h) || 0 }));
    this.t = Date.now();
    this.encode();
  }

  /** The current wire text, and its version. */
  get text(): string { return this.wire; }

  snapshot(): { t: number; queenUid: string; bees: WallBee[] } {
    return { t: this.t, queenUid: this.queenUid, bees: this.bees };
  }

  private encode(): void {
    this.version++;
    const w: WallWire = { v: this.version, q: this.queenUid, b: this.bees.map((b) => [b.uid, b.slot, b.x, b.y, b.h]) };
    this.wire = JSON.stringify(w);
    for (const fn of this.listeners) fn(this.wire);
  }
}

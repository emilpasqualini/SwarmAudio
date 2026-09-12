//
//  wall.ts
//  HIVE (server)
//
//  Where the bees are — as the wall last reported it.
//
//  The bees' positions live on the wall page, not here: the flight model runs
//  in the projector's browser. Phones want to see the swarm too, so the wall
//  posts a snapshot ten times a second and phones poll it. The server only
//  holds the latest one; there is nothing to compute.
//

export interface WallBee { uid: string; slot: number; x: number; y: number; h: number }

export class WallState {
  private bees: WallBee[] = [];
  private t = 0;

  set(bees: unknown): void {
    if (!Array.isArray(bees)) return;
    this.bees = bees
      .filter((b): b is WallBee => typeof b === 'object' && b !== null && typeof b.uid === 'string')
      .slice(0, 255)
      .map((b) => ({ uid: b.uid, slot: Number(b.slot) || 0, x: Number(b.x) || 0, y: Number(b.y) || 0, h: Number(b.h) || 0 }));
    this.t = Date.now();
  }

  snapshot(queenUid: string): { t: number; queenUid: string; bees: WallBee[] } {
    return { t: this.t, queenUid, bees: this.bees };
  }
}

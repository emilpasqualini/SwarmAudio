//
//  visual.ts
//  HIVE (client, wall)
//
//  What a wall visual is. The wall page owns the canvas, the feed and the
//  clock; a visual gets fed and asked to draw. Add a new one by implementing
//  this and registering it in wall.ts — the swarm's data arrives the same way
//  for every visual, whether it is dots, a flock, or a spectrogram.
//

import type { FeedMessage } from '../../../shared/types';

export interface Frame {
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
  /** Seconds since the last frame, clamped. */
  dt: number;
  /** Seconds since the visual started. */
  time: number;
  /** CSS colour for a slot. */
  colour: (slot: number) => string;
  /** uid of the queen (server setting), '' = none. */
  queen: string;
  /** Tell the server a bee has taken the crown. */
  crown: (uid: string) => void;
}

export interface Visual {
  /** Every feed message: samples at 60 Hz per device, join/leave, swarm features. */
  feed(msg: FeedMessage): void;
  /** Called on every animation frame. Draw onto `frame.ctx`. */
  draw(frame: Frame): void;
  /** Canvas size changed (CSS pixels). */
  resize?(width: number, height: number): void;
}

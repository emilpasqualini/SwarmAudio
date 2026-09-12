//
//  feed.ts
//  HIVE (server)
//
//  Raw JSON stream for teammates who would rather have the data in their own
//  code than parse OSC — and for the dashboard's test tones, which need the
//  full rate rather than the 10 Hz monitor snapshot.
//
//  One message per sample; no batching, no back-pressure games. If a
//  subscriber cannot keep up (bufferedAmount grows), its samples are skipped
//  until it drains — latency never accumulates, which is what matters for sound.
//

import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import type { Registry } from './registry';
import type { Swarm } from './swarm';
import type { Global } from './global';
import type { VisionIn } from './vision';
import type { FeedMessage } from '../shared/types';

const MAX_BUFFERED = 64 * 1024;

export class Feed {
  readonly wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  private readonly clients = new Set<WebSocket>();

  constructor(registry: Registry, swarm: Swarm, global: Global, vision: VisionIn) {
    this.wss.on('connection', (socket) => {
      this.clients.add(socket);
      // Current roster first, so a late subscriber knows who is already there.
      for (const d of registry.list()) {
        socket.send(JSON.stringify({ type: 'join', slot: d.slot, uid: d.uid, platform: d.platform, name: d.name } satisfies FeedMessage));
      }
      socket.on('close', () => this.clients.delete(socket));
      socket.on('error', () => this.clients.delete(socket));
    });

    registry.on('sample', (s) => this.broadcast({ type: 'sample', slot: s.slot, uid: s.uid, t: s.t, acc: s.acc, gyro: s.gyro, rel: s.rel, activity: s.activity, idle: s.idle, turn: s.turn }, true));
    registry.on('join', (d) => this.broadcast({ type: 'join', slot: d.slot, uid: d.uid, platform: d.platform, name: d.name }));
    registry.on('leave', (d) => this.broadcast({ type: 'leave', slot: d.slot, uid: d.uid }));
    swarm.on((f) => this.broadcast({ type: 'swarm', ...f }, true));
    global.on((g) => this.broadcast({ type: 'global', ...g }, true));
    vision.onFrame((f) => this.broadcast({ type: 'vision', ...f }, true));
  }

  get subscribers(): number { return this.clients.size; }

  private broadcast(msg: FeedMessage, droppable = false): void {
    if (this.clients.size === 0) return;
    const text = JSON.stringify(msg);
    for (const c of this.clients) {
      if (c.readyState !== c.OPEN) continue;
      if (droppable && c.bufferedAmount > MAX_BUFFERED) continue;
      c.send(text);
    }
  }
}

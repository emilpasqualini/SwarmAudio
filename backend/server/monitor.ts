//
//  monitor.ts
//  HIVE (server)
//
//  The dashboard's view of the server: roster, rates, targets, at 10 Hz.
//

import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import type { Registry } from './registry';
import type { Targets } from './targets';
import type { Swarm } from './swarm';
import type { Feed } from './feed';
import type { MonitorHello, MonitorState } from '../shared/types';

export class Monitor {
  readonly wss = new WebSocketServer({ noServer: true });
  private readonly clients = new Set<WebSocket>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly hello: Omit<MonitorHello, 'type'>,
    private readonly registry: Registry,
    private readonly targets: Targets,
    private readonly swarm: Swarm,
    private readonly feed: Feed,
    private readonly hz: number,
  ) {
    this.wss.on('connection', (socket) => {
      this.clients.add(socket);
      socket.send(JSON.stringify({ type: 'hello', ...this.hello } satisfies MonitorHello));
      socket.send(this.snapshot());
      socket.on('close', () => this.clients.delete(socket));
      socket.on('error', () => this.clients.delete(socket));
    });
    // Push immediately when the target list changes; the 10 Hz tick covers the rest.
    targets.onChange(() => this.push());
  }

  start(): void { this.timer ??= setInterval(() => this.push(), 1000 / this.hz); }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }

  private push(): void {
    if (this.clients.size === 0) return;
    const text = this.snapshot();
    for (const c of this.clients) if (c.readyState === c.OPEN) c.send(text);
  }

  private snapshot(): string {
    const state: MonitorState = {
      type: 'state',
      t: Date.now(),
      devices: this.registry.list(),
      targets: this.targets.all(),
      feedSubscribers: this.feed.subscribers,
      swarm: this.swarm.latest,
    };
    return JSON.stringify(state);
  }
}

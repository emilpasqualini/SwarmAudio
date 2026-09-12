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
import type { SettingsController } from './settings';
import type { Global } from './global';
import type { VisionIn } from './vision';
import type { Mix } from './mix';
import type { MonitorHello, MonitorState } from '../shared/types';

export class Monitor {
  readonly wss = new WebSocketServer({ noServer: true });
  private readonly clients = new Set<WebSocket>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private hello: Omit<MonitorHello, 'type'>,
    private readonly registry: Registry,
    private readonly targets: Targets,
    private readonly swarm: Swarm,
    private readonly feed: Feed,
    private readonly settings: SettingsController,
    private readonly global: Global,
    private readonly vision: VisionIn,
    private readonly mix: Mix,
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
    settings.onChange(() => this.push());
    // The camera's annotated JPEG, as a binary message — the dashboard shows
    // it, the wall ignores binary. Only while someone is looking.
    vision.onPreview((jpeg) => {
      if (!settings.current.camPreview) return;
      for (const c of this.clients) if (c.readyState === c.OPEN && c.bufferedAmount < 256 * 1024) c.send(jpeg, { binary: true });
    });
  }

  /** New LAN addresses (the Mac changed network): tell every open dashboard. */
  setAddresses(urls: string[], qrUrl: string): void {
    this.hello = { ...this.hello, urls, qrUrl };
    const text = JSON.stringify({ type: 'hello', ...this.hello } satisfies MonitorHello);
    for (const c of this.clients) if (c.readyState === c.OPEN) c.send(text);
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
      global: this.global.latest,
      vision: this.vision.status(),
      mix: this.mix.latest,
      settings: this.settings.current,
    };
    return JSON.stringify(state);
  }
}

//
//  index.ts
//  HIVE (server)
//
//  Boot, wiring, and the two listening sockets.
//
//  HTTPS on 8443 is what phones use: the app, the WebSocket, the POST
//  fallback. HTTP on 8080 exists for laptops — it serves the raw `/feed`
//  without a certificate warning and redirects browsers to HTTPS.
//

import { createServer as createHttpServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { Duplex } from 'node:stream';
import { existsSync } from 'node:fs';
import QRCode from 'qrcode';
import { config } from './config';
import { lanAddresses } from './lan';
import { loadOrCreateCertificate } from './cert';
import { serveStatic, notFound } from './static';
import { Registry } from './registry';
import { Store } from './store';
import { SettingsController } from './settings';
import { QueenKeeper } from './queen';
import { WallState } from './wall';
import { Global } from './global';
import { VisionIn } from './vision';
import { Mix } from './mix';
import { Targets, parseHostPort } from './targets';
import { OscOut } from './osc';
import { Swarm } from './swarm';
import { Feed } from './feed';
import { Monitor } from './monitor';
import { createIngest } from './ingest';

const log = (line: string): void => console.log(`[hive] ${line}`);

// --- pieces -------------------------------------------------------------------

let addresses = lanAddresses();
let ips = addresses.map((a) => a.address);
const toUrls = (list: string[]): string[] => list.map((ip) => `https://${ip}:${config.httpsPort}`);
const urls = toUrls(ips);
const qrUrl = urls[0] ?? `https://localhost:${config.httpsPort}`;

const credentials = loadOrCreateCertificate(config.certDir, ips);
if (credentials.regenerated) log(`new self-signed certificate for ${ips.join(', ') || 'localhost'}`);

const store = new Store(config.configFile);
if (config.simulate !== null) store.settings.simulate = config.simulate;
const registry = new Registry(store.settings.deviceTimeoutMs);
const targets = new Targets(store, config.oscTargets);
const osc = new OscOut(targets, registry);
const swarm = new Swarm(registry, store.settings.swarmHz);
const global = new Global(registry, store.settings.swarmHz);
const vision = new VisionIn(log);
const wall = new WallState(store.settings.queenUid, store.settings.running);
const mix = new Mix(wall, vision, store.settings.swarmHz);
const feed = new Feed(registry, swarm, global, vision, mix);
const settings = new SettingsController(store, registry, swarm, osc, global, vision, mix, feed);
const queen = new QueenKeeper(registry, settings);

const ingest = createIngest(registry, wall, log);
const monitor = new Monitor(
  { urls, qrUrl, httpPort: config.httpPort, httpsPort: config.httpsPort, configFile: config.configFile, bootId: String(Date.now()) },
  registry, targets, swarm, feed, settings, global, vision, mix, config.monitorHz,
);

registry.on('sample', (s) => osc.sample(s));
registry.on('join', (d) => { osc.join(d, registry.count); log(`#${d.slot} joined (${d.platform}, ${d.transport}${d.name ? `, "${d.name}"` : ''})`); });
registry.on('leave', (d) => { osc.leave(d, registry.count); log(`#${d.slot} left`); });
swarm.on((f) => osc.swarm(f));
global.on((g) => osc.global(g));
mix.on((m) => osc.mix(m));
vision.onFrame((f) => { osc.cam(f); osc.camStatus = { connected: true, fps: f.fps }; });
setInterval(() => { if (!vision.connected) osc.camStatus = { connected: false, fps: 0 }; }, 1000);

const staticHandler = serveStatic(config.clientDir);

// --- HTTP routing -------------------------------------------------------------

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => { size += c.length; if (size > 4096) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

let pingCounter = 0;

async function handleApi(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
  if (!pathname.startsWith('/api/')) return false;
  try {
    if (pathname === '/api/health') { json(res, 200, { ok: true, devices: registry.count }); return true; }
    if (pathname === '/api/settings' && req.method === 'GET') { json(res, 200, settings.current); return true; }
    if (pathname === '/api/settings' && req.method === 'PATCH') {
      const error = settings.update((await readJson(req)) as Record<string, unknown>);
      json(res, error ? 400 : 200, error ? { error } : settings.current); return true;
    }
    if (pathname === '/api/wall' && req.method === 'GET') { json(res, 200, wall.snapshot()); return true; }
    if (pathname === '/api/wall' && req.method === 'POST') {
      wall.set(((await readJson(req)) as { bees?: unknown }).bees);
      res.writeHead(204).end(); return true;
    }
    if (pathname === '/api/devices/kick' && req.method === 'POST') {
      const { slot } = (await readJson(req)) as { slot?: number };
      const d = registry.list().find((x) => x.slot === Number(slot));
      if (d) registry.remove(d.id);
      json(res, d ? 200 : 404, d ? {} : { error: 'no such slot' }); return true;
    }
    if (pathname === '/api/targets' && req.method === 'GET') { json(res, 200, targets.all()); return true; }
    if (pathname === '/api/targets' && req.method === 'POST') {
      const body = (await readJson(req)) as { host?: string; port?: number | string; spec?: string; label?: string };
      const hp = body.spec ? parseHostPort(body.spec) : (body.host && body.port ? { host: body.host, port: Number(body.port) } : null);
      const t = hp ? targets.add(hp.host, hp.port, body.label ?? '') : null;
      if (!t) { json(res, 400, { error: 'expected host:port' }); return true; }
      json(res, 201, t); return true;
    }
    const m = /^\/api\/targets\/([a-f0-9-]+)(\/ping)?$/.exec(pathname);
    if (m) {
      const id = m[1]!;
      if (m[2] && req.method === 'POST') {
        const ok = osc.ping(id, ++pingCounter);
        json(res, ok ? 200 : 404, ok ? { sent: pingCounter } : { error: 'no such target' }); return true;
      }
      if (req.method === 'PATCH') {
        const t = targets.update(id, (await readJson(req)) as Record<string, unknown>);
        json(res, t ? 200 : 404, t ?? { error: 'no such target or invalid patch' }); return true;
      }
      if (req.method === 'DELETE') { json(res, targets.remove(id) ? 204 : 404, {}); return true; }
    }
    json(res, 404, { error: 'unknown api route' });
  } catch (err) {
    json(res, 400, { error: (err as Error).message });
  }
  return true;
}

async function onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'https://x');
  const pathname = decodeURIComponent(url.pathname);
  if (ingest.handlePost(req, res, pathname, url.searchParams)) return;
  if (await handleApi(req, res, pathname)) return;
  if (staticHandler(req, res, pathname)) return;
  if (!existsSync(config.clientDir)) {
    res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('client not built yet — run `npm run build` or wait for `vite build --watch`');
    return;
  }
  notFound(res);
}

function onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, allowPhones: boolean): void {
  const pathname = new URL(req.url ?? '/', 'https://x').pathname;
  const route =
    pathname === '/ws' && allowPhones ? ingest.wss
    : pathname === '/feed' ? feed.wss
    : pathname === '/vision' ? vision.wss
    : pathname === '/monitor-ws' ? monitor.wss
    : null;
  if (!route) { socket.destroy(); return; }
  route.handleUpgrade(req, socket, head, (ws) => route.emit('connection', ws, req));
}

// --- listen -------------------------------------------------------------------

const https = createHttpsServer({ key: credentials.key, cert: credentials.cert }, (req, res) => { void onRequest(req, res); });
https.on('upgrade', (req, socket, head) => onUpgrade(req, socket, head, true));

// Plain HTTP serves the dashboard, its API and assets — the Mac needs no
// sensors, so it needs no certificate warning either. The phone app itself
// redirects to HTTPS, because without it there are no sensors.
const http = createHttpServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  const pathname = decodeURIComponent(url.pathname);
  const host = (req.headers.host ?? 'localhost').replace(/:\d+$/, '');
  // `localhost` is a secure context even over HTTP, so the phone page can be
  // developed here without a certificate; a phone on the LAN gets redirected.
  const phonePage = (pathname === '/' || pathname === '/index.html') && host !== 'localhost' && host !== '127.0.0.1';
  if (!phonePage) {
    void (async () => {
      if (await handleApi(req, res, pathname)) return;
      if (staticHandler(req, res, pathname)) return;
      notFound(res);
    })();
    return;
  }
  res.writeHead(302, { Location: `https://${host}:${config.httpsPort}${pathname}${url.search}` });
  res.end();
});
// Plain-HTTP upgrades: feed and monitor only — phones must come over TLS.
http.on('upgrade', (req, socket, head) => onUpgrade(req, socket, head, false));

// The Mac changes network — hotspot at home, the venue's Wi-Fi, its own
// hotspot for the show — and every time the QR code and the certificate
// would go stale. So the interfaces are polled, and on a change the
// certificate is re-issued and swapped into the live server (no restart,
// phones already connected stay connected) and the dashboards get the new QR.
function watchAddresses(): void {
  setInterval(() => {
    const now = lanAddresses();
    const nowIps = now.map((a) => a.address);
    if (nowIps.join(',') === ips.join(',')) return;
    addresses = now;
    ips = nowIps;
    const next = loadOrCreateCertificate(config.certDir, ips);
    https.setSecureContext({ key: next.key, cert: next.cert });
    const nextUrls = toUrls(ips);
    monitor.setAddresses(nextUrls, nextUrls[0] ?? `https://localhost:${config.httpsPort}`);
    log(`network changed → ${nextUrls.join(', ') || 'no LAN address'}${next.regenerated ? ' (new certificate)' : ''}`);
  }, 3000);
}

https.listen(config.httpsPort, '0.0.0.0', () => {
  http.listen(config.httpPort, '0.0.0.0', async () => {
    registry.start();
    swarm.start();
    global.start();
    mix.start();
    monitor.start();
    osc.start();
    queen.start();
    // The crown on the OSC side: an event when it moves, and once a second with the roster.
    let lastQueen = settings.current.queenUid;
    let lastRunning = settings.current.running;
    settings.onChange(() => {
      wall.setRunning(settings.current.running);
      if (settings.current.running !== lastRunning) { lastRunning = settings.current.running; log(lastRunning ? 'started' : 'paused'); }
      const uid = settings.current.queenUid;
      if (uid === lastQueen) return;
      lastQueen = uid;
      osc.queen(uid);
      wall.setQueen(uid);
      const d = registry.list().find((x) => x.uid === uid);
      log(uid ? `queen: #${d?.slot ?? '?'} ${d?.name ? `"${d.name}" ` : ''}(${uid})` : 'queen: none');
    });
    watchAddresses();

    console.log('');
    console.log('  HIVE — swarm audio backend');
    console.log('');
    for (const a of addresses) console.log(`  phones:   https://${a.address}:${config.httpsPort}   (${a.iface})`);
    if (addresses.length === 0) console.log('  phones:   no LAN address found — are you on Wi-Fi?');
    console.log(`  monitor:  http://localhost:${config.httpPort}/monitor   (laptop: config + devices)`);
    console.log(`  wall:     http://localhost:${config.httpPort}/wall      (projector: QR + visuals)`);
    console.log(`  feed:     ws://${ips[0] ?? 'localhost'}:${config.httpPort}/feed`);
    console.log(`  osc →     ${targets.all().map((t) => `${t.host}:${t.port}${t.enabled ? '' : ' (off)'}`).join(', ')}`);
    console.log('');
    console.log(await QRCode.toString(qrUrl, { type: 'terminal', small: true }));

    settings.applyAll();
    if (store.settings.simulate > 0) log(`simulating ${store.settings.simulate} device(s)`);
  });
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    log('shutting down');
    registry.stop(); swarm.stop(); monitor.stop(); osc.close();
    https.close(); http.close();
    process.exit(0);
  });
}

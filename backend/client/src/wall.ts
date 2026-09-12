//
//  wall.ts
//  HIVE (client, wall)
//
//  The projected page: the QR code to join, and the swarm, alive.
//
//  Nothing here is configurable on purpose — configuration is /monitor, on the
//  laptop. This page is what the room sees: a canvas full of visuals fed by
//  the raw feed at 60 Hz, a QR panel in the corner, and the device count.
//  Double-click for fullscreen; the cursor hides itself.
//
//  To add a visual: implement `Visual` (visuals/visual.ts), add it to VISUALS,
//  and switch with the number keys.
//

import './theme.css';
import QRCode from 'qrcode';
import { el, slotColour } from './dom';
import { Bees } from './visuals/bees';
import type { Visual } from './visuals/visual';
import { wifiQrText } from '../../shared/types';
import type { FeedMessage, MonitorHello, MonitorMessage, MonitorState } from '../../shared/types';

const VISUALS: { name: string; make: () => Visual }[] = [
  { name: 'bees', make: () => new Bees() },
];

const root = document.getElementById('app')!;
const canvas = document.getElementById('scene') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const wsScheme = location.protocol === 'https:' ? 'wss' : 'ws';

let hello: MonitorHello | null = null;
let state: MonitorState | null = null;
let visual: Visual = VISUALS[0]!.make();
const colourCache = new Map<number, string>();

/** Every 100 ms: where everyone is, so the phones can draw the swarm too. */
let posting = false;
setInterval(() => {
  if (posting || !visual.snapshot) return;
  posting = true;
  void fetch('/api/wall', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ bees: visual.snapshot() }) })
    .catch(() => undefined).finally(() => { posting = false; });
}, 100);

/** The wall tells the server who flew into the queen. */
function crown(uid: string): void {
  void fetch('/api/settings', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ queenUid: uid }) });
}

// --- panels -------------------------------------------------------------------

const refs = {
  wifi: el('div', { class: 'wall-corner bottom-left card wall-join wall-wifi', hidden: true }),
  wifiQr: el('div', { class: 'qr' }),
  wifiName: el('div', { class: 'url' }),
  join: el('div', { class: 'wall-corner bottom-left card wall-join' }),
  joinLabel: el('div', { class: 'section-label', text: 'join · 参加' }),
  qr: el('div', { class: 'qr' }),
  url: el('div', { class: 'url' }),
  count: el('div', { class: 'wall-count', text: '0' }),
  paused: el('div', { class: 'note', text: 'gathering · sammeln · 集合中', hidden: true }),
  swarm: el('div', { class: 'wall-swarm' }),
};

root.append(
  el('div', { class: 'wall-corner top-left' },
    el('h1', { class: 'wall-title', text: 'HIVE' }),
    el('div', { class: 'note', text: 'swarm audio' }),
  ),
  el('div', { class: 'wall-corner top-right' }, refs.count, el('div', { class: 'note', text: 'in the swarm · im schwarm · 参加中' }), refs.paused),
  refs.wifi,
  refs.join,
  el('div', { class: 'wall-corner bottom-right' }, refs.swarm),
);
refs.join.append(
  refs.joinLabel,
  refs.qr,
  refs.url,
);

// Slot colours resolved once from the stylesheet, since canvas cannot read CSS variables.
function colour(slot: number): string {
  let c = colourCache.get(slot);
  if (!c) {
    const probe = el('span', { style: `color:${slotColour(slot)}` });
    document.body.append(probe);
    c = getComputedStyle(probe).color;
    probe.remove();
    colourCache.set(slot, c);
  }
  return c;
}

// --- sockets -------------------------------------------------------------------

function connectMonitor(): void {
  const ws = new WebSocket(`${wsScheme}://${location.host}/monitor-ws`);
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data as string) as MonitorMessage;
    if (msg.type === 'hello') {
      if (hello && hello.bootId !== msg.bootId) { location.reload(); return; }
      hello = msg; drawQr();
    }
    else { state = msg; drawState(); }
  };
  ws.onclose = () => setTimeout(connectMonitor, 1500);
}

function connectFeed(): void {
  const ws = new WebSocket(`${wsScheme}://${location.host}/feed`);
  ws.onmessage = (e) => visual.feed(JSON.parse(e.data as string) as FeedMessage);
  ws.onclose = () => setTimeout(connectFeed, 1500);
}

function drawQr(): void {
  if (!hello) return;
  const c = document.createElement('canvas');
  refs.qr.replaceChildren(c);
  void QRCode.toCanvas(c, hello.qrUrl, { width: 150, margin: 0, color: { dark: '#000000', light: '#ffffff' } });
  refs.url.textContent = hello.qrUrl;
}

let wifiDrawn = '';
function drawWifi(): void {
  if (!state) return;
  const { wifiSsid, wifiPassword, wifiHotspot, wallWifiCode, wallJoinCode } = state.settings;
  const text = wifiSsid && wallWifiCode ? wifiQrText(wifiSsid, wifiPassword) : '';
  refs.join.hidden = !wallJoinCode;
  if (text + wifiHotspot === wifiDrawn) return;
  wifiDrawn = text + wifiHotspot;
  refs.wifi.hidden = !text;
  document.body.classList.toggle('has-wifi', !!text);
  refs.joinLabel.textContent = text ? '2 · join · 参加' : 'join · 参加';
  if (!text) return;
  refs.wifi.replaceChildren(
    el('div', { class: 'section-label', text: wifiHotspot ? '1 · hotspot' : '1 · wi-fi' }),
    refs.wifiQr,
    refs.wifiName,
  );
  const c = document.createElement('canvas');
  refs.wifiQr.replaceChildren(c);
  void QRCode.toCanvas(c, text, { width: 150, margin: 0, color: { dark: '#000000', light: '#ffffff' } });
  // name and password in words too, for whoever would rather type
  refs.wifiName.replaceChildren(
    el('div', {}, el('span', { class: 'k', text: 'wi-fi  ' }), wifiSsid),
    wifiPassword ? el('div', {}, el('span', { class: 'k', text: 'password  ' }), wifiPassword) : '',
  );
}

function drawState(): void {
  if (!state) return;
  drawWifi();
  refs.paused.hidden = state.settings.running;
  refs.count.textContent = String(state.swarm.count);
  refs.swarm.replaceChildren(
    stat('energy', state.swarm.energy.toFixed(1)),
    stat('motion', state.swarm.motion.toFixed(0)),
    stat('sync', state.swarm.sync.toFixed(2)),
    stat('tempo', state.global.tempo > 0 ? `${state.global.tempo.toFixed(1)}` : '—'),
    stat('coherence', state.global.coherence.toFixed(2)),
    ...(state.vision.connected ? [stat('crowd', state.vision.flowEnergy.toFixed(2)), stat('beat', state.vision.beat > 0 ? state.vision.beat.toFixed(1) : '—')] : []),
  );
}

const stat = (k: string, v: string): HTMLElement =>
  el('div', { class: 'wall-stat' }, el('span', { class: 'v', text: v }), el('span', { class: 'k', text: k }));

// --- canvas & clock ----------------------------------------------------------------

function resize(): void {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.floor(window.innerWidth * dpr);
  canvas.height = Math.floor(window.innerHeight * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  visual.resize?.(window.innerWidth, window.innerHeight);
}
window.addEventListener('resize', resize);
resize();

let last = performance.now();
const started = last;
function frame(now: number): void {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
  visual.draw({ ctx, width: window.innerWidth, height: window.innerHeight, dt, time: (now - started) / 1000, colour, queen: state?.settings.queenUid ?? '', crown, running: state?.settings.running ?? false, round: state?.settings.round ?? 0, coupling: { on: state?.settings.camCoupling ?? false, strength: state?.settings.camStrength ?? 0 }, species: state?.settings.species ?? 'bees', queenHidden: state?.settings.queenHidden ?? false });
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// --- presentation niceties ------------------------------------------------------

document.addEventListener('dblclick', () => {
  if (document.fullscreenElement) void document.exitFullscreen();
  else void document.documentElement.requestFullscreen();
});

let cursorTimer = 0;
document.addEventListener('mousemove', () => {
  document.body.classList.remove('idle');
  clearTimeout(cursorTimer);
  cursorTimer = window.setTimeout(() => document.body.classList.add('idle'), 2500);
});

document.addEventListener('keydown', (e) => {
  const n = Number(e.key);
  const entry = VISUALS[n - 1];
  if (entry) { visual = entry.make(); resize(); connectFeed(); }
  if (e.key === 'h') root.classList.toggle('hidden-panels');
});

connectMonitor();
connectFeed();

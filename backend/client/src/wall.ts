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
  joinLabel: el('div', { class: 'section-label', text: 'join · mitmachen · 参加' }),
  qr: el('div', { class: 'qr' }),
  url: el('div', { class: 'url' }),
  count: el('div', { class: 'wall-count', text: '0' }),
  swarm: el('div', { class: 'wall-swarm' }),
};

root.append(
  el('div', { class: 'wall-corner top-left' },
    el('h1', { class: 'wall-title', text: 'HIVE' }),
    el('div', { class: 'note', text: 'swarm audio' }),
  ),
  el('div', { class: 'wall-corner top-right' }, refs.count, el('div', { class: 'note', text: 'in the swarm · im schwarm · 参加中' })),
  refs.wifi,
  el('div', { class: 'wall-corner bottom-left card wall-join' },
    refs.joinLabel,
    refs.qr,
    refs.url,
    el('div', { class: 'note wall-steps', text: 'scan · accept the certificate warning · tap join.' }),
    el('div', { class: 'note wall-steps', text: 'scannen · zertifikatswarnung bestätigen · beitreten tippen.' }),
    el('div', { class: 'note wall-steps', lang: 'ja', text: 'スキャン · 証明書の警告で「このWebサイトを閲覧」 · 「群れに参加する」をタップ' }),
  ),
  el('div', { class: 'wall-corner bottom-right' }, refs.swarm),
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
  void QRCode.toCanvas(c, hello.qrUrl, { width: 260, margin: 0, color: { dark: '#000000', light: '#ffffff' } });
  refs.url.textContent = hello.qrUrl;
}

let wifiDrawn = '';
function drawWifi(): void {
  if (!state) return;
  const { wifiSsid, wifiPassword, wifiHotspot } = state.settings;
  const text = wifiSsid ? wifiQrText(wifiSsid, wifiPassword) : '';
  if (text + wifiHotspot === wifiDrawn) return;
  wifiDrawn = text + wifiHotspot;
  refs.wifi.hidden = !text;
  document.body.classList.toggle('has-wifi', !!text);
  refs.joinLabel.textContent = text ? '2 · join · mitmachen · 参加' : 'join · mitmachen · 参加';
  if (!text) return;
  refs.wifi.replaceChildren(
    el('div', { class: 'section-label', text: wifiHotspot ? '1 · hotspot first · zuerst hotspot · まずホットスポット' : '1 · wi-fi first · zuerst wlan · まずWi-Fi' }),
    refs.wifiQr,
    refs.wifiName,
    el('div', { class: 'note wall-steps', text: 'scan with the camera · join · then the code on the right' }),
    el('div', { class: 'note wall-steps', text: 'mit der kamera scannen · verbinden · dann den code rechts' }),
    el('div', { class: 'note wall-steps', lang: 'ja', text: 'カメラで読み取る · 接続 · 次に右のコード' }),
  );
  const c = document.createElement('canvas');
  refs.wifiQr.replaceChildren(c);
  void QRCode.toCanvas(c, text, { width: 260, margin: 0, color: { dark: '#000000', light: '#ffffff' } });
  refs.wifiName.textContent = wifiSsid;
}

function drawState(): void {
  if (!state) return;
  drawWifi();
  refs.count.textContent = String(state.swarm.count);
  refs.swarm.replaceChildren(
    stat('energy', state.swarm.energy.toFixed(1)),
    stat('motion', state.swarm.motion.toFixed(0)),
    stat('sync', state.swarm.sync.toFixed(2)),
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
  visual.draw({ ctx, width: window.innerWidth, height: window.innerHeight, dt, time: (now - started) / 1000, colour, queen: state?.settings.queenUid ?? '', crown });
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

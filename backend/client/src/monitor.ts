//
//  monitor.ts
//  HIVE (client, dashboard)
//
//  The Mac's view: the QR code people scan, who is in the swarm, where the
//  OSC goes, and a test-tone switch that sonifies the swarm right here.
//
//  Two sockets. `/monitor-ws` brings a 10 Hz snapshot for the table and the
//  target list; `/feed` is opened only while test tones run, because it
//  carries every sample of every phone.
//

import './theme.css';
import QRCode from 'qrcode';
import { el, setSigned, signedBar, slotColour } from './dom';
import { ActivityLog } from './log';
import { Tones } from './tones';
import type { DeviceInfo, FeedMessage, MonitorHello, MonitorMessage, MonitorState, OscTarget } from '../../shared/types';

const root = document.getElementById('app')!;
const log = new ActivityLog(document.getElementById('log')!);
const tones = new Tones();
const wsScheme = location.protocol === 'https:' ? 'wss' : 'ws';

let hello: MonitorHello | null = null;
let state: MonitorState | null = null;
let feed: WebSocket | null = null;

// --------------------------------------------------------------------------- //
// Monitor socket
// --------------------------------------------------------------------------- //

function connectMonitor(): void {
  const ws = new WebSocket(`${wsScheme}://${location.host}/monitor-ws`);
  ws.onopen = () => log.step('monitor connected');
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data as string) as MonitorMessage;
    if (msg.type === 'hello') { hello = msg; buildPage(); }
    else { state = msg; updateState(); }
  };
  ws.onclose = () => { log.warn('monitor disconnected — retrying'); setTimeout(connectMonitor, 1500); };
}

// --------------------------------------------------------------------------- //
// API
// --------------------------------------------------------------------------- //

async function api(method: string, path: string, body?: unknown): Promise<Response> {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    log.fail(`${method} ${path}: ${res.status} ${text}`);
  }
  return res;
}

// --------------------------------------------------------------------------- //
// Page skeleton (built once, on hello)
// --------------------------------------------------------------------------- //

const refs = {
  count: el('div', { class: 'big-number', text: '0' }, el('small', { text: 'devices' })),
  energy: el('div', { class: 'big-number', text: '0.0' }, el('small', { text: 'energy m/s²' })),
  motion: el('div', { class: 'big-number', text: '0' }, el('small', { text: 'motion °/s' })),
  sync: el('div', { class: 'big-number', text: '1.00' }, el('small', { text: 'sync' })),
  qr: el('div', { class: 'qr' }),
  urls: el('div', { class: 'stack', style: 'gap:6px' }),
  targets: el('div', { class: 'stack', style: 'gap:10px' }),
  feedInfo: el('p', { class: 'note' }),
  tbody: el('tbody'),
  tonesButton: el('button', { class: 'pill quiet', text: 'Test tones: off' }),
  volume: el('input', { type: 'range', min: 0, max: 1, step: 0.01, value: 0.5, style: 'width:120px' }),
};

function buildPage(): void {
  if (!hello) return;

  // QR code for the first LAN URL, drawn locally — the venue may be offline.
  const canvas = document.createElement('canvas');
  refs.qr.replaceChildren(canvas);
  QRCode.toCanvas(canvas, hello.qrUrl, { width: 320, margin: 0, color: { dark: '#000000', light: '#ffffff' } })
    .catch((err: Error) => log.fail(`QR: ${err.message}`));
  refs.urls.replaceChildren(
    ...hello.urls.map((u) => el('div', { class: 'url', text: u })),
    el('p', { class: 'note', text: `Dashboard: http://localhost:${hello.httpPort}/monitor · Raw feed: ws://<this-mac>:${hello.httpPort}/feed` }),
  );

  // Add-target form.
  const spec = el('input', { type: 'text', placeholder: 'host:port  e.g. 192.168.2.14:9001', autocomplete: 'off' });
  const label = el('input', { type: 'text', placeholder: 'label (e.g. Pd laptop)', autocomplete: 'off', style: 'max-width:200px' });
  const add = el('button', { class: 'pill small', text: 'Add' });
  const submit = async (): Promise<void> => {
    if (!spec.value.trim()) return;
    const res = await api('POST', '/api/targets', { spec: spec.value.trim(), label: label.value.trim() });
    if (res.ok) { spec.value = ''; label.value = ''; log.step('target added'); }
  };
  add.onclick = () => { void submit(); };
  spec.onkeydown = (e) => { if (e.key === 'Enter') void submit(); };

  refs.tonesButton.onclick = () => { void toggleTones(); };
  refs.volume.oninput = () => tones.setVolume(Number(refs.volume.value));

  root.replaceChildren(el('main', { class: 'wide stack' },
    el('div', { class: 'row between wrap' },
      el('h1', { text: 'HIVE · monitor' }),
      el('div', { class: 'row wrap' }, refs.count, refs.energy, refs.motion, refs.sync),
    ),
    el('div', { class: 'grid-2' },
      el('div', { class: 'card stack' },
        el('div', { class: 'section-label', text: 'scan to join' }),
        refs.qr,
        refs.urls,
        el('div', { class: 'section-label', text: 'certificate warning — tap through once' }),
        el('div', { class: 'grid-2' },
          el('div', {}, el('strong', { text: 'iPhone (Safari)' }), el('ol', { class: 'steps' },
            el('li', { text: '“This Connection Is Not Private” → Show Details' }),
            el('li', { text: 'tap “visit this website”, then “Visit Website”' }),
            el('li', { text: 'tap Join → Allow motion access' }))),
          el('div', {}, el('strong', { text: 'Android (Chrome)' }), el('ol', { class: 'steps' },
            el('li', { text: '“Your connection is not private” → Advanced' }),
            el('li', { text: 'tap “Proceed to … (unsafe)”' }),
            el('li', { text: 'tap Join' }))),
        ),
      ),
      el('div', { class: 'stack' },
        el('div', { class: 'card stack' },
          el('div', { class: 'section-label', text: 'osc targets (udp)' }),
          refs.targets,
          el('div', { class: 'row wrap' }, el('div', { class: 'grow' }, spec), label, add),
          refs.feedInfo,
        ),
        el('div', { class: 'card stack' },
          el('div', { class: 'section-label', text: 'debug sound on this mac' }),
          el('div', { class: 'row wrap' }, refs.tonesButton, el('span', { class: 'note', text: 'volume' }), refs.volume),
          el('p', { class: 'note', text: 'One sine per phone. Tilt bends the pitch, turning opens the volume, left/right pans. If you hear it, the whole chain works.' }),
        ),
      ),
    ),
    el('div', { class: 'card' },
      el('div', { class: 'section-label', text: 'swarm' }),
      el('div', { class: 'table-wrap' }, el('table', {},
        el('thead', {}, el('tr', {},
          el('th', { text: '#' }), el('th', { text: 'name' }), el('th', { text: 'platform' }), el('th', { text: 'link' }),
          el('th', { text: 'hz' }), el('th', { text: 'acc x y z · gyro x y z' }), el('th', { text: '|acc|' }), el('th', { text: '|gyro|' }),
        )),
        refs.tbody,
      )),
    ),
    el('div', { class: 'credit', text: 'HIVE · Music & AI Hackathon 2026' }),
  ));
  if (state) updateState();
}

// --------------------------------------------------------------------------- //
// State updates (10 Hz)
// --------------------------------------------------------------------------- //

const rows = new Map<number, { tr: HTMLTableRowElement; cells: HTMLElement[]; bars: HTMLElement[] }>();

function updateState(): void {
  if (!state || !hello) return;
  refs.count.firstChild!.textContent = String(state.swarm.count);
  refs.energy.firstChild!.textContent = state.swarm.energy.toFixed(1);
  refs.motion.firstChild!.textContent = state.swarm.motion.toFixed(0);
  refs.sync.firstChild!.textContent = state.swarm.sync.toFixed(2);
  refs.feedInfo.textContent = `${state.feedSubscribers} raw feed subscriber${state.feedSubscribers === 1 ? '' : 's'}`;
  renderTargets(state.targets);
  renderDevices(state.devices);
}

function renderTargets(targets: OscTarget[]): void {
  refs.targets.replaceChildren(...targets.map((t) => {
    const toggle = el('button', { class: `pill small ${t.enabled ? 'on' : 'quiet'}`, text: t.enabled ? 'on' : 'off' });
    toggle.onclick = () => { void api('PATCH', `/api/targets/${t.id}`, { enabled: !t.enabled }); };
    const ping = el('button', { class: 'pill small quiet', text: 'Ping' });
    ping.onclick = () => { void api('POST', `/api/targets/${t.id}/ping`).then(() => log.step(`ping → ${t.host}:${t.port}`)); };
    const remove = el('button', { class: 'pill small quiet', text: '×', title: 'remove' });
    remove.onclick = () => { void api('DELETE', `/api/targets/${t.id}`); };
    return el('div', { class: 'row wrap' },
      toggle,
      el('div', { class: 'grow' },
        el('div', { class: 'url', text: `${t.host}:${t.port}` }),
        el('div', { class: 'note', text: [t.label, `${t.sent ?? 0} sent`, t.error ? `⚠ ${t.error}` : ''].filter(Boolean).join(' · ') }),
      ),
      ping, remove,
    );
  }));
}

function renderDevices(devices: DeviceInfo[]): void {
  const seen = new Set<number>();
  for (const d of devices) {
    seen.add(d.slot);
    let row = rows.get(d.slot);
    if (!row) {
      const bars = Array.from({ length: 6 }, (_, i) => signedBar(i >= 3 ? 'gyro' : ''));
      const cells = [
        el('td', { class: 'num' }, el('span', { class: 'row' }, el('span', { class: 'dot' }), `${d.slot}`)),
        el('td'), el('td'), el('td'), el('td', { class: 'num' }),
        el('td', {}, el('div', { class: 'mini' }, ...bars)),
        el('td', { class: 'num' }), el('td', { class: 'num' }),
      ];
      const tr = el('tr', {}, ...cells);
      tr.style.setProperty('--slot', slotColour(d.slot));
      row = { tr, cells, bars };
      rows.set(d.slot, row);
    }
    const c = row.cells;
    c[1]!.textContent = d.name || '—';
    c[2]!.textContent = d.platform;
    c[3]!.textContent = d.transport.toUpperCase();
    c[4]!.textContent = d.hz.toFixed(0);
    if (d.last) {
      const { acc, gyro } = d.last;
      [...acc, ...gyro].forEach((v, i) => setSigned(row!.bars[i]!, v, i < 3 ? 20 : 360));
      c[6]!.textContent = Math.hypot(...acc).toFixed(1);
      c[7]!.textContent = Math.hypot(...gyro).toFixed(0);
    }
  }
  for (const [slot, row] of rows) if (!seen.has(slot)) { row.tr.remove(); rows.delete(slot); }
  // Keep slot order without rebuilding: append in order is a no-op when already sorted.
  for (const d of devices) refs.tbody.append(rows.get(d.slot)!.tr);
}

// --------------------------------------------------------------------------- //
// Test tones
// --------------------------------------------------------------------------- //

async function toggleTones(): Promise<void> {
  if (tones.running) {
    tones.stop();
    feed?.close(); feed = null;
    refs.tonesButton.textContent = 'Test tones: off';
    refs.tonesButton.classList.remove('on');
    log.step('test tones off');
    return;
  }
  await tones.start();
  tones.setVolume(Number(refs.volume.value));
  feed = new WebSocket(`${wsScheme}://${location.host}/feed`);
  feed.onmessage = (e) => tones.handle(JSON.parse(e.data as string) as FeedMessage);
  feed.onclose = () => { if (tones.running) log.warn('feed closed'); };
  refs.tonesButton.textContent = 'Test tones: on';
  refs.tonesButton.classList.add('on');
  log.step('test tones on — one sine per phone');
}

connectMonitor();

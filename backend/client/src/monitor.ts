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
import type { DeviceInfo, FeedMessage, MonitorHello, MonitorMessage, MonitorState, OscTarget, Settings } from '../../shared/types';
<<<<<<< HEAD
import { SETTINGS_LIMITS, wifiQrText } from '../../shared/types';
import { EVENT_MESSAGES, OSC_SCHEMA_VERSION, SAMPLE_FIELDS, SWARM_FIELDS, typeTags } from '../../shared/osc-schema';
=======
import { SETTINGS_LIMITS } from '../../shared/types';
>>>>>>> 791460b3b24265c8bbf40de2d4abdf0497736a94

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
    if (msg.type === 'hello') {
<<<<<<< HEAD
      // The server restarted since this page loaded: its client build may
      // have changed too, and a stale page against a new server misbehaves.
      if (hello && hello.bootId !== msg.bootId) { location.reload(); return; }
=======
>>>>>>> 791460b3b24265c8bbf40de2d4abdf0497736a94
      const rebuild = !hello;
      hello = msg;
      if (rebuild) buildPage();
      else { drawAddresses(); log.step(`network changed → ${msg.qrUrl}`); }
    }
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
<<<<<<< HEAD
  queenNote: el('span', { class: 'note', text: 'none' }),
  startButton: el('button', { class: 'pill', text: 'start' }),
  resetButton: el('button', { class: 'pill quiet', text: 'reset' }),
  roundNote: el('span', { class: 'note' }),
  wifiCard: el('div', { class: 'stack', hidden: true }),
  wifiQr: el('div', { class: 'qr' }),
  wifiName: el('div', { class: 'url' }),
  queenClear: el('button', { class: 'pill small quiet', text: 'none', title: 'no queen; the next one is crowned after queen after seconds' }),
  volume: el('input', { type: 'range', min: 0, max: 1, step: 0.01, value: 0.5, style: 'width:120px' }),
  settingsCard: el('div', { class: 'card stack' }),
  protocolCard: el('div', { class: 'card stack' }),
};

// --- protocol card: rendered from shared/osc-schema.ts, the same source docs/OSC.md is generated from.
function buildProtocolCard(): void {
  const fieldRows = (fields: typeof SAMPLE_FIELDS) => el('table', { class: 'schema' },
    el('thead', {}, el('tr', {}, el('th', { text: '#' }), el('th', { text: 'field' }), el('th', { text: 'type' }), el('th', { text: 'unit' }), el('th', { text: 'meaning' }))),
    el('tbody', {}, ...fields.map((f, i) => el('tr', {},
      el('td', { class: 'num', text: String(i + 1) }), el('td', {}, el('code', { text: f.name })), el('td', { class: 'num', text: f.type }),
      el('td', { text: f.unit || '—' }), el('td', { class: 'note', text: f.description }),
    ))),
  );
  refs.protocolCard.replaceChildren(
    el('div', { class: 'row between wrap' },
      el('div', { class: 'section-label', text: `osc protocol · version ${OSC_SCHEMA_VERSION}` }),
      el('a', { href: 'https://github.com/emilpasqualini/SwarmAudio/blob/main/backend/docs/OSC.md', target: '_blank', class: 'note', text: 'docs/OSC.md ↗' }),
    ),
    el('p', { class: 'note', text: 'Every enabled target gets the same stream. Identity: uid (stable per phone, 8 chars) and slot (1..N, per session). Fields are only ever appended between versions.' }),
    el('details', { open: true },
      el('summary', { class: 'note', text: `/hive/sample — ${SAMPLE_FIELDS.length} arguments, ~60 Hz per phone · type tags ${typeTags(SAMPLE_FIELDS)}` }),
      el('div', { class: 'table-wrap' }, fieldRows(SAMPLE_FIELDS)),
    ),
    el('details', {},
      el('summary', { class: 'note', text: `/hive/swarm — ${SWARM_FIELDS.length} arguments at the swarm rate · ${typeTags(SWARM_FIELDS)}` }),
      el('div', { class: 'table-wrap' }, fieldRows(SWARM_FIELDS)),
    ),
    el('details', {},
      el('summary', { class: 'note', text: 'events: join · leave · roster · schema · ping' }),
      el('div', { class: 'table-wrap' }, el('table', { class: 'schema' },
        el('tbody', {}, ...EVENT_MESSAGES.map((m) => el('tr', {},
          el('td', {}, el('code', { text: m.address })), el('td', { class: 'note', text: m.args }), el('td', { class: 'note', text: m.when }),
        ))),
      )),
    ),
    el('details', {},
      el('summary', { class: 'note', text: 'receive it in Pd / Max / SuperCollider / Python' }),
      el('pre', { class: 'snippet', text: [
        'Pd:   [netreceive -u -b 9000] → [oscparse] → [list trim] → [route hive] → [route sample] → [unpack f s f f f f f f f f f f f f f f f]',
        '      (examples/hive-receive.pd)',
        'Max:  [udpreceive 9000] → [route /hive/sample] → [unpack i s f f f f f f f f f f f f f f f]',
        "SC:   thisProcess.openUDPPort(9000); OSCdef(\\hive, { |m| m.postln }, '/hive/sample');",
        'Py:   python3 examples/osc_listen.py 9000        (or JSON: examples/feed_client.py ws://<mac>:8080/feed)',
      ].join('\n') }),
    ),
  );
}

// --- settings card: inputs are built once and only refreshed while not focused,
//     so a 10 Hz snapshot never yanks a half-typed number away. -----------------

type NumKey = 'swarmHz' | 'deviceTimeoutMs' | 'simulate' | 'zeroIdleAfter' | 'zeroTau' | 'filterMinCutoff' | 'filterBeta' | 'queenAfter';
type BoolKey = 'oscWide' | 'oscPerField' | 'oscRoster' | 'oscSwarm' | 'wifiHotspot' | 'wallWifiCode' | 'wallJoinCode';
type TextKey = 'wifiSsid' | 'wifiPassword';
const numInputs = new Map<NumKey, HTMLInputElement>();
const textInputs = new Map<TextKey, HTMLInputElement>();
=======
  volume: el('input', { type: 'range', min: 0, max: 1, step: 0.01, value: 0.5, style: 'width:120px' }),
  settingsCard: el('div', { class: 'card stack' }),
};

// --- settings card: inputs are built once and only refreshed while not focused,
//     so a 10 Hz snapshot never yanks a half-typed number away. -----------------

type NumKey = 'swarmHz' | 'deviceTimeoutMs' | 'simulate';
type BoolKey = 'oscPerSample' | 'oscMag' | 'oscSwarm';
const numInputs = new Map<NumKey, HTMLInputElement>();
>>>>>>> 791460b3b24265c8bbf40de2d4abdf0497736a94
const boolButtons = new Map<BoolKey, HTMLButtonElement>();

async function patchSettings(patch: Partial<Settings>): Promise<void> {
  const res = await api('PATCH', '/api/settings', patch);
  if (res.ok) log.step(`settings: ${Object.entries(patch).map(([k, v]) => `${k}=${v}`).join(', ')}`);
}

<<<<<<< HEAD
function numberSetting(key: NumKey, label: string, hint: string, step = 1): HTMLElement[] {
  const { min, max } = SETTINGS_LIMITS[key];
  const input = el('input', { type: 'number', min, max, step });
=======
function numberSetting(key: NumKey, label: string, hint: string): HTMLElement[] {
  const { min, max } = SETTINGS_LIMITS[key];
  const input = el('input', { type: 'number', min, max, step: 1 });
>>>>>>> 791460b3b24265c8bbf40de2d4abdf0497736a94
  const commit = (): void => {
    const v = Number(input.value);
    if (!Number.isFinite(v) || v === state?.settings[key]) return;
    void patchSettings({ [key]: v });
  };
  input.onchange = commit;
  input.onkeydown = (e) => { if (e.key === 'Enter') { commit(); input.blur(); } };
  numInputs.set(key, input);
  return [el('span', { class: 'k', text: label }), el('span', { class: 'row' }, input, el('span', { class: 'hint', text: hint }))];
}

<<<<<<< HEAD
function textSetting(key: TextKey, label: string, hint: string, placeholder = ''): HTMLElement[] {
  const input = el('input', { type: 'text', placeholder, autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
  const commit = (): void => { if (input.value !== state?.settings[key]) void patchSettings({ [key]: input.value }); };
  input.onchange = commit;
  input.onkeydown = (e) => { if (e.key === 'Enter') { commit(); input.blur(); } };
  textInputs.set(key, input);
  return [el('span', { class: 'k', text: label }), el('span', { class: 'row' }, input, el('span', { class: 'hint', text: hint }))];
}

=======
>>>>>>> 791460b3b24265c8bbf40de2d4abdf0497736a94
function boolSetting(key: BoolKey, label: string, hint: string): HTMLElement[] {
  const button = el('button', { class: 'pill small quiet', text: 'off' });
  button.onclick = () => { void patchSettings({ [key]: !state?.settings[key] }); };
  boolButtons.set(key, button);
  return [el('span', { class: 'k', text: label }), el('span', { class: 'row' }, button, el('span', { class: 'hint', text: hint }))];
}

function buildSettingsCard(h: MonitorHello): void {
  refs.settingsCard.replaceChildren(
    el('div', { class: 'section-label', text: 'settings' }),
    el('div', { class: 'settings' },
      ...numberSetting('simulate', 'fake phones', '0 = off; virtual devices through the real pipeline'),
      ...numberSetting('swarmHz', 'swarm rate', 'Hz for /hive/swarm/*'),
      ...numberSetting('deviceTimeoutMs', 'device timeout', 'ms of silence before a phone is dropped'),
<<<<<<< HEAD
      el('span', { class: 'k', text: 'queen' }),
      el('span', { class: 'row' }, refs.queenNote, refs.queenClear),
      ...numberSetting('queenAfter', 'queen after', 's without a queen until the phone that moved most is crowned'),
      ...numberSetting('filterMinCutoff', 'filter: min cutoff', 'Hz — One-Euro cutoff at rest; lower = calmer rel when still', 0.05),
      ...numberSetting('filterBeta', 'filter: beta', 'how much the cutoff rises with speed of change; higher = snappier gestures', 0.05),
      ...numberSetting('zeroIdleAfter', 'zero: rest before', 's at rest before the zero starts following the resting tilt', 0.1),
      ...numberSetting('zeroTau', 'zero: slide time', 's — time constant of the zero sliding over; rel → 0 at rest', 0.1),
      ...boolSetting('wifiHotspot', 'iphone hotspot', 'on: the phones join an iPhone personal hotspot (name + password are under settings → personal hotspot on that iPhone; turn on "maximise compatibility"; that iPhone itself cannot join). off: any other wi-fi'),
      ...textSetting('wifiSsid', 'wi-fi name', 'shown as a QR code here and on the wall; macOS hides the SSID from apps, so type it', "Emil's iPhone"),
      ...textSetting('wifiPassword', 'wi-fi password', 'empty = open network'),
      ...boolSetting('wallWifiCode', 'wall: wi-fi code', 'show the wi-fi QR code on the wall — off once everyone is on the network'),
      ...boolSetting('wallJoinCode', 'wall: join code', 'show the join QR code on the wall — off once everyone is in, the bees get the whole wall'),
      ...boolSetting('oscWide', 'osc /hive/sample', 'the wide message: everything per sample, fixed order — see protocol card'),
      ...boolSetting('oscPerField', 'osc per field', '/hive/dev/<slot>/acc · rel · gyro · activity · mag · turn'),
      ...boolSetting('oscRoster', 'osc roster', '/hive/roster + /hive/schema every second'),
      ...boolSetting('oscSwarm', 'osc swarm', '/hive/swarm (wide) + /hive/swarm/count · energy · motion · sync'),
=======
      ...boolSetting('oscPerSample', 'osc acc + gyro', '/hive/dev/<n>/acc and /gyro per sample'),
      ...boolSetting('oscMag', 'osc magnitudes', '/hive/dev/<n>/mag per sample'),
      ...boolSetting('oscSwarm', 'osc swarm', '/hive/swarm/count, energy, motion, sync'),
>>>>>>> 791460b3b24265c8bbf40de2d4abdf0497736a94
      el('span', { class: 'k', text: 'ports' }),
      el('span', { class: 'note', text: `https ${h.httpsPort} (phones) · http ${h.httpPort} (this page, /feed) — set HIVE_HTTPS_PORT / HIVE_HTTP_PORT and restart` }),
      el('span', { class: 'k', text: 'saved to' }),
      el('span', { class: 'note url', text: h.configFile }),
    ),
  );
}

<<<<<<< HEAD
let wifiDrawn = '';
function drawWifiQr(s: Settings): void {
  const text = s.wifiSsid ? wifiQrText(s.wifiSsid, s.wifiPassword) : '';
  if (text === wifiDrawn) return;
  wifiDrawn = text;
  refs.wifiCard.hidden = !text;
  if (!text) return;
  const canvas = document.createElement('canvas');
  refs.wifiQr.replaceChildren(canvas);
  QRCode.toCanvas(canvas, text, { width: 220, margin: 0, color: { dark: '#000000', light: '#ffffff' } })
    .catch((err: Error) => log.fail(`wi-fi QR: ${err.message}`));
  refs.wifiName.textContent = s.wifiSsid;
}

function updateSettings(s: Settings): void {
  refs.startButton.textContent = s.running ? 'pause' : 'start';
  refs.startButton.classList.toggle('on', s.running);
  refs.roundNote.textContent = `round ${s.round} · ${s.running ? 'running' : 'paused'}`;
  for (const [key, input] of textInputs) {
    if (document.activeElement !== input) input.value = s[key];
  }
  drawWifiQr(s);
  const queen = state?.devices.find((d) => d.uid === s.queenUid);
  refs.queenNote.textContent = s.queenUid ? `${queen ? `#${queen.slot} ${queen.name || ''}`.trim() : 'away'} · ${s.queenUid} — ♛ in the table crowns, a bee flying into her takes over` : 'none yet — the phone that moves most is crowned';
  refs.queenClear.hidden = !s.queenUid;
=======
function updateSettings(s: Settings): void {
>>>>>>> 791460b3b24265c8bbf40de2d4abdf0497736a94
  for (const [key, input] of numInputs) {
    if (document.activeElement !== input) input.value = String(s[key]);
  }
  for (const [key, button] of boolButtons) {
<<<<<<< HEAD
    const on = Boolean(s[key]);
=======
    const on = s[key];
>>>>>>> 791460b3b24265c8bbf40de2d4abdf0497736a94
    button.textContent = on ? 'on' : 'off';
    button.classList.toggle('on', on);
    button.classList.toggle('quiet', !on);
  }
}

// QR code for the first LAN URL, drawn locally — the venue may be offline.
// Redrawn whenever the server reports new addresses.
function drawAddresses(): void {
  if (!hello) return;
  const canvas = document.createElement('canvas');
  refs.qr.replaceChildren(canvas);
<<<<<<< HEAD
  QRCode.toCanvas(canvas, hello.qrUrl, { width: 220, margin: 0, color: { dark: '#000000', light: '#ffffff' } })
=======
  QRCode.toCanvas(canvas, hello.qrUrl, { width: 320, margin: 0, color: { dark: '#000000', light: '#ffffff' } })
>>>>>>> 791460b3b24265c8bbf40de2d4abdf0497736a94
    .catch((err: Error) => log.fail(`QR: ${err.message}`));
  refs.urls.replaceChildren(
    ...hello.urls.map((u) => el('div', { class: 'url', text: u })),
    el('p', { class: 'note', text: `Dashboard: http://localhost:${hello.httpPort}/monitor · Raw feed: ws://<this-mac>:${hello.httpPort}/feed` }),
  );
}

function buildPage(): void {
  if (!hello) return;

  drawAddresses();
<<<<<<< HEAD
  refs.wifiCard.replaceChildren(
    el('details', {},
      el('summary', { class: 'section-label', text: 'wi-fi QR code (as on the wall)' }),
      refs.wifiQr,
      refs.wifiName,
    ),
  );
=======
>>>>>>> 791460b3b24265c8bbf40de2d4abdf0497736a94

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
<<<<<<< HEAD
  refs.queenClear.onclick = () => { void patchSettings({ queenUid: '' }); };
  refs.startButton.onclick = () => { void patchSettings({ running: !state?.settings.running }); };
  refs.resetButton.onclick = () => { if (confirm('reset the round? the queen is cleared, everyone re-spawns, and the swarm waits for start.')) void patchSettings({ reset: true } as unknown as Partial<Settings>); };
  refs.volume.oninput = () => tones.setVolume(Number(refs.volume.value));
  buildSettingsCard(hello);
  buildProtocolCard();
=======
  refs.volume.oninput = () => tones.setVolume(Number(refs.volume.value));
  buildSettingsCard(hello);
>>>>>>> 791460b3b24265c8bbf40de2d4abdf0497736a94

  root.replaceChildren(el('main', { class: 'wide stack' },
    el('div', { class: 'row between wrap' },
      el('h1', { text: 'HIVE · monitor' }),
      el('div', { class: 'row wrap' }, refs.count, refs.energy, refs.motion, refs.sync),
    ),
<<<<<<< HEAD
    el('div', { class: 'card row wrap between' },
      el('div', { class: 'row wrap' }, refs.startButton, refs.resetButton, refs.roundNote),
      el('span', { class: 'note', text: 'people can join while paused — bees hover, no queen race, phones say "waiting". start lets it all go; reset clears the queen and re-spawns everyone.' }),
    ),
=======
>>>>>>> 791460b3b24265c8bbf40de2d4abdf0497736a94
    el('div', { class: 'grid-2' },
      el('div', { class: 'card stack' },
        el('div', { class: 'section-label', text: 'scan to join' }),
        refs.qr,
        refs.urls,
<<<<<<< HEAD
        refs.wifiCard,
        el('div', { class: 'section-label', text: 'for the projector' }),
        el('p', { class: 'note' },
          'Open ', el('a', { href: '/wall', target: '_blank', text: `${location.origin}/wall` }),
          ' on the projector — big QR, join steps, live visuals. Double-click for fullscreen, h hides the panels.'),
        el('div', { class: 'section-label', text: 'certificate warning — every phone, once' }),
        el('p', { class: 'note', text: 'iPhone: Show Details → visit this website. Android: Advanced → Proceed. Then Join (iPhone: Allow motion).' }),
=======
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
>>>>>>> 791460b3b24265c8bbf40de2d4abdf0497736a94
      ),
      el('div', { class: 'stack' },
        el('div', { class: 'card stack' },
          el('div', { class: 'section-label', text: 'osc targets (udp)' }),
          refs.targets,
          el('div', { class: 'row wrap' }, el('div', { class: 'grow' }, spec), label, add),
          refs.feedInfo,
        ),
        refs.settingsCard,
        el('div', { class: 'card stack' },
          el('div', { class: 'section-label', text: 'debug sound on this mac' }),
          el('div', { class: 'row wrap' }, refs.tonesButton, el('span', { class: 'note', text: 'volume' }), refs.volume),
          el('p', { class: 'note', text: 'One sine per phone. Tilt bends the pitch, turning opens the volume, left/right pans. If you hear it, the whole chain works.' }),
        ),
      ),
    ),
<<<<<<< HEAD
    refs.protocolCard,
=======
>>>>>>> 791460b3b24265c8bbf40de2d4abdf0497736a94
    el('div', { class: 'card' },
      el('div', { class: 'section-label', text: 'swarm' }),
      el('div', { class: 'table-wrap' }, el('table', {},
        el('thead', {}, el('tr', {},
<<<<<<< HEAD
          el('th', { text: '#' }), el('th', { text: 'name' }), el('th', { text: 'uid' }), el('th', { text: 'platform' }), el('th', { text: 'link' }),
          el('th', { text: 'hz' }), el('th', { text: 'rel x y z · turn x y z' }), el('th', { text: '|rel|' }), el('th', { text: '|turn|' }), el('th', { text: 'act' }), el('th'),
=======
          el('th', { text: '#' }), el('th', { text: 'name' }), el('th', { text: 'platform' }), el('th', { text: 'link' }),
          el('th', { text: 'hz' }), el('th', { text: 'acc x y z · gyro x y z' }), el('th', { text: '|acc|' }), el('th', { text: '|gyro|' }), el('th'),
>>>>>>> 791460b3b24265c8bbf40de2d4abdf0497736a94
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
  updateSettings(state.settings);
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
<<<<<<< HEAD
        el('td'), el('td', { class: 'num' }), el('td'), el('td'), el('td', { class: 'num' }),
        el('td', {}, el('div', { class: 'mini' }, ...bars)),
        el('td', { class: 'num' }), el('td', { class: 'num' }), el('td', { class: 'num' }),
        el('td', {}, (() => {
          const crown = el('button', { class: 'pill small quiet', text: '♛', title: 'make this the queen' });
          crown.onclick = () => { void patchSettings({ queenUid: state?.settings.queenUid === d.uid ? '' : d.uid }); };
          const kick = el('button', { class: 'pill small quiet', text: '×', title: 'drop this device' });
          kick.onclick = () => { void api('POST', '/api/devices/kick', { slot: d.slot }); };
          return el('span', { class: 'row' }, crown, kick);
=======
        el('td'), el('td'), el('td'), el('td', { class: 'num' }),
        el('td', {}, el('div', { class: 'mini' }, ...bars)),
        el('td', { class: 'num' }), el('td', { class: 'num' }),
        el('td', {}, (() => {
          const kick = el('button', { class: 'pill small quiet', text: '×', title: 'drop this device' });
          kick.onclick = () => { void api('POST', '/api/devices/kick', { slot: d.slot }); };
          return kick;
>>>>>>> 791460b3b24265c8bbf40de2d4abdf0497736a94
        })()),
      ];
      const tr = el('tr', {}, ...cells);
      tr.style.setProperty('--slot', slotColour(d.slot));
      row = { tr, cells, bars };
      rows.set(d.slot, row);
    }
    const c = row.cells;
    c[1]!.textContent = d.name || '—';
<<<<<<< HEAD
    c[2]!.textContent = d.uid;
    c[3]!.textContent = d.platform;
    c[4]!.textContent = d.transport.toUpperCase();
    c[5]!.textContent = d.hz.toFixed(0);
    const crown = c[10]!.querySelector('button')!;
    const isQueen = state?.settings.queenUid === d.uid;
    crown.classList.toggle('on', isQueen);
    crown.classList.toggle('quiet', !isQueen);
    if (d.last) {
      const { rel, gyro, activity } = d.last;
      [...rel, ...gyro].forEach((v, i) => setSigned(row!.bars[i]!, v, i < 3 ? 10 : 360));
      c[7]!.textContent = Math.hypot(...rel).toFixed(1);
      c[8]!.textContent = Math.hypot(...gyro).toFixed(0);
      c[9]!.textContent = activity.toFixed(2);
=======
    c[2]!.textContent = d.platform;
    c[3]!.textContent = d.transport.toUpperCase();
    c[4]!.textContent = d.hz.toFixed(0);
    if (d.last) {
      const { acc, gyro } = d.last;
      [...acc, ...gyro].forEach((v, i) => setSigned(row!.bars[i]!, v, i < 3 ? 20 : 360));
      c[6]!.textContent = Math.hypot(...acc).toFixed(1);
      c[7]!.textContent = Math.hypot(...gyro).toFixed(0);
>>>>>>> 791460b3b24265c8bbf40de2d4abdf0497736a94
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

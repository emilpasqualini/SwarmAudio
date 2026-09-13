//
//  monitor.ts
//  HIVE (client, dashboard)
//
//  The computer's view: the QR code people scan, who is in the swarm, where the
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
import { CAM_MODES, SETTINGS_LIMITS, SPECIES, wifiQrText } from '../../shared/types';
import type { CamMode, Species } from '../../shared/types';
import { CAM_FIELDS, CAM_MESSAGES, EVENT_MESSAGES, GLOBAL_FIELDS, MIX_FIELDS, MUTABLE, OSC_SCHEMA_VERSION, SAMPLE_FIELDS, SWARM_FIELDS, typeTags } from '../../shared/osc-schema';

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
  ws.binaryType = 'blob';
  ws.onopen = () => log.step('monitor connected');
  ws.onmessage = (e) => {
    if (e.data instanceof Blob) {
      // the camera's annotated frame
      const url = URL.createObjectURL(e.data);
      refs.camImage.src = url;
      if (camUrl) URL.revokeObjectURL(camUrl);
      camUrl = url;
      return;
    }
    const msg = JSON.parse(e.data as string) as MonitorMessage;
    if (msg.type === 'hello') {
      // The server restarted since this page loaded: its client build may
      // have changed too, and a stale page against a new server misbehaves.
      if (hello && hello.bootId !== msg.bootId) { location.reload(); return; }
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
  queenNote: el('span', { class: 'note', text: 'none' }),
  startButton: el('button', { class: 'pill', text: 'start' }),
  resetButton: el('button', { class: 'pill quiet', text: 'reset' }),
  roundNote: el('span', { class: 'note' }),
  wifiCard: el('div', { class: 'stack', hidden: true }),
  wifiQr: el('div', { class: 'qr' }),
  wifiName: el('div', { class: 'url' }),
  queenClear: el('button', { class: 'pill small quiet', text: 'none', title: 'no queen; the next one is crowned after queen after seconds' }),
  volume: el('input', { type: 'range', min: 0, max: 1, step: 0.01, value: 0.5, style: 'width:120px' }),
  swarmSettings: el('div', { class: 'card stack' }),
  signalSettings: el('div', { class: 'card stack' }),
  wallSettings: el('div', { class: 'card stack' }),
  oscSettings: el('div', { class: 'card stack' }),
  species: el('select', {}),
  protocolCard: el('div', { class: 'card stack' }),
  camImage: el('img', { class: 'cam-preview', alt: 'camera preview' }),
  camStatus: el('div', { class: 'note', text: 'no camera process attached' }),
  camSelect: el('select', {}),
  camModeSelect: el('select', {}),
  fieldRow: el('div', { class: 'global-row' }),
  camCard: el('div', { class: 'card stack' }),
  globalRow: el('div', { class: 'global-row' }),
  mixRow: el('div', { class: 'global-row' }),
  camRow: el('div', { class: 'global-row' }),
  muteGrid: el('div', { class: 'mute-grid' }),
};
let camUrl: string | null = null;

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
      el('summary', { class: 'note', text: `/hive/global — ${GLOBAL_FIELDS.length} arguments at the swarm rate · ${typeTags(GLOBAL_FIELDS)}` }),
      el('div', { class: 'table-wrap' }, fieldRows(GLOBAL_FIELDS)),
    ),
    el('details', {},
      el('summary', { class: 'note', text: `/hive/cam — ${CAM_FIELDS.length} arguments per camera frame · ${typeTags(CAM_FIELDS)}` }),
      el('div', { class: 'table-wrap' }, fieldRows(CAM_FIELDS)),
      el('div', { class: 'table-wrap' }, el('table', { class: 'schema' },
        el('tbody', {}, ...CAM_MESSAGES.map((m) => el('tr', {},
          el('td', {}, el('code', { text: m.address })), el('td', { class: 'note', text: m.args }), el('td', { class: 'note', text: m.when }),
        ))),
      )),
    ),
    el('details', {},
      el('summary', { class: 'note', text: `/hive/mix — ${MIX_FIELDS.length} arguments at the swarm rate · ${typeTags(MIX_FIELDS)}` }),
      el('div', { class: 'table-wrap' }, fieldRows(MIX_FIELDS)),
    ),
    el('details', {},
      el('summary', { class: 'note', text: 'events: join · leave · roster · schema · ping · queen' }),
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
        'Py:   python3 examples/osc_listen.py 9000        (or JSON: examples/feed_client.py ws://<computer>:8080/feed)',
      ].join('\n') }),
    ),
  );
}

// --- settings card: inputs are built once and only refreshed while not focused,
//     so a 10 Hz snapshot never yanks a half-typed number away. -----------------

type NumKey = 'swarmHz' | 'deviceTimeoutMs' | 'simulate' | 'zeroIdleAfter' | 'zeroTau' | 'filterMinCutoff' | 'filterBeta' | 'queenAfter' | 'camStrength' | 'camEps' | 'camDetectFps' | 'camPushStrength';
type BoolKey = 'oscWide' | 'oscPerField' | 'oscRoster' | 'oscSwarm' | 'wifiHotspot' | 'wallWifiCode' | 'wallJoinCode' | 'oscCam' | 'oscCamPersons' | 'camCoupling' | 'camMirror' | 'camPreview' | 'oscGlobal' | 'oscMix' | 'queenHidden' | 'camPush' | 'camEnabled';
type TextKey = 'wifiSsid' | 'wifiPassword';
const numInputs = new Map<NumKey, HTMLInputElement>();
const textInputs = new Map<TextKey, HTMLInputElement>();
const boolButtons = new Map<BoolKey, HTMLButtonElement>();

async function patchSettings(patch: Partial<Settings>): Promise<void> {
  const res = await api('PATCH', '/api/settings', patch);
  if (res.ok) log.step(`settings: ${Object.entries(patch).map(([k, v]) => `${k}=${v}`).join(', ')}`);
}

function numberSetting(key: NumKey, label: string, hint: string, step = 1): HTMLElement[] {
  const { min, max } = SETTINGS_LIMITS[key];
  const input = el('input', { type: 'number', min, max, step });
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

function textSetting(key: TextKey, label: string, hint: string, placeholder = ''): HTMLElement[] {
  const input = el('input', { type: 'text', placeholder, autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
  const commit = (): void => { if (input.value !== state?.settings[key]) void patchSettings({ [key]: input.value }); };
  input.onchange = commit;
  input.onkeydown = (e) => { if (e.key === 'Enter') { commit(); input.blur(); } };
  textInputs.set(key, input);
  return [el('span', { class: 'k', text: label }), el('span', { class: 'row' }, input, el('span', { class: 'hint', text: hint }))];
}

function boolSetting(key: BoolKey, label: string, hint: string): HTMLElement[] {
  const button = el('button', { class: 'pill small quiet', text: 'off' });
  button.onclick = () => { void patchSettings({ [key]: !state?.settings[key] }); };
  boolButtons.set(key, button);
  return [el('span', { class: 'k', text: label }), el('span', { class: 'row' }, button, el('span', { class: 'hint', text: hint }))];
}

// --- osc parameters: one compact chip per small message; off = not sent, saves traffic.
const muteChips = new Map<string, HTMLButtonElement>();
function buildMuteGrid(): void {
  const families = [...new Set(MUTABLE.map((m) => m.family))];
  refs.muteGrid.replaceChildren(...families.map((fam) => el('div', { class: 'mute-family' },
    el('span', { class: 'k', text: fam }),
    ...MUTABLE.filter((m) => m.family === fam).map((m) => {
      const chip = el('button', { class: 'chip on', text: m.key.slice(fam.length + 1), title: `/hive/${m.key}` });
      chip.onclick = () => {
        const muted = new Set(state?.settings.oscMute ?? []);
        if (muted.has(m.key)) muted.delete(m.key); else muted.add(m.key);
        void patchSettings({ oscMute: [...muted] });
      };
      muteChips.set(m.key, chip);
      return chip;
    }),
  )));
}

function updateMuteGrid(s: Settings): void {
  const muted = new Set(s.oscMute);
  for (const [key, chip] of muteChips) chip.classList.toggle('on', !muted.has(key));
}

/** Settings in four cards, spread over the columns so the page has no holes. */
function settingsCard(title: string, ...rows: HTMLElement[]): HTMLElement {
  return el('div', { class: 'card stack' }, el('div', { class: 'section-label', text: title }), el('div', { class: 'settings' }, ...rows));
}

function buildSettingsCards(h: MonitorHello): void {
  refs.swarmSettings.replaceChildren(...settingsCard('swarm',
    ...numberSetting('simulate', 'fake phones', '0 = off; virtual devices through the real pipeline'),
    ...numberSetting('swarmHz', 'swarm rate', 'Hz for /hive/swarm, /hive/global, /hive/mix'),
    ...numberSetting('deviceTimeoutMs', 'device timeout', 'ms of silence before a phone is dropped'),
    el('span', { class: 'k', text: 'queen' }),
    el('span', { class: 'row' }, refs.queenNote, refs.queenClear),
    ...numberSetting('queenAfter', 'queen after', 's without a queen until the phone that moved most is crowned'),
    ...boolSetting('queenHidden', 'hidden queen', 'game mode: no crown on the wall or the phones — not even hers. only this dashboard and OSC know; the room finds her by ear. the crown still passes on collision, silently'),
    el('span', { class: 'k', text: 'species' }),
    el('span', { class: 'row' }, refs.species, el('span', { class: 'hint', text: 'what the wall draws: bees or sheep — same mechanics, the queen is the big one' })),
  ).children);
  refs.signalSettings.replaceChildren(...settingsCard('signal',
    ...numberSetting('filterMinCutoff', 'filter: min cutoff', 'Hz — One-Euro cutoff at rest; lower = calmer rel when still', 0.05),
    ...numberSetting('filterBeta', 'filter: beta', 'how much the cutoff rises with speed of change; higher = snappier gestures', 0.05),
    ...numberSetting('zeroIdleAfter', 'zero: rest before', 's at rest before the zero starts following the resting tilt', 0.1),
    ...numberSetting('zeroTau', 'zero: slide time', 's — time constant of the zero sliding over; rel → 0 at rest', 0.1),
  ).children);
  refs.wallSettings.replaceChildren(...settingsCard('wall & wi-fi',
    ...boolSetting('wifiHotspot', 'iphone hotspot', 'on: an iPhone personal hotspot (name + password under settings → personal hotspot; switch on "maximise compatibility"; that iPhone itself cannot join). off: any other wi-fi'),
    ...textSetting('wifiSsid', 'wi-fi name', 'as a QR code here and on the wall; some systems hide the SSID from apps, so type it', "Emil's iPhone"),
    ...textSetting('wifiPassword', 'wi-fi password', 'empty = open network'),
    ...boolSetting('wallWifiCode', 'wall: wi-fi code', 'show the wi-fi QR code on the wall — off once everyone is on the network'),
    ...boolSetting('wallJoinCode', 'wall: join code', 'show the join QR code on the wall — off once everyone is in'),
  ).children);
  refs.oscSettings.replaceChildren(...settingsCard('osc families',
    ...boolSetting('oscWide', '/hive/sample', 'the wide message: everything per sample, fixed order — see protocol card'),
    ...boolSetting('oscPerField', 'per field', '/hive/dev/<slot>/acc · rel · gyro · activity · mag · turn'),
    ...boolSetting('oscRoster', 'roster', '/hive/roster + /hive/schema + /hive/queen + /hive/cam/status every second'),
    ...boolSetting('oscSwarm', 'swarm', '/hive/swarm + count · energy · motion · sync'),
    ...boolSetting('oscGlobal', 'global', '/hive/global + one message per field'),
    ...boolSetting('oscMix', 'mix', '/hive/mix — bees ⇄ camera'),
    el('span', { class: 'k', text: 'ports' }),
    el('span', { class: 'note', text: `https ${h.httpsPort} (phones) · http ${h.httpPort} (this page, /feed, /vision) — HIVE_HTTPS_PORT / HIVE_HTTP_PORT, restart` }),
    el('span', { class: 'k', text: 'saved to' }),
    el('span', { class: 'note url', text: h.configFile }),
  ).children);
}

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
  updateMuteGrid(s);
  if (document.activeElement !== refs.species) refs.species.value = s.species;
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
  for (const [key, input] of numInputs) {
    if (document.activeElement !== input) input.value = String(s[key]);
  }
  for (const [key, button] of boolButtons) {
    const on = Boolean(s[key]);
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
  QRCode.toCanvas(canvas, hello.qrUrl, { width: 220, margin: 0, color: { dark: '#000000', light: '#ffffff' } })
    .catch((err: Error) => log.fail(`QR: ${err.message}`));
  refs.urls.replaceChildren(
    ...hello.urls.map((u) => el('div', { class: 'url', text: u })),
    el('p', { class: 'note', text: `Dashboard: http://localhost:${hello.httpPort}/monitor · Raw feed: ws://<this-computer>:${hello.httpPort}/feed` }),
  );
}

function buildPage(): void {
  if (!hello) return;

  drawAddresses();
  refs.camCard.replaceChildren(
    el('div', { class: 'row between wrap' },
      el('div', { class: 'section-label', text: 'camera — what opencv sees' }),
      el('span', { class: 'note', text: 'starts with the server' }),
    ),
    refs.camImage,
    refs.camStatus,
    el('div', { class: 'settings' },
      ...boolSetting('camEnabled', 'main switch', 'the camera is only opened while this is on (LED dark otherwise); off = nothing camera-related is sent, drawn or shown'),
      el('span', { class: 'k', text: 'which' }),
      el('span', { class: 'row' }, refs.camSelect, el('span', { class: 'hint', text: 'built-in, or an iPhone as Continuity Camera — the list comes from the camera process' })),
      el('span', { class: 'k', text: 'mode' }),
      el('span', { class: 'row' }, refs.camModeSelect, el('span', { class: 'hint', text: 'field: a full room — optical-flow grid every frame, people a few times a second, no ids. people: small rounds — full-rate tracking with ids' })),
      ...numberSetting('camDetectFps', 'detect rate', 'field mode: how often per second the model looks for people (front rows)'),
      ...boolSetting('camPreview', 'preview', 'the annotated picture above, ~8 fps; off saves the camera process some work'),
      ...boolSetting('oscCam', 'osc camera', '/hive/cam (wide) + count · clusters · spread · energy · centroid · armsUp + /hive/cam/cluster'),
      ...boolSetting('oscCamPersons', 'osc per person', '/hive/cam/person per tracked person — id · x · y · depth · armsUp · crouch · energy'),
      ...numberSetting('camEps', 'cluster radius', 'fraction of the frame width within which people count as one group', 0.01),
      ...boolSetting('camMirror', 'mirror', 'flip left/right so the picture behaves like a mirror'),
      ...boolSetting('camCoupling', 'wall coupling', 'bees are drawn toward the crowds the camera sees; the room\'s spread sets how far apart they keep'),
      ...numberSetting('camStrength', 'coupling strength', '0 = none, 1 = the crowd wins over the tilt', 0.05),
      ...boolSetting('camPush', 'crowd shoves', 'the motion the camera sees under an animal pushes it along the flow'),
      ...numberSetting('camPushStrength', 'shove strength', 'how much of the flow an animal picks up: 0.5 = a draught, 1 = you feel it, 3 = a gale', 0.1),
    ),
    el('p', { class: 'note', text: 'YOLO11n-pose on this computer: people, skeletons, clusters. Nobody in the picture is matched to a phone — the camera is a field, the phones are the agents.' }),
  );
  refs.wifiCard.replaceChildren(
    el('details', {},
      el('summary', { class: 'section-label', text: 'wi-fi QR code (as on the wall)' }),
      refs.wifiQr,
      refs.wifiName,
    ),
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
  refs.queenClear.onclick = () => { void patchSettings({ queenUid: '' }); };
  refs.startButton.onclick = () => { void patchSettings({ running: !state?.settings.running }); };
  refs.species.replaceChildren(...SPECIES.map((sp) => el('option', { value: sp, text: sp })));
  refs.species.onchange = () => { void patchSettings({ species: refs.species.value as Species }); };
  refs.camSelect.onchange = () => { void patchSettings({ camIndex: Number(refs.camSelect.value) }); };
  refs.camModeSelect.replaceChildren(...CAM_MODES.map((m) => el('option', { value: m, text: m })));
  refs.camModeSelect.onchange = () => { void patchSettings({ camMode: refs.camModeSelect.value as CamMode }); };
  refs.resetButton.onclick = () => { if (confirm('reset the round? the queen is cleared, everyone re-spawns, and the swarm waits for start.')) void patchSettings({ reset: true } as unknown as Partial<Settings>); };
  refs.volume.oninput = () => tones.setVolume(Number(refs.volume.value));
  buildSettingsCards(hello);
  buildProtocolCard();
  buildMuteGrid();

  root.replaceChildren(el('main', { class: 'wide stack' },
    el('div', { class: 'row between wrap' },
      el('h1', { text: 'HIVE · monitor' }),
      el('div', { class: 'row wrap' }, refs.count, refs.energy, refs.motion, refs.sync),
    ),
    el('div', { class: 'card row wrap between' },
      el('div', { class: 'row wrap' }, refs.startButton, refs.resetButton, refs.roundNote),
      el('span', { class: 'note', text: 'people can join while paused — bees hover, no queen race, phones say "waiting". start lets it all go; reset clears the queen and re-spawns everyone.' }),
    ),
    el('div', { class: 'grid-3' },
      el('div', { class: 'stack' },
        el('div', { class: 'card stack' },
          el('div', { class: 'section-label', text: 'scan to join' }),
          refs.qr,
          refs.urls,
          refs.wifiCard,
          el('div', { class: 'section-label', text: 'for the projector' }),
          el('p', { class: 'note' },
            'Open ', el('a', { href: '/wall', target: '_blank', text: `${location.origin}/wall` }),
            ' on the projector — big QR, join steps, live visuals. Double-click for fullscreen, h hides the panels.'),
          el('div', { class: 'section-label', text: 'certificate warning — every phone, once' }),
          el('p', { class: 'note', text: 'iPhone: Show Details → visit this website. Android: Advanced → Proceed. Then Join (iPhone: Allow motion).' }),
        ),
        refs.wallSettings,
        el('div', { class: 'card stack' },
          el('div', { class: 'section-label', text: 'debug sound on this computer' }),
          el('div', { class: 'row wrap' }, refs.tonesButton, el('span', { class: 'note', text: 'volume' }), refs.volume),
          el('p', { class: 'note', text: 'One sine per phone. Tilt bends the pitch, turning opens the volume, left/right pans. If you hear it, the whole chain works.' }),
        ),
      ),
      el('div', { class: 'stack' },
        refs.camCard,
        refs.signalSettings,
      ),
      el('div', { class: 'stack' },
        el('div', { class: 'card stack' },
          el('div', { class: 'section-label', text: 'osc targets (udp)' }),
          refs.targets,
          el('div', { class: 'row wrap' }, el('div', { class: 'grow' }, spec), label, add),
          refs.feedInfo,
        ),
        refs.swarmSettings,
        refs.oscSettings,
      ),
    ),
    el('div', { class: 'grid-3' },
      el('div', { class: 'card stack' },
        el('div', { class: 'section-label', text: 'swarm meta-parameters — /hive/global' }),
        refs.globalRow,
      ),
      el('div', { class: 'card stack' },
        el('div', { class: 'section-label', text: 'crowd field — /hive/cam' }),
        refs.fieldRow,
        el('div', { class: 'section-label', text: 'crowd motion (people)' }),
        refs.camRow,
      ),
      el('div', { class: 'card stack' },
        el('div', { class: 'section-label', text: 'bees ⇄ camera — /hive/mix' }),
        refs.mixRow,
      ),
    ),
    el('div', { class: 'card stack' },
      el('div', { class: 'row between wrap' },
        el('div', { class: 'section-label', text: 'osc parameters — what goes out' }),
        el('span', { class: 'note', text: 'one chip per small message; off = not sent. the wide messages follow the family switches in settings.' }),
      ),
      refs.muteGrid,
    ),
    refs.protocolCard,
    el('div', { class: 'card' },
      el('div', { class: 'section-label', text: 'swarm' }),
      el('div', { class: 'table-wrap' }, el('table', {},
        el('thead', {}, el('tr', {},
          el('th', { text: '#' }), el('th', { text: 'name' }), el('th', { text: 'uid' }), el('th', { text: 'platform' }), el('th', { text: 'link' }),
          el('th', { text: 'hz' }), el('th', { text: 'rel x y z · turn x y z' }), el('th', { text: '|rel|' }), el('th', { text: '|turn|' }), el('th', { text: 'act' }), el('th'),
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
  const v = state.vision;
  refs.camStatus.textContent = v.connected
    ? `connected · ${v.mode} · ${v.backend || '?'} · ${v.fps.toFixed(0)} fps · ${v.count} ${v.count === 1 ? 'person' : 'people'} · ${v.clusters} cluster${v.clusters === 1 ? '' : 's'} · spread ${v.spread.toFixed(2)} · energy ${v.energy.toFixed(2)}`
    : v.enabled ? 'no camera process attached — it starts with ./start.sh (or run ./start.sh --vision elsewhere)' : 'camera off';
  refs.camImage.classList.toggle('stale', !v.connected);
  const options = [['-1', 'auto — first that opens'], ...v.cameras.map((n, i) => [String(i), `${i} · ${n}`])];
  if (refs.camSelect.childElementCount !== options.length || [...refs.camSelect.options].some((o, i) => o.value !== options[i]![0])) {
    refs.camSelect.replaceChildren(...options.map(([val, text]) => el('option', { value: val, text })));
  }
  if (document.activeElement !== refs.camSelect) refs.camSelect.value = String(state.settings.camIndex);
  if (document.activeElement !== refs.camModeSelect) refs.camModeSelect.value = state.settings.camMode;
  numbers(refs.fieldRow, [
    ['flow energy', v.flowEnergy.toFixed(2)], ['coherence', v.flowCoherence.toFixed(2)], ['centre x', v.flowCx.toFixed(2)], ['centre y', v.flowCy.toFixed(2)],
    ['beat', v.beat > 0 ? `${v.beat.toFixed(1)} Hz` : '—'], ['beat strength', v.beatStrength.toFixed(2)], ['density', v.densityMean.toFixed(2)],
    ['largest group', `${Math.round(v.largestShare * 100)} %`],
  ]);
  const g = state.global;
  const cells: [string, string][] = [
    ['coherence', g.coherence.toFixed(2)], ['phase sync', g.phaseSync.toFixed(2)], ['tempo', `${g.tempo.toFixed(1)} Hz`],
    ['centroid', `${g.centroid.toFixed(1)} Hz`], ['entropy', g.entropy.toFixed(2)], ['dispersion', g.dispersion.toFixed(2)],
    ['lean x', g.leanX.toFixed(1)], ['lean y', g.leanY.toFixed(1)], ['onsets', `${g.onsets.toFixed(1)}/s`], ['crest', g.crest.toFixed(1)],
  ];
  numbers(refs.globalRow, cells);
  const vf = state.vision;
  numbers(refs.camRow, [
    ['people', String(vf.count)], ['clusters', String(vf.clusters)], ['spread', vf.spread.toFixed(2)], ['energy', vf.energy.toFixed(2)],
    ['flow x', vf.flowX.toFixed(2)], ['flow y', vf.flowY.toFixed(2)], ['turbulence', vf.turbulence.toFixed(2)], ['move sync', vf.moveSync.toFixed(2)],
    ['converge', vf.converge.toFixed(2)], ['nearest', vf.nearest.toFixed(2)], ['stillness', vf.stillness.toFixed(2)], ['occupancy', vf.occupancy.toFixed(2)],
  ]);
  const m = state.mix;
  numbers(refs.mixRow, [
    ['bees', String(m.bees)], ['people', String(m.people)], ['distance', m.distance.toFixed(2)], ['bees in crowd', m.beesInCrowd.toFixed(2)],
    ['queen in crowd', m.queenInCrowd ? 'yes' : 'no'], ['covered', m.covered.toFixed(2)], ['alignment', m.alignment.toFixed(2)], ['balance', m.balance.toFixed(2)],
  ]);
  renderTargets(state.targets);
  renderDevices(state.devices);
  updateSettings(state.settings);
}

/** A row of labelled numbers, built once and then only updated. */
function numbers(row: HTMLElement, cells: [string, string][]): void {
  if (row.childElementCount !== cells.length) {
    row.replaceChildren(...cells.map(([k]) => el('div', { class: 'big-number small' }, el('span', { text: '—' }), el('small', { text: k }))));
  }
  cells.forEach(([, val], i) => { row.children[i]!.firstChild!.textContent = val; });
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
        el('td'), el('td', { class: 'num' }), el('td'), el('td'), el('td', { class: 'num' }),
        el('td', {}, el('div', { class: 'mini' }, ...bars)),
        el('td', { class: 'num' }), el('td', { class: 'num' }), el('td', { class: 'num' }),
        el('td', {}, (() => {
          const crown = el('button', { class: 'pill small quiet', text: '♛', title: 'make this the queen' });
          crown.onclick = () => { void patchSettings({ queenUid: state?.settings.queenUid === d.uid ? '' : d.uid }); };
          const kick = el('button', { class: 'pill small quiet', text: '×', title: 'drop this device' });
          kick.onclick = () => { void api('POST', '/api/devices/kick', { slot: d.slot }); };
          return el('span', { class: 'row' }, crown, kick);
        })()),
      ];
      const tr = el('tr', {}, ...cells);
      tr.style.setProperty('--slot', slotColour(d.slot));
      row = { tr, cells, bars };
      rows.set(d.slot, row);
    }
    const c = row.cells;
    c[1]!.textContent = d.name || '—';
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

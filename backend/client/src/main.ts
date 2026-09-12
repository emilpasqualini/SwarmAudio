//
//  main.ts
//  HIVE (client)
//
//  The phone app: join → streaming, with an error view for the ways a phone
//  can say no.
//
//  Everything time-critical happens in two callbacks — the devicemotion
//  handler pushes into a FrameBuilder, and a flush sends the frame when the
//  batch is full. The DOM is updated at most once per animation frame from
//  the latest values, so rendering never slows the sensor path.
//

import './theme.css';
import { el, setSigned, signedBar, slotColour } from './dom';
import { ActivityLog } from './log';
import { lang, setLang, t } from './i18n';
import type { Lang } from './i18n';
import { checkSupport, detectPlatform, keepAwake, releaseWake, requestMotionPermission, startMotion } from './sensors';
import type { MotionSample, MotionStream } from './sensors';
import { Transport } from './transport';
import type { Mode, Status } from './transport';
import { FrameBuilder } from '../../shared/protocol';

// --------------------------------------------------------------------------- //
// State
// --------------------------------------------------------------------------- //

type View = 'join' | 'streaming' | 'error';
type ErrorKind = 'insecure' | 'unsupported' | 'denied' | 'nodata' | 'server';

const root = document.getElementById('app')!;
const log = new ActivityLog(document.getElementById('log')!);
const platform = detectPlatform();
const params = new URLSearchParams(location.search);
const batchSize = Math.max(1, Math.min(16, Number(params.get('batch')) || 3));

const deviceId = localStorage.getItem('hive.id') ?? (() => {
  const id = crypto.randomUUID();
  localStorage.setItem('hive.id', id);
  return id;
})();

interface State {
  view: View;
  error: ErrorKind | null;
  name: string;
  status: Status;
  mode: Mode;
  slot: number | null;
  hz: number;
  last: MotionSample | null;
}

const state: State = {
  view: 'join',
  error: null,
  name: localStorage.getItem('hive.name') ?? '',
  status: 'connecting',
  mode: 'ws',
  slot: null,
  hz: 0,
  last: null,
};

let transport: Transport | null = null;
let motion: MotionStream | null = null;
let builder: FrameBuilder | null = null;
let flushTimer = 0;
let sampleCount = 0;
let hzTimer = 0;

// --------------------------------------------------------------------------- //
// Sensor path
// --------------------------------------------------------------------------- //

function onSample(s: MotionSample): void {
  state.last = s;
  sampleCount++;
  builder!.push(s.t, s.ax, s.ay, s.az, s.gx, s.gy, s.gz);
  if (builder!.length >= batchSize) flush();
  else if (!flushTimer) flushTimer = window.setTimeout(flush, 100); // never hold a frame longer than this
  scheduleRender();
}

function flush(): void {
  clearTimeout(flushTimer);
  flushTimer = 0;
  const frame = builder?.take();
  if (frame && transport) transport.send(frame);
}

async function join(): Promise<void> {
  const support = checkSupport();
  if (support !== 'ok') { showError(support); return; }

  setJoining(true);
  const permission = await requestMotionPermission();
  if (permission !== 'granted') { setJoining(false); showError('denied'); return; }

  localStorage.setItem('hive.name', state.name);
  builder = new FrameBuilder(platform, false, 16);
  transport = new Transport(deviceId, state.name, {
    onStatus: (status, mode) => {
      state.status = status; state.mode = mode;
      if (status === 'down') showError('server');
      else scheduleRender();
    },
    onLog: (line) => log.log(line),
  });
  transport.start();
  motion = startMotion(platform, onSample, () => { log.warn('no motion events'); showError('nodata'); });

  const awake = await keepAwake();
  log.log(awake ? 'screen wake lock held' : 'no wake lock — keep the screen on by hand');
  log.step(`joined as ${platform}, batch ${batchSize}`);

  hzTimer = window.setInterval(() => { state.hz = sampleCount; sampleCount = 0; scheduleRender(); }, 1000);
  state.view = 'streaming';
  render();
}

function leave(): void {
  motion?.stop(); motion = null;
  flush();
  transport?.stop(); transport = null;
  builder = null;
  clearInterval(hzTimer);
  releaseWake();
  state.view = 'join'; state.slot = null; state.last = null; state.hz = 0;
  log.step('left the swarm');
  render();
}

function showError(kind: ErrorKind): void {
  motion?.stop(); motion = null;
  transport?.stop(); transport = null;
  clearInterval(hzTimer);
  releaseWake();
  state.view = 'error'; state.error = kind;
  render();
}

// Screen off → events stop and the wake lock is released by the OS; when the
// page is visible again the transport reconnects on its own, and we re-arm the lock.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.view === 'streaming') void keepAwake();
});
window.addEventListener('pagehide', () => { if (state.view === 'streaming') transport?.stop(); });

// --------------------------------------------------------------------------- //
// Views
// --------------------------------------------------------------------------- //

let joinButton: HTMLButtonElement | null = null;
function setJoining(on: boolean): void {
  if (!joinButton) return;
  joinButton.disabled = on;
  joinButton.textContent = on ? t('joining') : t('join');
}

function header(): HTMLElement {
  const toggle = el('div', { class: 'segmented', role: 'group', 'aria-label': 'language' },
    ...(['en', 'de'] as Lang[]).map((l) => {
      const b = el('button', { class: lang() === l ? 'on' : '', text: l.toUpperCase() });
      b.onclick = () => { setLang(l); render(); };
      return b;
    }),
  );
  return el('div', { class: 'row between' }, el('h1', { text: 'HIVE' }), toggle);
}

function joinView(): HTMLElement {
  const name = el('input', { type: 'text', placeholder: t('yourName'), value: state.name, maxlength: 24, autocomplete: 'off', autocapitalize: 'words' });
  name.oninput = () => { state.name = name.value.trim(); };
  joinButton = el('button', { class: 'pill big', text: t('join') });
  joinButton.onclick = () => { void join(); };
  return el('div', { class: 'stack' },
    el('p', { class: 'note', text: t('tagline') }),
    el('div', { class: 'card stack' }, name, joinButton),
    el('p', { class: 'note center', text: t('keepOpen') }),
  );
}

// Streaming view keeps references so 60 Hz updates touch only text and widths.
let bars: HTMLElement[] = [];
let values: HTMLElement[] = [];
let statusLine: HTMLElement | null = null;
let slotBadge: HTMLElement | null = null;

const AXES: { key: keyof MotionSample; label: string; range: number; gyro: boolean }[] = [
  { key: 'ax', label: 'acc x', range: 20, gyro: false },
  { key: 'ay', label: 'acc y', range: 20, gyro: false },
  { key: 'az', label: 'acc z', range: 20, gyro: false },
  { key: 'gx', label: 'gyr x', range: 360, gyro: true },
  { key: 'gy', label: 'gyr y', range: 360, gyro: true },
  { key: 'gz', label: 'gyr z', range: 360, gyro: true },
];

function streamingView(): HTMLElement {
  bars = []; values = [];
  const axes = el('div', { class: 'axes' });
  AXES.forEach((a, i) => {
    const bar = signedBar(a.gyro ? 'gyro' : '');
    const value = el('span', { class: 'value', text: '0.0' });
    bars[i] = bar; values[i] = value;
    axes.append(el('span', { class: 'name', text: a.label }), bar, value);
  });

  slotBadge = el('div', { class: 'slot-badge', text: '·' }, el('small', { text: t('youAre') }));
  statusLine = el('div', { class: 'status' });

  const leaveButton = el('button', { class: 'pill quiet', text: t('leave') });
  leaveButton.onclick = leave;

  const view = el('div', { class: 'stack' },
    el('div', { class: 'card' }, slotBadge),
    el('div', { class: 'card stack' },
      el('div', { class: 'section-label', text: `${t('acc')} · ${t('gyro')}` }),
      axes,
    ),
    statusLine,
    el('div', { class: 'row', style: 'justify-content:center' }, leaveButton),
    el('p', { class: 'note center', text: t('keepOpen') }),
  );
  updateLive();
  return view;
}

function errorView(): HTMLElement {
  const key = ({ insecure: 'errInsecure', unsupported: 'errUnsupported', denied: 'errDenied', nodata: 'errNoData', server: 'errServer' } as const)[state.error ?? 'server'];
  const retry = el('button', { class: 'pill', text: t('retry') });
  retry.onclick = () => { state.view = 'join'; state.error = null; render(); };
  return el('div', { class: 'stack' },
    el('div', { class: 'card stack' }, el('p', { class: 'note fail', text: t(key) }), el('div', { class: 'row' }, retry)),
  );
}

function render(): void {
  document.documentElement.lang = lang() === 'de' ? 'de-AT' : 'en-GB';
  const body = state.view === 'join' ? joinView() : state.view === 'streaming' ? streamingView() : errorView();
  root.replaceChildren(el('main', { class: 'stack' }, header(), body, el('div', { class: 'credit', text: t('credit') })));
}

// --- live updates, once per animation frame ------------------------------------

let renderQueued = false;
function scheduleRender(): void {
  if (renderQueued || state.view !== 'streaming') return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; updateLive(); });
}

function updateLive(): void {
  const s = state.last;
  if (s) {
    AXES.forEach((a, i) => {
      const v = s[a.key] as number;
      setSigned(bars[i]!, v, a.range);
      values[i]!.textContent = v.toFixed(1);
    });
  }
  if (slotBadge) {
    const colour = state.slot ? slotColour(state.slot) : 'var(--text-faint)';
    slotBadge.style.setProperty('--slot', colour);
    slotBadge.firstChild!.textContent = state.slot ? `#${state.slot}` : '·';
    for (const b of bars) b.style.setProperty('--slot', colour);
  }
  if (statusLine) {
    const st = state.status === 'open' ? t('streaming') : state.status === 'connecting' ? t('connecting') : state.status === 'reconnecting' ? t('reconnecting') : t('disconnected');
    const cls = state.status === 'open' ? 'ok' : state.status === 'down' ? 'fail' : 'warn';
    statusLine.replaceChildren(
      el('span', { class: cls, text: st }),
      el('span', {}, el('span', { class: 'k', text: `${t('transport')} ` }), state.mode.toUpperCase()),
      el('span', {}, el('span', { class: 'k', text: `${t('rate')} ` }), `${state.hz} Hz`),
      el('span', {}, el('span', { class: 'k', text: 'id ' }), deviceId.slice(0, 8)),
    );
  }
}

render();
log.log(`${platform} · ${location.host}`);

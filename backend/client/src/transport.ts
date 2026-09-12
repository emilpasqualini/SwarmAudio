//
//  transport.ts
//  HIVE (client)
//
//  Getting frames to the Mac: WebSocket when the phone allows it, POST when
//  it does not.
//
//  With a self-signed certificate iOS Safari loads the page after a warning but
//  refuses `wss://` to the same host, silently. Android Chrome allows both. So
//  we try the socket, and if it is not open within a moment — or dies before
//  it ever opened — we switch to POSTing each frame to `/ingest/<id>`. Both
//  carry the identical binary frame. Frames are never queued: if the link is
//  slow, a frame is dropped rather than delivered late. This is a sound
//  installation, not a database.
//

export type Mode = 'ws' | 'post';
export type Status = 'connecting' | 'open' | 'reconnecting' | 'down';

export interface TransportEvents {
  onStatus: (status: Status, mode: Mode) => void;
  onLog: (line: string) => void;
}

const WS_OPEN_TIMEOUT = 1500;
const MAX_INFLIGHT_POSTS = 2;
const RECONNECT_MS = [500, 1000, 2000, 3000, 5000];

export class Transport {
  private mode: Mode = 'ws';
  private status: Status = 'connecting';
  private ws: WebSocket | null = null;
  private wsBroken = false;   // once WSS failed before opening, do not try it again this session
  private inflight = 0;
  private postFailures = 0;
  private attempt = 0;
  private closed = false;
  private timer = 0;
  sent = 0;
  dropped = 0;

  constructor(
    private readonly id: string,
    private readonly name: string,
    private readonly events: TransportEvents,
  ) {}

  get currentMode(): Mode { return this.mode; }
  get currentStatus(): Status { return this.status; }

  start(): void {
    this.closed = false;
    if (this.wsBroken) this.usePost();
    else this.openSocket();
  }

  send(frame: Uint8Array<ArrayBuffer>): void {
    if (this.closed) return;
    if (this.mode === 'ws') {
      if (this.ws?.readyState === WebSocket.OPEN) {
        // bufferedAmount > 0 means the last frame has not left the phone yet.
        if (this.ws.bufferedAmount > 4096) { this.dropped++; return; }
        this.ws.send(frame);
        this.sent++;
      } else {
        this.dropped++;
      }
      return;
    }
    if (this.inflight >= MAX_INFLIGHT_POSTS) { this.dropped++; return; }
    this.inflight++;
    fetch(`/ingest/${this.id}?name=${encodeURIComponent(this.name)}`, {
      method: 'POST',
      body: frame,
      headers: { 'Content-Type': 'application/octet-stream' },
      cache: 'no-store',
      keepalive: true,
    }).then((res) => {
      this.inflight--;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.sent++;
      this.postFailures = 0;
      if (this.status !== 'open') this.setStatus('open');
    }).catch((err: Error) => {
      this.inflight--;
      this.postFailures++;
      if (this.postFailures === 3) {
        this.events.onLog(`POST failing: ${err.message}`);
        this.setStatus('reconnecting');
      }
      if (this.postFailures >= 40) this.setStatus('down');
    });
  }

  /** Tell the server we are leaving, then stop. */
  stop(): void {
    this.closed = true;
    clearTimeout(this.timer);
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close(1000, 'leave');
      this.ws = null;
    } else {
      navigator.sendBeacon(`/ingest/${this.id}?bye=1`);
    }
  }

  // --- websocket ---------------------------------------------------------------

  private openSocket(): void {
    this.mode = 'ws';
    this.setStatus(this.attempt === 0 ? 'connecting' : 'reconnecting');
    const url = `wss://${location.host}/ws?id=${this.id}&name=${encodeURIComponent(this.name)}`;
    let opened = false;
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    const openTimeout = setTimeout(() => {
      if (!opened) { this.events.onLog('WebSocket did not open in time'); ws.close(); }
    }, WS_OPEN_TIMEOUT);

    ws.onopen = () => {
      opened = true;
      clearTimeout(openTimeout);
      this.attempt = 0;
      this.events.onLog('WebSocket open');
      this.setStatus('open');
    };
    ws.onerror = () => { /* onclose follows with the useful information */ };
    ws.onclose = (e) => {
      clearTimeout(openTimeout);
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.closed) return;
      if (!opened) {
        // Refused before it ever opened: on iOS with our certificate this is
        // the expected outcome, and retrying will not change it.
        this.wsBroken = true;
        this.events.onLog(`WebSocket refused (${e.code}) — using POST`);
        this.usePost();
        return;
      }
      this.events.onLog(`WebSocket closed (${e.code}), reconnecting`);
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    const delay = RECONNECT_MS[Math.min(this.attempt, RECONNECT_MS.length - 1)]!;
    this.attempt++;
    this.setStatus('reconnecting');
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.openSocket(), delay);
  }

  // --- post ----------------------------------------------------------------------

  private usePost(): void {
    this.mode = 'post';
    this.postFailures = 0;
    // Optimistic: the first successful response confirms it.
    this.setStatus('connecting');
  }

  private setStatus(status: Status): void {
    if (status === this.status) return;
    this.status = status;
    this.events.onStatus(status, this.mode);
  }
}

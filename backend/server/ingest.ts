//
//  ingest.ts
//  HIVE (server)
//
//  Where phone frames arrive: a WebSocket per phone, or POSTs from phones that
//  cannot open one.
//
//  iOS Safari lets a user tap through a self-signed certificate for the page,
//  but refuses `wss://` to the same host without a word. So the phone tries
//  WebSocket first and falls back to `POST /ingest/<id>` with the very same
//  binary frame as the body; both paths end in `registry.push`. Nothing
//  downstream can tell the difference.
//
<<<<<<< HEAD
//  The one thing that flows back: the wall's snapshot of where the bees are,
//  for the phones' little map — a text message down the socket whenever the
//  wall posts a new one, or as the body of the reply to a POSTed frame when
//  the phone has not seen the current version yet (a 204 otherwise).
//
=======
>>>>>>> 791460b3b24265c8bbf40de2d4abdf0497736a94

import type { IncomingMessage, ServerResponse } from 'node:http';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import { decodeFrame, HEADER_BYTES, MAX_SAMPLES, SAMPLE_BYTES } from '../shared/protocol';
import type { Registry } from './registry';
<<<<<<< HEAD
import type { WallState } from './wall';
=======
>>>>>>> 791460b3b24265c8bbf40de2d4abdf0497736a94

const MAX_FRAME = HEADER_BYTES + MAX_SAMPLES * SAMPLE_BYTES;
const ID_RE = /^[a-zA-Z0-9-]{8,64}$/;

export interface Ingest {
  /** `noServer` WebSocket server; index.ts routes upgrades to it. */
  wss: WebSocketServer;
  /** Handle `POST /ingest/<id>`; returns false when the path is not ours. */
  handlePost: (req: IncomingMessage, res: ServerResponse, pathname: string, query: URLSearchParams) => boolean;
}

<<<<<<< HEAD
export function createIngest(registry: Registry, wall: WallState, log: (line: string) => void): Ingest {
  const sockets = new Set<WebSocket>();
  wall.onChange((text) => { for (const s of sockets) if (s.readyState === s.OPEN && s.bufferedAmount < 8192) s.send(text); });
  /** POST phones: which wall version each has been handed. */
  const handed = new Map<string, number>();
  registry.on('leave', (d) => handed.delete(d.id));

=======
export function createIngest(registry: Registry, log: (line: string) => void): Ingest {
>>>>>>> 791460b3b24265c8bbf40de2d4abdf0497736a94
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME, perMessageDeflate: false });

  wss.on('connection', (socket: WebSocket, req: IncomingMessage) => {
    const url = new URL(req.url ?? '/', 'https://x');
    const id = url.searchParams.get('id') ?? '';
    const name = (url.searchParams.get('name') ?? '').slice(0, 24);
    if (!ID_RE.test(id)) { socket.close(1008, 'bad id'); return; }

<<<<<<< HEAD
    sockets.add(socket);
    if (wall.text) socket.send(wall.text);
=======
>>>>>>> 791460b3b24265c8bbf40de2d4abdf0497736a94
    let alive = true;
    socket.on('pong', () => { alive = true; });
    const heartbeat = setInterval(() => {
      if (!alive) { socket.terminate(); return; }
      alive = false;
      socket.ping();
    }, 10_000);

    socket.on('message', (data, isBinary) => {
      if (!isBinary) return;
      try {
        const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
        registry.push(id, name, 'ws', decodeFrame(buf));
      } catch (err) {
        log(`ws frame from ${id.slice(0, 8)} rejected: ${(err as Error).message}`);
        socket.close(1003, 'bad frame');
      }
    });

    socket.on('close', () => {
      clearInterval(heartbeat);
<<<<<<< HEAD
      sockets.delete(socket);
=======
>>>>>>> 791460b3b24265c8bbf40de2d4abdf0497736a94
      registry.remove(id);
    });
    socket.on('error', (err) => log(`ws ${id.slice(0, 8)}: ${err.message}`));
  });

  const handlePost = (req: IncomingMessage, res: ServerResponse, pathname: string, query: URLSearchParams): boolean => {
    const m = /^\/ingest\/([a-zA-Z0-9-]{8,64})$/.exec(pathname);
    if (!m) return false;
    if (req.method !== 'POST') { res.writeHead(405).end(); return true; }
    const id = m[1]!;
    const name = (query.get('name') ?? '').slice(0, 24);

    // Explicit leave from the phone's Leave button or `pagehide` beacon —
    // POST clients have no socket whose close would tell us.
    if (query.get('bye') === '1') {
      req.resume();
      req.on('end', () => { registry.remove(id); res.writeHead(204).end(); });
      return true;
    }

    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_FRAME) { res.writeHead(413).end(); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (res.writableEnded) return;
      try {
        registry.push(id, name, 'post', decodeFrame(Buffer.concat(chunks)));
<<<<<<< HEAD
        if (wall.text && handed.get(id) !== wall.version) {
          handed.set(id, wall.version);
          res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(wall.text);
        } else {
          res.writeHead(204, { 'Cache-Control': 'no-store' }).end();
        }
=======
        res.writeHead(204, { 'Cache-Control': 'no-store' }).end();
>>>>>>> 791460b3b24265c8bbf40de2d4abdf0497736a94
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'text/plain' }).end((err as Error).message);
      }
    });
    return true;
  };

  return { wss, handlePost };
}

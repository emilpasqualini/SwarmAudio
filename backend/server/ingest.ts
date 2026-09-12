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

import type { IncomingMessage, ServerResponse } from 'node:http';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import { decodeFrame, HEADER_BYTES, MAX_SAMPLES, SAMPLE_BYTES } from '../shared/protocol';
import type { Registry } from './registry';

const MAX_FRAME = HEADER_BYTES + MAX_SAMPLES * SAMPLE_BYTES;
const ID_RE = /^[a-zA-Z0-9-]{8,64}$/;

export interface Ingest {
  /** `noServer` WebSocket server; index.ts routes upgrades to it. */
  wss: WebSocketServer;
  /** Handle `POST /ingest/<id>`; returns false when the path is not ours. */
  handlePost: (req: IncomingMessage, res: ServerResponse, pathname: string, query: URLSearchParams) => boolean;
}

export function createIngest(registry: Registry, log: (line: string) => void): Ingest {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME, perMessageDeflate: false });

  wss.on('connection', (socket: WebSocket, req: IncomingMessage) => {
    const url = new URL(req.url ?? '/', 'https://x');
    const id = url.searchParams.get('id') ?? '';
    const name = (url.searchParams.get('name') ?? '').slice(0, 24);
    if (!ID_RE.test(id)) { socket.close(1008, 'bad id'); return; }

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
        res.writeHead(204, { 'Cache-Control': 'no-store' }).end();
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'text/plain' }).end((err as Error).message);
      }
    });
    return true;
  };

  return { wss, handlePost };
}

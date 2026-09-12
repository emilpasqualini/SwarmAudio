//
//  static.ts
//  HIVE (server)
//
//  Serves the built client. Small on purpose: two HTML pages, a handful of
//  assets, and `no-store` on everything so a phone never runs yesterday's
//  build during a hackathon where the build changes every ten minutes.
//

import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.webmanifest': 'application/manifest+json',
};

<<<<<<< HEAD
/** Pretty routes → files. `/monitor` is the laptop's dashboard, `/wall` the projection. */
=======
/** Pretty routes → files. `/monitor` is the dashboard, everything else the phone app. */
>>>>>>> 791460b3b24265c8bbf40de2d4abdf0497736a94
const ROUTES: Record<string, string> = {
  '/': 'index.html',
  '/index.html': 'index.html',
  '/monitor': 'monitor.html',
  '/monitor.html': 'monitor.html',
<<<<<<< HEAD
  '/wall': 'wall.html',
  '/wall.html': 'wall.html',
=======
>>>>>>> 791460b3b24265c8bbf40de2d4abdf0497736a94
};

export function serveStatic(clientDir: string) {
  return (req: IncomingMessage, res: ServerResponse, pathname: string): boolean => {
    const mapped = ROUTES[pathname] ?? pathname.slice(1);
    const file = normalize(join(clientDir, mapped));
    if (!file.startsWith(clientDir) || !existsSync(file) || !statSync(file).isFile()) return false;

    res.writeHead(200, {
      'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
      // Explicitly allow the sensors for this document; harmless top-level,
      // required if anyone ever iframes the page.
      'Permissions-Policy': 'accelerometer=(self), gyroscope=(self), magnetometer=(self)',
    });
    if (req.method === 'HEAD') { res.end(); return true; }
    createReadStream(file).pipe(res);
    return true;
  };
}

export function notFound(res: ServerResponse, what = 'not found'): void {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(what);
}

//
//  config.ts
//  HIVE (server)
//
//  Everything tunable, read once from the environment.
//

import { resolve } from 'node:path';

const int = (name: string, fallback: number): number => {
  const v = process.env[name];
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
};

export const config = {
  root: resolve(import.meta.dirname, '..'),
  httpsPort: int('HIVE_HTTPS_PORT', 8443),
  httpPort: int('HIVE_HTTP_PORT', 8080),
  /** Initial OSC targets as `host:port[,host:port]`; the dashboard can edit them later. */
  oscTargets: process.env.HIVE_OSC_TARGETS ?? '127.0.0.1:9000',
  /** Swarm feature rate, Hz. */
  swarmHz: int('HIVE_SWARM_HZ', 30),
  /** Dashboard refresh, Hz. */
  monitorHz: int('HIVE_MONITOR_HZ', 10),
  /** A device that has not sent anything for this long has left. */
  deviceTimeoutMs: int('HIVE_DEVICE_TIMEOUT_MS', 3000),
  certDir: resolve(import.meta.dirname, '..', 'certs'),
  configFile: resolve(import.meta.dirname, '..', 'hive.config.json'),
  clientDir: resolve(import.meta.dirname, '..', 'dist', 'client'),
};

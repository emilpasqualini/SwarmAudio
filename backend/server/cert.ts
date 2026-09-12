//
//  cert.ts
//  HIVE (server)
//
//  A self-signed certificate that covers every address we are reachable at.
//
//  Phones only hand out motion sensors to an HTTPS page, and there is no
//  authority that will sign a certificate for 192.168.x.x — so we sign our own
//  and everybody taps through the warning once. The certificate lists the
//  current LAN IPs as subjectAltNames; when the Mac joins a different network
//  the IPs change and the certificate is regenerated on the next start. Android
//  remembers the exception per host, so a stable certificate per network keeps
//  the tap-through to one time.
//

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { X509Certificate } from 'node:crypto';
import selfsigned from 'selfsigned';

export interface Credentials {
  key: string;
  cert: string;
  /** True when a new certificate was written this run. */
  regenerated: boolean;
}

export function loadOrCreateCertificate(dir: string, ips: string[]): Credentials {
  mkdirSync(dir, { recursive: true });
  const keyPath = join(dir, 'hive-key.pem');
  const certPath = join(dir, 'hive-cert.pem');

  if (existsSync(keyPath) && existsSync(certPath)) {
    const cert = readFileSync(certPath, 'utf8');
    if (covers(cert, ips)) return { key: readFileSync(keyPath, 'utf8'), cert, regenerated: false };
  }

  const altNames = [
    { type: 2, value: 'localhost' },
    { type: 2, value: 'hive.local' },
    { type: 7, ip: '127.0.0.1' },
    ...ips.map((ip) => ({ type: 7, ip })),
  ];
  const generated = selfsigned.generate(
    [{ name: 'commonName', value: 'HIVE swarm audio' }, { name: 'organizationName', value: 'HIVE' }],
    {
      days: 825, // Apple's maximum for a trusted leaf; irrelevant for tap-through but harmless
      keySize: 2048,
      algorithm: 'sha256',
      extensions: [
        { name: 'basicConstraints', cA: false },
        { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
        { name: 'extKeyUsage', serverAuth: true },
        { name: 'subjectAltName', altNames },
      ],
    },
  );
  writeFileSync(keyPath, generated.private, { mode: 0o600 });
  writeFileSync(certPath, generated.cert);
  return { key: generated.private, cert: generated.cert, regenerated: true };
}

function covers(certPem: string, ips: string[]): boolean {
  try {
    const x = new X509Certificate(certPem);
    if (new Date(x.validTo).getTime() < Date.now() + 24 * 3600 * 1000) return false;
    const san = x.subjectAltName ?? '';
    return ips.every((ip) => san.includes(`IP Address:${ip}`));
  } catch {
    return false;
  }
}

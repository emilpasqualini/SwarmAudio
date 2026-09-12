//
//  lan.ts
//  HIVE (server)
//
//  Which addresses a phone on the same Wi-Fi can reach us at.
//

import { networkInterfaces } from 'node:os';

export interface LanAddress {
  iface: string;
  address: string;
}

/** Non-internal IPv4 addresses, Wi-Fi/Ethernet first, VPN/virtual last. */
export function lanAddresses(): LanAddress[] {
  const out: LanAddress[] = [];
  for (const [iface, infos] of Object.entries(networkInterfaces())) {
    for (const info of infos ?? []) {
      if (info.family !== 'IPv4' || info.internal) continue;
      out.push({ iface, address: info.address });
    }
  }
  // en0/en1 are the physical interfaces on a Mac; utun*/bridge*/vmnet* are
  // VPNs and virtual machines, which phones cannot reach.
  const rank = (name: string): number =>
    /^en\d/.test(name) ? 0 : /^(utun|bridge|vmnet|awdl|llw)/.test(name) ? 2 : 1;
  return out.sort((a, b) => rank(a.iface) - rank(b.iface) || a.iface.localeCompare(b.iface));
}

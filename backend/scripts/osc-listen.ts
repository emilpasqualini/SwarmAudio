// Prints every OSC packet arriving on a UDP port — a stand-in for Pd/Max
// when checking that the server is sending. `npm run osc:listen -- 9000`
import { createSocket } from 'node:dgram';
import { decodePacket } from '../server/osc-encode';

const port = Number(process.argv[2] ?? process.env.PORT ?? 9000);
const socket = createSocket('udp4');
const counts = new Map<string, number>();
let lastPrint = 0;

socket.on('message', (buf, rinfo) => {
  for (const m of decodePacket(buf)) {
    counts.set(m.address, (counts.get(m.address) ?? 0) + 1);
    // Print rare messages immediately, streams once a second with counts.
    if (!/\/(acc|gyro|mag|energy|motion|sync|count)$/.test(m.address)) {
      console.log(`${m.address} ${m.args.map((a) => typeof a === 'number' ? a.toFixed(3) : a).join(' ')}   from ${rinfo.address}`);
    }
  }
  const now = Date.now();
  if (now - lastPrint > 1000) {
    lastPrint = now;
    const summary = [...counts.entries()].sort().map(([a, n]) => `${a}=${n}/s`).join('  ');
    if (summary) console.log(summary);
    counts.clear();
  }
});
socket.bind(port, () => console.log(`listening for OSC on udp ${port}`));

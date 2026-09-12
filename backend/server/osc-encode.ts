//
//  osc-encode.ts
//  HIVE (server)
//
//  OSC 1.0 message and bundle encoding, the twenty lines of it we need.
//
//  Written rather than imported: the `osc` npm package drags in serialport and
//  a years-old `ws`, and all we do is write floats, ints and strings big-endian
//  behind a padded address. Pd (`oscparse`), Max (`udpreceive`) and SC read
//  exactly this.
//

export type OscArg = number | string | { i: number } | { f: number };

const pad4 = (n: number): number => (n + 4) & ~3; // string length incl. NUL, rounded up

function writeString(buf: Buffer, offset: number, s: string): number {
  const len = buf.write(s, offset, 'ascii');
  const end = offset + pad4(len);
  buf.fill(0, offset + len, end);
  return end;
}

/**
 * Encodes one message. Plain numbers become float32 unless wrapped `{ i: n }`;
 * strings become OSC strings.
 */
export function encodeMessage(address: string, args: OscArg[] = []): Buffer {
  let tags = ',';
  let size = pad4(address.length) + pad4(1 + args.length);
  for (const a of args) {
    if (typeof a === 'string') { tags += 's'; size += pad4(Buffer.byteLength(a, 'ascii')); }
    else if (typeof a === 'number') { tags += 'f'; size += 4; }
    else if ('i' in a) { tags += 'i'; size += 4; }
    else { tags += 'f'; size += 4; }
  }
  const buf = Buffer.allocUnsafe(size);
  let o = writeString(buf, 0, address);
  o = writeString(buf, o, tags);
  for (const a of args) {
    if (typeof a === 'string') o = writeString(buf, o, a);
    else if (typeof a === 'number') { buf.writeFloatBE(a, o); o += 4; }
    else if ('i' in a) { buf.writeInt32BE(a.i | 0, o); o += 4; }
    else { buf.writeFloatBE(a.f, o); o += 4; }
  }
  return buf;
}

/** Bundle with the "immediately" time tag; elements are already-encoded messages. */
export function encodeBundle(elements: Buffer[]): Buffer {
  let size = 8 + 8;
  for (const e of elements) size += 4 + e.length;
  const buf = Buffer.allocUnsafe(size);
  let o = writeString(buf, 0, '#bundle');
  buf.writeUInt32BE(0, o); buf.writeUInt32BE(1, o + 4); o += 8; // time tag 1 = now
  for (const e of elements) {
    buf.writeUInt32BE(e.length, o); o += 4;
    e.copy(buf, o); o += e.length;
  }
  return buf;
}

// --- decoding, for the listener script and tests ------------------------------

export interface OscMessage { address: string; args: (number | string)[] }

function readString(buf: Buffer, offset: number): [string, number] {
  let end = offset;
  while (end < buf.length && buf[end] !== 0) end++;
  return [buf.toString('ascii', offset, end), offset + pad4(end - offset)];
}

export function decodePacket(buf: Buffer): OscMessage[] {
  if (buf.length >= 8 && buf.toString('ascii', 0, 7) === '#bundle') {
    const out: OscMessage[] = [];
    let o = 16;
    while (o + 4 <= buf.length) {
      const len = buf.readUInt32BE(o); o += 4;
      out.push(...decodePacket(buf.subarray(o, o + len)));
      o += len;
    }
    return out;
  }
  let [address, o] = readString(buf, 0);
  let tags = '';
  if (o < buf.length && buf[o] === 0x2c) { [tags, o] = readString(buf, o); tags = tags.slice(1); }
  const args: (number | string)[] = [];
  for (const t of tags) {
    if (t === 'f') { args.push(buf.readFloatBE(o)); o += 4; }
    else if (t === 'i') { args.push(buf.readInt32BE(o)); o += 4; }
    else if (t === 'd') { args.push(buf.readDoubleBE(o)); o += 8; }
    else if (t === 's') { let s; [s, o] = readString(buf, o); args.push(s); }
    else if (t === 'T') args.push(1);
    else if (t === 'F') args.push(0);
    else break; // unsupported type: stop rather than misread
  }
  return [{ address, args }];
}

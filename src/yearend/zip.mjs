// A minimal ZIP writer and reader (deflate, UTF-8 names, no ZIP64): enough for a packet of a few
// dozen household documents. The reader exists for tests and checks every CRC.

import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';

const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };

function dosTime(d) {
  const t = (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1);
  const dt = ((Math.max(1980, d.getUTCFullYear()) - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate();
  return { t, dt };
}

// Writes entries [{name, data: Buffer}] through write(buffer) (awaited in order). Returns the total
// number of bytes written.
export async function writeZip(entries, write, { date = new Date() } = {}) {
  const { t, dt } = dosTime(date);
  const central = [];
  let offset = 0;
  const put = async (buf) => { await write(buf); offset += buf.length; };
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const data = Buffer.from(e.data);
    const comp = deflateRawSync(data);
    const crc = crc32(data);
    const start = offset;
    const common = Buffer.concat([u16(20), u16(0x0800), u16(8), u16(t), u16(dt), u32(crc), u32(comp.length), u32(data.length), u16(name.length), u16(0)]);
    await put(Buffer.concat([u32(0x04034b50), common, name]));
    await put(comp);
    central.push(Buffer.concat([u32(0x02014b50), u16(20), common, u16(0), u16(0), u16(0), u32(0), u32(start), name]));
  }
  const cdStart = offset;
  for (const c of central) await put(c);
  const cdSize = offset - cdStart;
  await put(Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(central.length), u16(central.length), u32(cdSize), u32(cdStart), u16(0)]));
  return offset;
}

// Buffer -> [{name, data}] from the central directory; throws on a bad signature or CRC.
export function readZip(buf) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error('not a zip');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central directory');
    const crc = buf.readUInt32LE(p + 16), csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString('utf8');
    const lstart = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = inflateRawSync(buf.subarray(lstart, lstart + csize));
    if (crc32(data) !== crc) throw new Error(`bad crc for ${name}`);
    out.push({ name, data });
    p += 46 + nlen + xlen + clen;
  }
  return out;
}

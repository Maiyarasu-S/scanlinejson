/* png.js: just enough PNG to write flat-colour images from Node with no packages.
   Images are 8-bit indexed colour: a palette of [r, g, b] and one palette index per pixel. */
'use strict';
const zlib = require('zlib');

const CRC = new Uint32Array(256);
for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC[n] = c >>> 0; }
function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4), crc = Buffer.alloc(4), td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  len.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

class Bitmap {
  constructor(w, h, palette, fill = 0) { this.w = w; this.h = h; this.palette = palette; this.px = new Uint8Array(w * h).fill(fill); }
  rect(x, y, w, h, c) {
    const x0 = Math.max(0, Math.floor(x)), y0 = Math.max(0, Math.floor(y)), x1 = Math.min(this.w, Math.floor(x + w)), y1 = Math.min(this.h, Math.floor(y + h));
    for (let j = y0; j < y1; j++) this.px.fill(c, j * this.w + x0, j * this.w + x1);
  }
  get(x, y) { return this.px[y * this.w + x]; }
  png() {
    const { w, h } = this, ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 3;      /* 8-bit, indexed */
    const raw = Buffer.alloc((w + 1) * h);
    for (let y = 0; y < h; y++) { raw[y * (w + 1)] = 0; raw.set(this.px.subarray(y * w, (y + 1) * w), y * (w + 1) + 1); }
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('PLTE', Buffer.from(this.palette.flat())),
      chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
  }
}

/* An .ico holding PNG images (supported by every current browser). */
function ico(pngs) {
  const head = Buffer.alloc(6 + 16 * pngs.length);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(pngs.length, 4);
  let off = head.length;
  pngs.forEach((p, i) => {
    const e = 6 + 16 * i, w = p.readUInt32BE(16), h = p.readUInt32BE(20);
    head[e] = w >= 256 ? 0 : w; head[e + 1] = h >= 256 ? 0 : h;
    head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6); head.writeUInt32LE(p.length, e + 8); head.writeUInt32LE(off, e + 12);
    off += p.length;
  });
  return Buffer.concat([head, ...pngs]);
}

/* Width and height of a PNG, and whether its chunks' checksums are right. Used by the tests. */
function inspect(buf) {
  if (buf.slice(0, 8).toString('hex') !== '89504e470d0a1a0a') return null;
  let i = 8, ok = true;
  while (i < buf.length) {
    const len = buf.readUInt32BE(i), td = buf.slice(i + 4, i + 8 + len);
    if (crc32(td) !== buf.readUInt32BE(i + 8 + len)) ok = false;
    i += 12 + len;
  }
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20), ok };
}

module.exports = { Bitmap, ico, inspect, crc32 };

// Regenerates the toolbar icons. Run: `node icons/generate.js`.
// No dependencies — emits valid PNGs with Node's built-in zlib.
const zlib = require('node:zlib');
const fs = require('node:fs');
const path = require('node:path');

const GREEN = [117, 153, 0];   // #759900 Lichess green
const WHITE = [255, 255, 255];

const crcTable = (() => {
  const t = new Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

function png(size) {
  const px = (x, y) => (y * size + x) * 4;
  const buf = Buffer.alloc(size * size * 4); // RGBA, transparent
  const r = size * 0.22; // corner radius for the rounded square

  const inRounded = (x, y) => {
    const nx = Math.min(x, size - 1 - x);
    const ny = Math.min(y, size - 1 - y);
    if (nx >= r || ny >= r) return true;
    const dx = r - nx, dy = r - ny;
    return dx * dx + dy * dy <= r * r;
  };

  // A simple pawn glyph centred in the square.
  const cx = size / 2;
  const headCy = size * 0.34, headR = size * 0.15;
  const inPawn = (x, y) => {
    const fx = x + 0.5, fy = y + 0.5;
    // head (circle)
    if ((fx - cx) ** 2 + (fy - headCy) ** 2 <= headR * headR) return true;
    // body: trapezoid widening toward the base
    const top = size * 0.46, bottom = size * 0.74;
    if (fy >= top && fy <= bottom) {
      const halfW = size * (0.07 + 0.10 * ((fy - top) / (bottom - top)));
      if (Math.abs(fx - cx) <= halfW) return true;
    }
    // base bar
    const baseTop = size * 0.72, baseBottom = size * 0.80;
    if (fy >= baseTop && fy <= baseBottom && Math.abs(fx - cx) <= size * 0.22) return true;
    return false;
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!inRounded(x, y)) continue;
      const [cr, cg, cb] = inPawn(x, y) ? WHITE : GREEN;
      const i = px(x, y);
      buf[i] = cr; buf[i + 1] = cg; buf[i + 2] = cb; buf[i + 3] = 255;
    }
  }

  // Add the per-scanline filter byte (0 = none).
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    buf.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // colour type RGBA
  // 10,11,12 = compression/filter/interlace = 0

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

for (const size of [16, 48, 128]) {
  const out = path.join(__dirname, `icon${size}.png`);
  fs.writeFileSync(out, png(size));
  console.log('wrote', out);
}

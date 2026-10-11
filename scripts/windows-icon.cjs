const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
function crc32(bytes) { let crc = -1; for (const byte of bytes) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); } return (crc ^ -1) >>> 0; }
function chunk(type, data) { const name = Buffer.from(type); const size = Buffer.alloc(4); size.writeUInt32BE(data.length); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([name, data]))); return Buffer.concat([size, name, data, crc]); }
function png(size) {
  const rows = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const dx = x / size - 0.5, dy = y / size - 0.5, radius = Math.hypot(dx, dy);
    const mark = radius > 0.22 && radius < 0.32 && (dx < 0.13 || Math.abs(dy) > 0.19);
    const offset = y * (size * 4 + 1) + 1 + x * 4;
    rows.set(mark ? [255, 255, 255, 255] : [233, 117, 64, 255], offset);
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(size); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
function writeIcons(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const sizes = [16, 32, 48, 256], images = sizes.map(png), header = Buffer.alloc(6 + sizes.length * 16);
  header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4); let offset = header.length;
  images.forEach((image, i) => { const at = 6 + i * 16; header[at] = header[at + 1] = sizes[i] % 256; header.writeUInt16LE(1, at + 4); header.writeUInt16LE(32, at + 6); header.writeUInt32LE(image.length, at + 8); header.writeUInt32LE(offset, at + 12); offset += image.length; });
  fs.writeFileSync(path.join(dir, 'ClawLink.ico'), Buffer.concat([header, ...images]));
  fs.writeFileSync(path.join(dir, 'tray.png'), png(32));
}
module.exports = { writeIcons };

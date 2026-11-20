import { deflateSync } from 'node:zlib';
import { expect, it } from 'vitest';
import { prepareImportImage } from './images.js';

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes: Buffer) {
  let c = 0xffffffff;
  for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}
function png(width: number, height: number) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const offset = y * (width * 3 + 1);
    rows[offset] = 0;
    for (let x = 0; x < width * 3; x += 1) rows[offset + 1 + x] = (x + y) % 256;
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
function jpegEdge(bytes: Buffer) {
  let offset = 2;
  while (offset + 9 <= bytes.length && bytes[offset] === 0xff) {
    const marker = bytes[offset + 1]!;
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (marker === 0xda || marker === 0xd9) break;
    const size = bytes.readUInt16BE(offset + 2);
    if ([0xc0, 0xc1, 0xc2].includes(marker))
      return { width: bytes.readUInt16BE(offset + 7), height: bytes.readUInt16BE(offset + 5) };
    offset += 2 + size;
  }
  throw new Error('no JPEG frame header');
}

it('downscales a large screenshot so the vision request stays small', async () => {
  const file = new File([png(3000, 2000)], 'large.png', { type: 'image/png' });
  const prepared = await prepareImportImage(file);
  const bytes = Buffer.from(prepared.data, 'base64');
  const size =
    prepared.mimeType === 'image/jpeg'
      ? jpegEdge(bytes)
      : { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  expect(Math.max(size.width, size.height)).toBeLessThanOrEqual(1280);
});

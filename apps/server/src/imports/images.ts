import { createNodePhotonImages } from '@earendil-works/pi-durable/images/node';
import { IMPORT_IMAGE_MAX_BYTES } from '@nextstop/core';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { join } from 'node:path';
import { HttpFault, readBody } from '../http.js';

type ImageType = 'image/png' | 'image/jpeg';
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const jpegFrames = new Set([0xc0, 0xc1, 0xc2]);
const pixelsLimit = 12_000_000;
function supportedSize(width: number, height: number) {
  return (
    width > 0 && height > 0 && width <= 10_000 && height <= 10_000 && width * height <= pixelsLimit
  );
}

function jpegSizeValid(bytes: Buffer) {
  if (bytes.length < 4 || bytes.readUInt16BE(0) !== 0xffd8) return false;
  let offset = 2;
  while (offset + 4 <= bytes.length && bytes[offset] === 0xff) {
    const marker = bytes[offset + 1];
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (marker === 0xda || marker === 0xd9) return false;
    const size = bytes.readUInt16BE(offset + 2);
    if (size < 2 || offset + 2 + size > bytes.length) return false;
    if (marker !== undefined && jpegFrames.has(marker)) {
      return (
        size >= 8 && supportedSize(bytes.readUInt16BE(offset + 7), bytes.readUInt16BE(offset + 5))
      );
    }
    offset += 2 + size;
  }
  return false;
}

function matchesType(type: string, bytes: Buffer): type is ImageType {
  if (type === 'image/jpeg') return jpegSizeValid(bytes);
  return (
    type === 'image/png' &&
    bytes.length >= 33 &&
    bytes.subarray(0, 8).equals(pngSignature) &&
    bytes.readUInt32BE(8) === 13 &&
    bytes.toString('ascii', 12, 16) === 'IHDR' &&
    supportedSize(bytes.readUInt32BE(16), bytes.readUInt32BE(20))
  );
}

let processor: ReturnType<typeof createNodePhotonImages> | undefined;
export async function readImportImage(request: IncomingMessage) {
  const contentType = request.headers['content-type'];
  if (!contentType || !/^multipart\/form-data\s*;/i.test(contentType))
    throw new HttpFault('INVALID_IMAGE');
  const body = await readBody(request, IMPORT_IMAGE_MAX_BYTES + 8192);
  let form: FormData;
  try {
    form = await new Response(body, { headers: { 'content-type': contentType } }).formData();
  } catch {
    throw new HttpFault('INVALID_IMAGE');
  }
  const file = form.get('image');
  if (!(file instanceof File) || [...form.keys()].length !== 1)
    throw new HttpFault('INVALID_IMAGE');
  if (file.size > IMPORT_IMAGE_MAX_BYTES) throw new HttpFault('REQUEST_TOO_LARGE');
  const original = Buffer.from(await file.arrayBuffer());
  if (!matchesType(file.type, original)) throw new HttpFault('INVALID_IMAGE');

  processor ??= createNodePhotonImages();
  const prepared = await (
    await processor
  ).prepare(Uint8Array.from(original), file.type, {
    maxWidth: 1800,
    maxHeight: 3000,
    maxBytes: 2 * 1024 * 1024,
  });
  if (!prepared || (prepared.mimeType !== 'image/jpeg' && prepared.mimeType !== 'image/png'))
    throw new HttpFault('INVALID_IMAGE');
  const mimeType: ImageType = prepared.mimeType;
  return { original, data: prepared.data, mimeType };
}

export function createImportImages(dataDir: string) {
  // All components below the configured data directory are server-assigned identifiers.
  const location = (userId: string, id: string) => join(dataDir, 'import-images', userId, id);
  return {
    async put(userId: string, id: string, image: Awaited<ReturnType<typeof readImportImage>>) {
      const directory = location(userId, id);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(join(directory, 'original'), image.original, { flag: 'wx', mode: 0o600 });
      await writeFile(join(directory, 'normalized'), Buffer.from(image.data, 'base64'), {
        flag: 'wx',
        mode: 0o600,
      });
    },
    read(userId: string, id: string) {
      return readFile(join(location(userId, id), 'normalized'));
    },
  };
}

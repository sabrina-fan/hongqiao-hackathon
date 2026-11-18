import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  anonymousDataValidator,
  importBatchValidator,
  importReviewValidator,
  tripDetailValidator,
} from '@nextstop/core';
import { expect, it, vi } from 'vitest';
import { createApp } from './app.js';
import { createAmap } from './radar/amap.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return { ...fs, rm: vi.fn<typeof fs.rm>(fs.rm) };
});

const poi = { id: 'cleanup-poi', name: '合成收藏', address: '合成地址' };
// Distinct one-pixel PNGs let the fixture detect a survivor receiving another image's bytes.
const png = {
  single: Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4ICICAAMQARkzdtKQAAAAAElFTkSuQmCC',
    'base64',
  ),
  shared: Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGMQ+SACAAI0ARm7rQQkAAAAAElFTkSuQmCC',
    'base64',
  ),
  pending: Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGMQEfkAAAFYARnLc0DHAAAAAElFTkSuQmCC',
    'base64',
  ),
  unrelated: Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP48EEEAATIAfXuneOLAAAAAElFTkSuQmCC',
    'base64',
  ),
};

async function listen(server: ReturnType<typeof createApp>) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}/api/v1`;
}

async function checkedJson<T>(
  response: Response,
  status: number,
  check: (body: unknown) => body is T,
) {
  assert.equal(response.status, status, response.url);
  const body: unknown = await response.json();
  assert(check(body), response.url);
  return body;
}

async function expectError(response: Response, status: number, code: string) {
  assert.equal(response.status, status, response.url);
  const body: unknown = await response.json();
  expect(body).toMatchObject({ error: { code } });
}

const operations = ['batch', 'source', 'trip'] as const;
const faults = ['before unlink', 'after original unlink'] as const;

it.each(operations.flatMap((operation) => faults.map((fault) => ({ operation, fault }))))(
  'preserves committed $operation deletion after cleanup fails $fault',
  async ({ operation, fault }) => {
    const dataDir = await mkdtemp(join(tmpdir(), 'nextstop-cleanup-regression-'));
    const options = {
      dataDir,
      cookieSecret: 'test-only-cleanup-regression-signing-value',
      map: createAmap({
        key: 'fixture',
        fetcher: async () => Response.json({ status: '1', info: 'OK', pois: [poi] }),
      }),
      vision: async () => ({
        kind: 'text',
        name: poi.name,
        excerpt: '合成来源',
        confidence: 'high',
      }),
    } satisfies NonNullable<Parameters<typeof createApp>[0]>;
    let server = createApp(options);
    try {
      let base = await listen(server);
      const session = await fetch(`${base}/sessions`, { method: 'POST' });
      expect(session.status).toBe(204);
      const cookie = session.headers.get('set-cookie')?.split(';')[0];
      assert(cookie);
      const call = (path: string, method = 'GET') =>
        fetch(base + path, { method, headers: { cookie } });
      const post = (path: string, body: unknown) =>
        fetch(base + path, {
          method: 'POST',
          headers:
            body instanceof FormData ? { cookie } : { cookie, 'content-type': 'application/json' },
          body: body instanceof FormData ? body : JSON.stringify(body),
        });
      const createTrip = async (destination: string) =>
        checkedJson(
          await post('/trips', {
            destination,
            date: '2026-11-20',
            start: '09:00',
            end: '20:00',
            time_zone: 'Asia/Shanghai',
          }),
          201,
          tripDetailValidator.check,
        );
      const other = await createTrip('无关旅行');
      const otherForm = new FormData();
      otherForm.set('image', new File([png.unrelated], '无关来源.png', { type: 'image/png' }));
      const unrelated = await checkedJson(
        await post('/imports', otherForm),
        201,
        importReviewValidator.check,
      );
      const owned = await createTrip('目标旅行');
      const form = new FormData();
      for (const [name, bytes] of Object.entries({
        single: png.single,
        shared: png.shared,
        pending: png.pending,
      })) {
        form.append('images', new File([bytes], `${name}.png`, { type: 'image/png' }));
      }
      const initial = await checkedJson(
        await post('/import-batches', form),
        202,
        importBatchValidator.check,
      );
      const batchPath = `/import-batches/${initial.batch_id}`;
      const readBatch = async () =>
        checkedJson(await call(batchPath), 200, importBatchValidator.check);
      const ready = await vi.waitFor(async () => {
        const batch = await readBatch();
        expect(batch.items.map(({ kind }) => kind)).toEqual(['ready', 'ready', 'ready']);
        return batch;
      });
      const [single, shared, pending] = ready.items;
      assert(single && shared && pending);
      const saved = await checkedJson(
        await post(`${batchPath}/confirm`, {
          revision: ready.revision,
          new_count: 1,
          selections: [single, shared].map(({ import_id }) => ({ import_id, poi_id: poi.id })),
        }),
        200,
        importBatchValidator.check,
      );
      const readData = async () =>
        checkedJson(await call('/me/data'), 200, anonymousDataValidator.check);
      const before = await readData();
      expect(before.uploads).toHaveLength(4);
      for (const { import_id } of [single, shared, pending, unrelated]) {
        expect(before.uploads.find((entry) => entry.import_id === import_id)?.trip_id).toBe(
          import_id === unrelated.import_id ? other.trip_id : owned.trip_id,
        );
      }
      expect(before.places).toMatchObject([
        { sources: [{ import_id: single.import_id }, { import_id: shared.import_id }] },
      ]);

      const users = join(dataDir, 'users');
      const databases = async () =>
        (await readdir(users)).filter((file) => file.endsWith('.sqlite'));
      const sqliteFiles = await databases();
      const [database] = sqliteFiles;
      assert(sqliteFiles.length === 1 && database);
      const images = join(dataDir, 'import-images', database.slice(0, -'.sqlite'.length));
      const importPath = (id: string) => `/imports/${id}`;
      const batchItem = (id: string) => `${batchPath}/items/${id}`;
      const tripPath = `/trips/${owned.trip_id}`;
      async function picture(id: string, original: Buffer, paths: string[]) {
        const directory = join(images, id);
        expect(await readFile(join(directory, 'original'))).toEqual(original);
        return {
          id,
          directory,
          paths,
          original,
          normalized: await readFile(join(directory, 'normalized')),
        };
      }
      const singleImage = await picture(single.import_id, png.single, [
        `${batchItem(single.import_id)}/image`,
        `${importPath(single.import_id)}/image`,
      ]);
      const sharedImage = await picture(shared.import_id, png.shared, [
        `${batchItem(shared.import_id)}/image`,
        `${importPath(shared.import_id)}/image`,
      ]);
      const pendingImage = await picture(pending.import_id, png.pending, [
        `${batchItem(pending.import_id)}/image`,
      ]);
      const unrelatedImage = await picture(unrelated.import_id, png.unrelated, [
        `${importPath(unrelated.import_id)}/image`,
      ]);
      const pictures = [singleImage, sharedImage, pendingImage, unrelatedImage];
      expect(new Set(pictures.map(({ normalized }) => normalized.toString('base64'))).size).toBe(
        pictures.length,
      );
      async function intact(image: (typeof pictures)[number]) {
        expect((await readdir(image.directory)).sort()).toEqual(['normalized', 'original']);
        expect(await readFile(join(image.directory, 'original'))).toEqual(image.original);
        expect(await readFile(join(image.directory, 'normalized'))).toEqual(image.normalized);
        for (const path of image.paths) {
          const response = await call(path);
          assert.equal(response.status, 200, path);
          assert.deepEqual(Buffer.from(await response.arrayBuffer()), image.normalized, path);
        }
      }
      for (const image of pictures) await intact(image);

      const target = operation === 'source' ? singleImage : pendingImage;
      const remove = (revision: number) => {
        switch (operation) {
          case 'batch':
            return post(`${batchItem(target.id)}/remove`, { revision });
          case 'source':
            return call(importPath(target.id), 'DELETE');
          case 'trip':
            return call(tripPath, 'DELETE');
        }
      };
      const diskRemove = vi.mocked(rm);
      const realRemove = diskRemove.getMockImplementation();
      assert(realRemove);
      diskRemove.mockClear();
      diskRemove.mockImplementation(async (path, options) => {
        if (path !== target.directory) return realRemove(path, options);
        if (fault === 'after original unlink') await realRemove(join(target.directory, 'original'));
        throw Object.assign(new Error('Controlled screenshot cleanup failure'), { code: 'EACCES' });
      });
      try {
        await expectError(await remove(saved.revision), 500, 'INTERNAL_ERROR');
      } finally {
        diskRemove.mockImplementation(realRemove);
      }
      const imageRemovals = () =>
        diskRemove.mock.calls
          .map(([path]) => path)
          .filter((path) => typeof path === 'string' && path.startsWith(`${images}/`));
      expect(imageRemovals()).toEqual([target.directory]);

      await server[Symbol.asyncDispose]();
      server = createApp(options);
      base = await listen(server);
      const expectedBatch = {
        ...saved,
        revision: saved.revision + 1,
        items: saved.items.filter(({ import_id }) => import_id !== target.id),
      };
      const expectedData = {
        trips: before.trips.filter(
          ({ trip_id }) => operation !== 'trip' || trip_id !== owned.trip_id,
        ),
        uploads: before.uploads
          .filter(({ import_id }) => import_id !== target.id)
          .map((upload) =>
            operation === 'trip' && upload.trip_id === owned.trip_id
              ? { ...upload, trip_id: null }
              : upload,
          ),
        places: before.places.map((place) => ({
          ...place,
          sources: place.sources.filter(({ import_id }) => import_id !== target.id),
        })),
      };
      async function checkCommittedState() {
        expect(await databases()).toEqual([database]);
        expect(await readBatch()).toEqual(expectedBatch);
        expect(await readData()).toEqual(expectedData);
        if (operation === 'trip') await expectError(await call(tripPath), 404, 'TRIP_NOT_FOUND');
        await expectError(await call(importPath(target.id)), 404, 'IMPORT_NOT_FOUND');
        for (const path of [`${batchItem(target.id)}/image`, `${importPath(target.id)}/image`]) {
          await expectError(await call(path), 404, 'IMPORT_NOT_FOUND');
        }
        for (const image of pictures.filter(({ id }) => id !== target.id)) await intact(image);
        const copies = fault === 'before unlink' ? ['normalized', 'original'] : ['normalized'];
        expect((await readdir(target.directory)).sort()).toEqual(copies);
        expect(await readFile(join(target.directory, 'normalized'))).toEqual(target.normalized);
        if (fault === 'before unlink') {
          assert.deepEqual(await readFile(join(target.directory, 'original')), target.original);
        }
      }
      await checkCommittedState();
      if (operation === 'batch') {
        await expectError(await remove(saved.revision), 409, 'IMPORT_STALE');
        await expectError(await remove(expectedBatch.revision), 404, 'IMPORT_NOT_FOUND');
      } else {
        assert.equal((await remove(saved.revision)).status, 204);
      }
      // Replay currently starts from committed records and cannot rediscover these orphan files.
      await checkCommittedState();
      expect(imageRemovals()).toEqual([target.directory]);
    } finally {
      try {
        await server[Symbol.asyncDispose]();
      } finally {
        await rm(dataDir, { recursive: true, force: true });
      }
    }
  },
);

import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  anonymousDataValidator,
  ERASE_BINDING_HEADER,
  eraseBindingValidator,
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

async function eraseGuest(base: string, cookie: string) {
  const settings = await fetch(`${base}/me/data?include=pending_deletions`, {
    headers: { cookie },
  });
  assert.equal(settings.status, 200);
  const binding = settings.headers.get(ERASE_BINDING_HEADER);
  assert(eraseBindingValidator.check(binding));
  return fetch(`${base}/me/data`, {
    method: 'DELETE',
    headers: { cookie, [ERASE_BINDING_HEADER]: binding },
  });
}

async function expectError(response: Response, status: number, code: string) {
  assert.equal(response.status, status, response.url);
  const body: unknown = await response.json();
  expect(body).toMatchObject({ error: { code } });
}

const cleanupApp = (dataDir: string) =>
  createApp({
    dataDir,
    cookieSecret: 'test-only-cleanup-regression-signing-value',
    map: createAmap({
      key: 'fixture',
      fetcher: async () => Response.json({ status: '1', info: 'OK', pois: [poi] }),
    }),
    vision: async () => ({ kind: 'text', name: poi.name, excerpt: '合成来源', confidence: 'high' }),
  });

const operations = ['batch', 'source', 'trip'] as const;
const faults = ['before unlink', 'after original unlink'] as const;

it.each(operations.flatMap((operation) => faults.map((fault) => ({ operation, fault }))))(
  'finishes committed $operation cleanup on retry after failure $fault',
  async ({ operation, fault }) => {
    const dataDir = await mkdtemp(join(tmpdir(), 'nextstop-cleanup-regression-'));
    let server = cleanupApp(dataDir);
    try {
      let base = await listen(server);
      const session = await fetch(`${base}/sessions`, { method: 'POST' });
      expect(session.status).toBe(204);
      const cookie = session.headers.get('set-cookie')?.split(';')[0];
      assert(cookie);
      const call = (path: string, method = 'GET') =>
        fetch(base + path, { method, headers: { cookie } });
      const post = (path: string, body: unknown, headers?: Record<string, string>) =>
        fetch(base + path, {
          method: 'POST',
          headers:
            body instanceof FormData
              ? { cookie }
              : { cookie, 'content-type': 'application/json', ...headers },
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
      async function uploadSingle(bytes: Buffer<ArrayBuffer>, name: string) {
        const body = new FormData();
        body.set('image', new File([bytes], name, { type: 'image/png' }));
        return checkedJson(await post('/imports', body), 201, importReviewValidator.check);
      }
      const other = await createTrip('无关旅行');
      const unrelated = await uploadSingle(png.unrelated, '无关来源.png');
      const owned = await createTrip('目标旅行');
      // Identical bytes on a different trip must not make the unrelated upload a cleanup target.
      const earlierTarget =
        operation === 'trip' ? await uploadSingle(png.unrelated, '先清理的来源.png') : null;
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
      }, 5_000);
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
      const settingsPath = '/me/data?include=pending_deletions';
      const pendingDeletion =
        operation === 'batch'
          ? []
          : [{ kind: operation, id: operation === 'source' ? single.import_id : owned.trip_id }];
      const before = await readData();
      const fixtures = [single, shared, pending, unrelated];
      if (earlierTarget) fixtures.push(earlierTarget);
      expect(before.uploads).toHaveLength(fixtures.length);
      for (const { import_id } of fixtures) {
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
      const earlierImage = earlierTarget
        ? await picture(earlierTarget.import_id, png.unrelated, [
            `${importPath(earlierTarget.import_id)}/image`,
          ])
        : null;
      if (earlierImage) await intact(earlierImage);

      const target = operation === 'source' ? singleImage : pendingImage;
      const targets = earlierImage ? [earlierImage, target] : [target];
      const targetIds = new Set(targets.map(({ id }) => id));
      const targetDirectories = targets.map(({ directory }) => directory);
      const remove = (revision: number, allowRetired = false) => {
        switch (operation) {
          case 'batch':
            return post(
              `${batchItem(target.id)}/remove`,
              { revision },
              allowRetired ? { 'x-nextstop-allow-retired-removal': '1' } : undefined,
            );
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
      expect(imageRemovals()).toEqual(targetDirectories);
      if (earlierImage) await assert.rejects(readdir(earlierImage.directory), { code: 'ENOENT' });

      await server[Symbol.asyncDispose]();
      server = cleanupApp(dataDir);
      base = await listen(server);
      const expectedBatch = {
        ...saved,
        revision: saved.revision + 1,
        items: saved.items.filter(({ import_id }) => !targetIds.has(import_id)),
      };
      const expectedData = {
        trips: before.trips.filter(
          ({ trip_id }) => operation !== 'trip' || trip_id !== owned.trip_id,
        ),
        uploads: before.uploads
          .filter(({ import_id }) => !targetIds.has(import_id))
          .map((upload) =>
            operation === 'trip' && upload.trip_id === owned.trip_id
              ? { ...upload, trip_id: null }
              : upload,
          ),
        places: before.places.map((place) => ({
          ...place,
          sources: place.sources.filter(({ import_id }) => !targetIds.has(import_id)),
        })),
      };
      async function expectPending(expected: typeof pendingDeletion, guestCookie = cookie) {
        const response = await fetch(base + settingsPath, { headers: { cookie: guestCookie } });
        assert.equal(response.status, 200);
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(await response.json()).toEqual({
          ...(guestCookie === cookie ? expectedData : { trips: [], places: [], uploads: [] }),
          pending_deletions: expected,
        });
      }
      async function checkCommittedState() {
        expect(await databases()).toEqual([database]);
        expect(await readBatch()).toEqual(expectedBatch);
        expect(await readData()).toEqual(expectedData);
        if (operation === 'trip') await expectError(await call(tripPath), 404, 'TRIP_NOT_FOUND');
        for (const image of targets) {
          await expectError(await call(importPath(image.id)), 404, 'IMPORT_NOT_FOUND');
          for (const path of [`${batchItem(image.id)}/image`, `${importPath(image.id)}/image`]) {
            await expectError(await call(path), 404, 'IMPORT_NOT_FOUND');
          }
        }
        for (const image of pictures.filter(({ id }) => !targetIds.has(id))) await intact(image);
      }
      await checkCommittedState();
      await expectPending(pendingDeletion);
      const exported = await call('/me/export');
      expect(exported.status).toBe(200);
      expect(await exported.json()).toEqual(expectedData);
      if (operation !== 'batch') {
        await expectError(await fetch(base + settingsPath), 401, 'SESSION_REQUIRED');
        const foreignSession = await fetch(`${base}/sessions`, { method: 'POST' });
        const foreignCookie = foreignSession.headers.get('set-cookie')?.split(';')[0];
        assert(foreignCookie && foreignCookie !== cookie);
        await expectPending([], foreignCookie);
        const foreignPath = operation === 'source' ? importPath(target.id) : tripPath;
        const foreignDelete = (path: string) =>
          fetch(base + path, { method: 'DELETE', headers: { cookie: foreignCookie } });
        assert.equal((await foreignDelete(foreignPath)).status, 204);
        assert.deepEqual(imageRemovals(), targetDirectories);
        await expectPending(pendingDeletion);
        assert.equal((await eraseGuest(base, foreignCookie)).status, 204);
      }
      const copies = fault === 'before unlink' ? ['normalized', 'original'] : ['normalized'];
      expect((await readdir(target.directory)).sort()).toEqual(copies);
      expect(await readFile(join(target.directory, 'normalized'))).toEqual(target.normalized);
      if (fault === 'before unlink') {
        assert.deepEqual(await readFile(join(target.directory, 'original')), target.original);
      }
      const batchRecoveryPath = `${batchPath}?include=pending_removals`;
      if (operation === 'batch') {
        const recovered = await call(batchRecoveryPath);
        assert.equal(recovered.status, 200);
        assert.equal(recovered.headers.get('cache-control'), 'no-store');
        assert.deepEqual(await recovered.json(), {
          ...expectedBatch,
          pending_removals: [{ import_id: target.id, revision: saved.revision }],
        });
        await expectError(await fetch(base + batchRecoveryPath), 401, 'SESSION_REQUIRED');
        const foreignSession = await fetch(`${base}/sessions`, { method: 'POST' });
        const foreignCookie = foreignSession.headers.get('set-cookie')?.split(';')[0];
        assert(foreignCookie && foreignCookie !== cookie);
        await expectError(
          await fetch(base + batchRecoveryPath, { headers: { cookie: foreignCookie } }),
          404,
          'IMPORT_NOT_FOUND',
        );
        assert.equal((await eraseGuest(base, foreignCookie)).status, 204);
        const otherForm = new FormData();
        otherForm.append('images', new File(['not a screenshot'], 'invalid.png'));
        const otherBatch = await checkedJson(
          await post('/import-batches', otherForm),
          202,
          importBatchValidator.check,
        );
        const otherPath = `/import-batches/${otherBatch.batch_id}`;
        const otherRecovery = await call(`${otherPath}?include=pending_removals`);
        assert.equal(otherRecovery.status, 200);
        assert.deepEqual(await otherRecovery.json(), { ...otherBatch, pending_removals: [] });
        await expectError(
          await post(`${otherPath}/items/${target.id}/remove`, { revision: otherBatch.revision }),
          404,
          'IMPORT_NOT_FOUND',
        );
        await expectError(await remove(saved.revision - 1), 409, 'IMPORT_STALE');
        await expectError(await remove(expectedBatch.revision), 404, 'IMPORT_NOT_FOUND');
        await expectError(
          await post(`${batchItem(sharedImage.id)}/remove`, { revision: saved.revision }),
          409,
          'IMPORT_STALE',
        );
        assert.deepEqual(imageRemovals(), targetDirectories);
      }
      async function expectSuccess(allowRetired: boolean) {
        const response = await remove(saved.revision, allowRetired);
        if (operation === 'batch') {
          assert.deepEqual(
            await checkedJson(response, 200, importBatchValidator.check),
            expectedBatch,
          );
        } else {
          assert.equal(response.status, 204);
        }
        for (const directory of targetDirectories) {
          await assert.rejects(readdir(directory), { code: 'ENOENT' });
        }
      }
      await Promise.all([expectSuccess(false), expectSuccess(true)]);
      await checkCommittedState();
      await expectPending([]);
      const targetRemovals = [...targetDirectories, ...targetDirectories];
      expect(imageRemovals()).toEqual(targetRemovals);
      if (operation === 'batch') {
        const recovered = await call(batchRecoveryPath);
        assert.equal(recovered.status, 200);
        assert.deepEqual(await recovered.json(), { ...expectedBatch, pending_removals: [] });
        assert.equal((await call(importPath(singleImage.id), 'DELETE')).status, 204);
        const latest = {
          ...expectedBatch,
          revision: expectedBatch.revision + 1,
          items: expectedBatch.items.filter(({ import_id }) => import_id !== singleImage.id),
        };
        assert.deepEqual(
          await checkedJson(await remove(saved.revision), 200, importBatchValidator.check),
          latest,
        );
        assert.deepEqual(await readBatch(), latest);
        assert.deepEqual(imageRemovals(), [...targetRemovals, singleImage.directory]);
        await intact(sharedImage);
        await intact(unrelatedImage);
      }
    } finally {
      try {
        await server[Symbol.asyncDispose]();
      } finally {
        await rm(dataDir, { recursive: true, force: true });
      }
    }
  },
);

it('discovers and retries an exact pending removal in settings after its batch retires', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'nextstop-retired-batch-'));
  let server = cleanupApp(dataDir);
  try {
    let base = await listen(server);
    async function guest() {
      const session = await fetch(`${base}/sessions`, { method: 'POST' });
      assert.equal(session.status, 204);
      const cookie = session.headers.get('set-cookie')?.split(';')[0];
      assert(cookie);
      return cookie;
    }
    const cookie = await guest();
    const call = (path: string, method = 'GET') =>
      fetch(base + path, { method, headers: { cookie } });
    const post = (path: string, body: FormData | object) =>
      fetch(base + path, {
        method: 'POST',
        headers:
          body instanceof FormData ? { cookie } : { cookie, 'content-type': 'application/json' },
        body: body instanceof FormData ? body : JSON.stringify(body),
      });
    const trip = (destination: string) =>
      post('/trips', {
        destination,
        date: '2026-11-20',
        start: '09:00',
        end: '20:00',
        time_zone: 'Asia/Shanghai',
      });
    await checkedJson(await trip('无关旅行'), 201, tripDetailValidator.check);
    const single = new FormData();
    single.append('image', new File([png.unrelated], '幸存.png', { type: 'image/png' }));
    const survivor = await checkedJson(
      await post('/imports', single),
      201,
      importReviewValidator.check,
    );
    const owned = await checkedJson(await trip('目标旅行'), 201, tripDetailValidator.check);
    const form = new FormData();
    form.append('images', new File([png.pending], '待移除.png', { type: 'image/png' }));
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
      expect(batch.items.map(({ kind }) => kind)).toEqual(['ready']);
      return batch;
    }, 5_000);
    const [item] = ready.items;
    assert(item);
    const [database] = (await readdir(join(dataDir, 'users'))).filter((file) =>
      file.endsWith('.sqlite'),
    );
    assert(database);
    const images = join(dataDir, 'import-images', database.slice(0, -'.sqlite'.length));
    const target = join(images, item.import_id);
    const readCopies = (id: string) =>
      Promise.all(['original', 'normalized'].map((copy) => readFile(join(images, id, copy))));
    const targetCopies = await readCopies(item.import_id);
    const survivorCopies = await readCopies(survivor.import_id);
    const itemPath = `${batchPath}/items/${item.import_id}/remove`;
    const settingsPath = '/me/data?include=pending_deletions';
    const recoverySettingsPath = `${settingsPath}&include_retired_batch_removals=1`;
    const pending = {
      kind: 'batch_item',
      batch_id: initial.batch_id,
      import_id: item.import_id,
      revision: ready.revision,
    };
    async function expectPending(path: string, expected: (typeof pending)[], visitor = cookie) {
      const response = await fetch(base + path, { headers: { cookie: visitor } });
      assert.equal(response.status, 200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.json()).toMatchObject({ pending_deletions: expected });
    }
    const remove = ({
      visitor = cookie,
      revision = ready.revision,
      path = itemPath,
      legacy = false,
    } = {}) =>
      fetch(base + path, {
        method: 'POST',
        headers: {
          cookie: visitor,
          'content-type': 'application/json',
          ...(!legacy && { 'x-nextstop-allow-retired-removal': '1' }),
        },
        body: JSON.stringify({ revision }),
      });

    const diskRemove = vi.mocked(rm);
    const realRemove = diskRemove.getMockImplementation();
    assert(realRemove);
    const targetRemovalCalls = () => diskRemove.mock.calls.filter(([path]) => path === target);
    diskRemove.mockClear();
    diskRemove.mockImplementation(async (path, options) => {
      if (path === target)
        throw Object.assign(new Error('Controlled cleanup failure'), { code: 'EACCES' });
      return realRemove(path, options);
    });
    try {
      await expectError(await remove(), 500, 'INTERNAL_ERROR');
      expect(await readBatch()).toEqual({ ...ready, revision: ready.revision + 1, items: [] });
      const recoveryPath = `${batchPath}?include=pending_removals`;
      const liveRecovery = await call(recoveryPath);
      expect(liveRecovery.status).toBe(200);
      expect(await liveRecovery.json()).toEqual({
        ...ready,
        revision: ready.revision + 1,
        items: [],
        pending_removals: [{ import_id: item.import_id, revision: ready.revision }],
      });
      await expectPending(recoverySettingsPath, []);
      assert.equal((await call(`/trips/${owned.trip_id}`, 'DELETE')).status, 204);
      await expectError(await call(batchPath), 404, 'IMPORT_NOT_FOUND');
      await expectError(await call(recoveryPath), 404, 'IMPORT_NOT_FOUND');
      await expectPending(recoverySettingsPath, [pending]);
      await expectError(await remove({ revision: pending.revision }), 500, 'INTERNAL_ERROR');
      await expectPending(recoverySettingsPath, [pending]);
    } finally {
      diskRemove.mockImplementation(realRemove);
    }

    await server[Symbol.asyncDispose]();
    server = cleanupApp(dataDir);
    base = await listen(server);
    await expectPending(recoverySettingsPath, [pending]);
    await expectPending(settingsPath, []);
    const data = await checkedJson(await call('/me/data'), 200, anonymousDataValidator.check);
    expect(await (await call('/me/export')).json()).toEqual(data);
    await expectError(await fetch(base + recoverySettingsPath), 401, 'SESSION_REQUIRED');
    const foreign = await guest();
    await expectPending(recoverySettingsPath, [], foreign);
    await expectError(await remove({ visitor: foreign }), 404, 'IMPORT_NOT_FOUND');
    await expectError(await remove({ revision: ready.revision - 1 }), 404, 'IMPORT_NOT_FOUND');
    await expectError(await remove({ revision: ready.revision + 1 }), 404, 'IMPORT_NOT_FOUND');
    await expectError(
      await remove({ path: `${batchPath}/items/${survivor.import_id}/remove` }),
      404,
      'IMPORT_NOT_FOUND',
    );
    const unknown = `/import-batches/bat-00000000-0000-4000-8000-000000000000/items/${item.import_id}/remove`;
    await expectError(await remove({ path: unknown }), 404, 'IMPORT_NOT_FOUND');
    expect(await readCopies(item.import_id)).toEqual(targetCopies);
    expect(targetRemovalCalls()).toHaveLength(2);

    const replay = await remove();
    await assert.rejects(readdir(target), { code: 'ENOENT' });
    expect(replay.status).toBe(204);
    expect(await replay.text()).toBe('');
    await expectPending(recoverySettingsPath, []);
    expect((await remove()).status).toBe(204);
    await expectError(await remove({ legacy: true }), 404, 'IMPORT_NOT_FOUND');
    await expectError(await remove({ visitor: foreign }), 404, 'IMPORT_NOT_FOUND');
    await expectError(await call(batchPath), 404, 'IMPORT_NOT_FOUND');
    expect(targetRemovalCalls()).toHaveLength(3);
    expect(await readCopies(survivor.import_id)).toEqual(survivorCopies);
    const survivorImage = await call(`/imports/${survivor.import_id}/image`);
    expect(survivorImage.status).toBe(200);
    expect(Buffer.from(await survivorImage.arrayBuffer())).toEqual(survivorCopies[1]);
  } finally {
    try {
      await server[Symbol.asyncDispose]();
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  }
});

import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { importBatchValidator, wishlistValidator, type ImportBatch } from '@nextstop/core';
import { expect, it, vi } from 'vitest';
import { createApp } from './app.js';
import type { ImportVision } from './imports/review.js';
import { createAmap } from './radar/amap.js';

const poi = { id: 'B020000001', name: '平江历史街区', address: '姑苏区平江路' };
const png = await readFile(new URL('../test/import-synthetic.png', import.meta.url));
const alternate = await readFile(
  new URL('../../web/public/prototype/assets/nav-library.png', import.meta.url),
);

async function batchOf(response: Response, status = 200): Promise<ImportBatch> {
  expect(response.status).toBe(status);
  const body: unknown = await response.json();
  assert(importBatchValidator.check(body));
  return body;
}

it('shows partial results for eight images, retries only the failed image and keeps both duplicate POI sources', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'nextstop-import-batch-'));
  let release = () => {};
  const partial = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const vision = vi.fn<ImportVision>(async () => {
    calls += 1;
    const call = calls;
    if (call === 3) throw new Error('Controlled vision outage');
    if (call === 4) await partial;
    if (call === 5)
      return { kind: 'text', name: '地图故障测试地点', excerpt: '合成攻略', confidence: 'high' };
    return call <= 2
      ? { kind: 'text', name: poi.name, excerpt: `攻略片段 ${call}`, confidence: 'high' }
      : { kind: 'unrecognized' };
  });
  const app = createApp({
    dataDir,
    cookieSecret: 'test-only-import-batch-signing-value',
    map: createAmap({
      key: 'fixture',
      fetcher: async (input) =>
        new URL(input).searchParams.get('keywords') === '地图故障测试地点'
          ? new Response(null, { status: 503 })
          : Response.json({ status: '1', info: 'OK', pois: [poi] }),
    }),
    vision,
  });
  try {
    app.listen(0, '127.0.0.1');
    await once(app, 'listening');
    const address = app.address();
    assert(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}/api/v1`;
    async function guest() {
      const response = await fetch(base + '/sessions', { method: 'POST' });
      const cookie = response.headers.get('set-cookie')?.split(';')[0];
      assert(cookie);
      return { cookie };
    }
    const headers = await guest();
    const stranger = await guest();
    const form = new FormData();
    for (let image = 1; image <= 8; image += 1) {
      form.append(
        'images',
        new File([image === 3 ? alternate : png], `攻略-${image}.png`, { type: 'image/png' }),
      );
    }
    const created = await batchOf(
      await fetch(base + '/import-batches', { method: 'POST', headers, body: form }),
      202,
    );
    expect(created.items).toHaveLength(8);
    const url = `${base}/import-batches/${created.batch_id}`;
    const read = async () => batchOf(await fetch(url, { headers }));
    const post = (path: string, body: unknown, guestHeaders = headers) =>
      fetch(url + path, {
        method: 'POST',
        headers: { ...guestHeaders, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const wishlist = async (guestHeaders = headers) => {
      const response = await fetch(base + '/wishlist', { headers: guestHeaders });
      expect(response.status).toBe(200);
      const body: unknown = await response.json();
      assert(wishlistValidator.check(body));
      return body.places;
    };
    expect((await fetch(url, { headers: stranger })).status).toBe(404);
    const progress = await vi.waitFor(
      async () => {
        const batch = await read();
        expect(batch.items.map(({ kind }) => kind)).toEqual([
          'ready',
          'ready',
          'failed',
          'processing',
          'processing',
          'processing',
          'processing',
          'processing',
        ]);
        return batch;
      },
      { timeout: 5_000 },
    );
    const [first, second, failed, ...others] = progress.items;
    assert(first && second && failed && others[0]);
    expect(failed).toMatchObject({ kind: 'failed', reason: 'vision' });
    const image = `/items/${first.import_id}/image`;
    expect((await fetch(url + image, { headers: stranger })).status).toBe(404);
    expect((await fetch(url + image, { headers })).status).toBe(200);
    expect(await wishlist()).toEqual([]);
    release();
    const finished = await vi.waitFor(
      async () => {
        const batch = await read();
        expect(batch.items.some(({ kind }) => kind === 'processing')).toBe(false);
        return batch;
      },
      { timeout: 5_000 },
    );
    expect(finished.items.map(({ kind }) => kind)).toEqual([
      'ready',
      'ready',
      'failed',
      'ready',
      'failed',
      'ready',
      'ready',
      'ready',
    ]);
    expect(finished.items[4]).toMatchObject({
      kind: 'failed',
      reason: 'map',
      review: { match: { kind: 'map_unavailable' } },
    });
    expect(vision).toHaveBeenCalledTimes(8);
    expect(
      (await post(`/items/${first.import_id}/retry`, { revision: finished.revision })).status,
    ).toBe(409);
    const retried = await batchOf(
      await post(`/items/${failed.import_id}/retry`, { revision: finished.revision }),
      202,
    );
    expect(retried.items[2]?.kind).toBe('processing');
    const selection = {
      revision: finished.revision,
      new_count: 1,
      selections: [first, second].map(({ import_id }) => ({ import_id, poi_id: poi.id })),
    };
    expect((await post('/confirm', selection)).status).toBe(409);
    const afterRetry = await vi.waitFor(
      async () => {
        const batch = await read();
        expect(batch.items[2]?.kind).toBe('ready');
        return batch;
      },
      { timeout: 5_000 },
    );
    expect(vision).toHaveBeenCalledTimes(9);
    const failedImage = vision.mock.calls[2]?.[0];
    expect(failedImage?.data).not.toBe(vision.mock.calls[0]?.[0].data);
    expect(vision.mock.calls[8]?.[0]).toEqual(failedImage);
    expect(afterRetry.items.slice(0, 2)).toEqual(progress.items.slice(0, 2));
    const removed = await batchOf(
      await post(`/items/${others[0].import_id}/remove`, { revision: afterRetry.revision }),
    );
    expect(removed.items).toHaveLength(7);
    expect((await fetch(`${url}/items/${others[0].import_id}/image`, { headers })).status).toBe(
      404,
    );
    const confirmation = { ...selection, revision: removed.revision };
    expect((await post('/confirm', confirmation, stranger)).status).toBe(404);
    expect((await post('/confirm', { ...confirmation, new_count: 2 })).status).toBe(409);
    expect(
      (
        await post('/confirm', {
          ...confirmation,
          selections: [
            { import_id: first.import_id, poi_id: poi.id },
            { import_id: second.import_id, poi_id: 'fake' },
          ],
        })
      ).status,
    ).toBe(409);
    expect(await wishlist()).toEqual([]);
    const saved = await batchOf(await post('/confirm', confirmation));
    expect(saved.items.map(({ kind }) => kind).slice(0, 2)).toEqual(['saved', 'saved']);
    expect(await batchOf(await post('/confirm', confirmation))).toEqual(saved);
    expect(await wishlist()).toEqual([
      {
        provider: 'amap',
        poi_id: poi.id,
        city: '苏州',
        name: poi.name,
        address: poi.address,
        note: '',
        visit: 'unvisited',
        schedule: 'unscheduled',
        evidence: 'unknown',
        sources: [first, second].map(({ import_id }, index) => ({
          kind: 'image',
          import_id,
          excerpt: `攻略片段 ${index + 1}`,
        })),
      },
    ]);
    expect(await wishlist(stranger)).toEqual([]);
    expect((await fetch(`${base}/imports/${second.import_id}/image`, { headers })).status).toBe(
      200,
    );
    const next = others[1];
    assert(next);
    const manuallyMatched = await batchOf(
      await post(`/items/${failed.import_id}/search`, {
        revision: saved.revision,
        query: poi.name,
      }),
    );
    const skipped = await batchOf(
      await post(`/items/${next.import_id}/skip`, { revision: manuallyMatched.revision }),
    );
    expect(skipped.items.find(({ import_id }) => import_id === next.import_id)?.kind).toBe(
      'skipped',
    );
    const savedPlacePath = `${base}/wishlist/amap/${poi.id}`;
    expect(
      (
        await fetch(savedPlacePath, {
          method: 'PATCH',
          headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify({ visit: 'visited', note: '留到下次苏州行' }),
        })
      ).status,
    ).toBe(200);
    const merged = await batchOf(
      await post('/confirm', {
        revision: skipped.revision,
        new_count: 0,
        selections: [{ import_id: failed.import_id, poi_id: poi.id }],
      }),
    );
    expect(merged.items[2]?.kind).toBe('saved');
    const places = await wishlist();
    expect(places).toHaveLength(1);
    expect(places[0]).toMatchObject({ visit: 'visited', note: '留到下次苏州行' });
    expect(places[0]?.sources.map(({ import_id }) => import_id)).toEqual([
      first.import_id,
      second.import_id,
      failed.import_id,
    ]);

    for (let index = 8; index < 15; index += 1) {
      form.append(
        'images',
        new File([index === 14 ? 'bad image' : png], `攻略-${index + 1}.png`, {
          type: 'image/png',
        }),
      );
    }
    const submit = () => fetch(base + '/import-batches', { method: 'POST', headers, body: form });
    const maxBatch = await batchOf(await submit(), 202);
    expect(maxBatch.items).toHaveLength(15);
    expect(maxBatch.items[14]).toMatchObject({ kind: 'invalid', reason: 'invalid_image' });
    await vi.waitFor(
      async () => {
        const finished = await batchOf(
          await fetch(`${base}/import-batches/${maxBatch.batch_id}`, { headers }),
        );
        expect(finished.items.filter(({ kind }) => kind === 'ready')).toHaveLength(14);
      },
      { timeout: 5_000 },
    );
    expect(vision).toHaveBeenCalledTimes(23);
    form.append('images', new File([png], '攻略-16.png', { type: 'image/png' }));
    expect((await submit()).status).toBe(400);
  } finally {
    release();
    await new Promise<void>((resolve) => app.close(() => resolve()));
    await rm(dataDir, { recursive: true, force: true });
  }
});

it('preserves saved and pending image sources when a batch write rolls back', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'nextstop-import-rollback-'));
  const app = createApp({
    dataDir,
    cookieSecret: 'test-only-import-batch-signing-value',
    map: createAmap({
      key: 'fixture',
      fetcher: async () => Response.json({ status: '1', info: 'OK', pois: [poi] }),
    }),
    vision: async () => ({ kind: 'text', name: poi.name, excerpt: '合成攻略', confidence: 'high' }),
  });
  try {
    app.listen(0, '127.0.0.1');
    await once(app, 'listening');
    const address = app.address();
    assert(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}/api/v1`;
    const guest = await fetch(base + '/sessions', { method: 'POST' });
    const cookie = guest.headers.get('set-cookie')?.split(';')[0];
    assert(cookie);
    const headers = { cookie };
    const form = new FormData();
    for (const name of ['已保存来源.png', '待确认来源.png']) {
      form.append('images', new File([png], name, { type: 'image/png' }));
    }
    const created = await batchOf(
      await fetch(base + '/import-batches', { method: 'POST', headers, body: form }),
      202,
    );
    const url = `${base}/import-batches/${created.batch_id}`;
    const read = async () => batchOf(await fetch(url, { headers }));
    const post = (path: string, body: unknown) =>
      fetch(url + path, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const ready = await vi.waitFor(
      async () => {
        const batch = await read();
        expect(batch.items.map(({ kind }) => kind)).toEqual(['ready', 'ready']);
        return batch;
      },
      { timeout: 5_000 },
    );
    const [first, pending] = ready.items;
    assert(first && pending);
    const saved = await batchOf(
      await post('/confirm', {
        revision: ready.revision,
        new_count: 1,
        selections: [{ import_id: first.import_id, poi_id: poi.id }],
      }),
    );
    const wishlist = async () => {
      const response = await fetch(base + '/wishlist', { headers });
      expect(response.status).toBe(200);
      const body: unknown = await response.json();
      assert(wishlistValidator.check(body));
      return body.places;
    };
    const before = await wishlist();
    expect(before).toMatchObject([{ sources: [{ import_id: first.import_id }] }]);
    const image = (path: string) => fetch(path, { headers });
    const storedUrl = `${base}/imports/${first.import_id}/image`;
    const pendingUrl = `${url}/items/${pending.import_id}/image`;
    const readImage = async (path: string) => {
      const response = await image(path);
      assert.equal(response.status, 200, path);
      return Buffer.from(await response.arrayBuffer());
    };
    const storedBytes = await readImage(storedUrl);
    const pendingBytes = await readImage(pendingUrl);

    const users = join(dataDir, 'users');
    const files = (await readdir(users)).filter((name) => name.endsWith('.sqlite'));
    const [sqliteFile] = files;
    assert(files.length === 1 && sqliteFile);
    const database = join(users, sqliteFile);
    const pendingFiles = join(
      dataDir,
      'import-images',
      sqliteFile.slice(0, -'.sqlite'.length),
      pending.import_id,
    );
    const sqlite = (sql: string) => {
      using db = new DatabaseSync(database);
      db.exec(sql);
    };
    // Fail the actual batch revision write after the transaction callback has run.
    sqlite(`CREATE TRIGGER fail_batch_save BEFORE INSERT ON document_revisions
      WHEN NEW.document_id IN (SELECT id FROM documents WHERE kind = json_quote('nextstop.import_batch'))
      BEGIN SELECT RAISE(ABORT, 'controlled batch save failure'); END`);

    expect(
      (
        await post('/confirm', {
          revision: saved.revision,
          new_count: 0,
          selections: [{ import_id: pending.import_id, poi_id: poi.id }],
        })
      ).status,
    ).toBe(500);
    expect(await read()).toEqual(saved);
    expect(await wishlist()).toEqual(before);
    expect(await readImage(storedUrl)).toEqual(storedBytes);
    expect(await readImage(pendingUrl)).toEqual(pendingBytes);

    const remove = () => post(`/items/${pending.import_id}/remove`, { revision: saved.revision });
    expect((await remove()).status).toBe(500);
    expect(await read()).toEqual(saved);
    expect(await wishlist()).toEqual(before);
    expect(await readImage(storedUrl)).toEqual(storedBytes);
    expect(await readImage(pendingUrl)).toEqual(pendingBytes);
    expect(await readFile(join(pendingFiles, 'original'))).toEqual(png);

    sqlite('DROP TRIGGER fail_batch_save');
    expect((await batchOf(await remove())).items).toEqual(saved.items.slice(0, 1));
    expect((await image(pendingUrl)).status).toBe(404);
    expect(await stat(pendingFiles, { throwIfNoEntry: false })).toBeUndefined();
    expect(await wishlist()).toEqual(before);
    expect(await readImage(storedUrl)).toEqual(storedBytes);
  } finally {
    await new Promise<void>((resolve) => app.close(() => resolve()));
    await rm(dataDir, { recursive: true, force: true });
  }
});

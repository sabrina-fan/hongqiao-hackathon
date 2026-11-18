import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm, rmdir, stat } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import {
  anonymousDataValidator,
  ERASE_BINDING_HEADER,
  ERASE_RECOVERY_HEADER,
  eraseBindingValidator,
  importBatchValidator,
  importReviewValidator,
  tripDetailValidator,
} from '@nextstop/core';
import { createAmap } from './radar/amap.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createApp } from './app.js';

it('exports only the current guest without mutating trips and revokes only that guest on deletion', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'nextstop-privacy-'));
  const options = { dataDir, cookieSecret: 'test-only-privacy-signing-value', map: null };
  const server = createApp(options);
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}/api/v1`;
    async function guest(destination: string) {
      const session = await fetch(`${base}/sessions`, { method: 'POST' });
      const cookie = session.headers.get('set-cookie')?.split(';')[0];
      assert(cookie);
      const headers = { cookie, 'content-type': 'application/json' };
      const response = await fetch(`${base}/trips`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          destination,
          date: '2026-11-20',
          time_zone: 'Asia/Shanghai',
          start: '09:00',
          end: '20:00',
        }),
      });
      expect(response.status).toBe(201);
      return (path: string, method = 'GET', extraHeaders?: Record<string, string>) =>
        fetch(`${base}${path}`, { headers: { ...headers, ...extraHeaders }, method });
    }
    const first = await guest('访客甲的苏州');
    const [firstDb] = await readdir(join(dataDir, 'users'));
    assert(firstDb?.endsWith('.sqlite'));
    const second = await guest('访客乙的苏州');
    const saved: unknown = await (await first('/trips')).json();
    const exported = await first('/me/export');
    expect(exported.status).toBe(200);
    expect(exported.headers.get('cache-control')).toBe('no-store');
    const text = await exported.text();
    expect(text).toContain('访客甲的苏州');
    expect(text).not.toContain('访客乙的苏州');
    expect(await (await first('/trips')).json()).toEqual(saved);
    const dataPath = '/me/data';
    const legacySettings = `${dataPath}?include=pending_deletions&include_retired_batch_removals=1`;
    const settings = `${legacySettings}&include_erase_recovery=1`;
    const firstSettings = await first(settings);
    const binding = firstSettings.headers.get(ERASE_BINDING_HEADER);
    expect(firstSettings.status).toBe(200);
    assert(eraseBindingValidator.check(binding));
    expect(exported.headers.has(ERASE_BINDING_HEADER)).toBe(false);
    const bound = { [ERASE_BINDING_HEADER]: binding };
    const resume = { ...bound, [ERASE_RECOVERY_HEADER]: '1' };
    const blockedSidecar = join(dataDir, 'users', `${firstDb}-journal`);
    await mkdir(blockedSidecar);
    const failed = await first(dataPath, 'DELETE', bound);
    expect(failed.status).toBe(500);
    expect(failed.headers.has('set-cookie')).toBe(false);
    for (const path of ['/me/data', legacySettings, '/me/export', '/trips']) {
      expect((await first(path)).status).toBe(401);
    }
    const blockedSession = await first('/sessions', 'POST');
    expect(blockedSession.status).toBe(401);
    expect(blockedSession.headers.has('set-cookie')).toBe(false);
    expect((await first('/trips', 'POST')).status).toBe(401);
    expect((await fetch(`${base}${settings}`)).status).toBe(401);
    const recovery = await first(settings);
    expect(recovery.status).toBe(200);
    expect(recovery.headers.get('cache-control')).toBe('no-store');
    expect(recovery.headers.has('set-cookie')).toBe(false);
    expect(await recovery.json()).toEqual({ kind: 'erase_recovery' });
    expect(recovery.headers.get(ERASE_BINDING_HEADER) === binding).toBe(true);
    expect((await stat(blockedSidecar)).isDirectory()).toBe(true);
    const retry = await first(dataPath, 'DELETE', resume);
    expect(retry.status).toBe(500);
    expect(retry.headers.has('set-cookie')).toBe(false);
    expect(await (await first(settings)).json()).toEqual({ kind: 'erase_recovery' });
    const secondSettings = await second(settings);
    const secondBinding = secondSettings.headers.get(ERASE_BINDING_HEADER);
    assert(eraseBindingValidator.check(secondBinding));
    expect(secondBinding !== binding).toBe(true);
    expect(await secondSettings.json()).toEqual(await (await second(legacySettings)).json());

    async function expectExpired(response: Response) {
      expect(response.status).toBe(401);
      expect(response.headers.has('set-cookie')).toBe(false);
      expect(await response.json()).toMatchObject({ error: { code: 'SESSION_REQUIRED' } });
    }

    // Fail closed for old clients, missing/invalid sessions and both kinds of stale confirmation.
    await expectExpired(await second(dataPath, 'DELETE'));
    await expectExpired(await first(dataPath, 'DELETE', { [ERASE_RECOVERY_HEADER]: '1' }));
    await expectExpired(await second(dataPath, 'DELETE', { [ERASE_BINDING_HEADER]: 'invalid' }));
    await expectExpired(await second(dataPath, 'DELETE', bound));
    await expectExpired(await second(dataPath, 'DELETE', resume));
    await expectExpired(
      await second(dataPath, 'DELETE', { ...resume, [ERASE_BINDING_HEADER]: secondBinding }),
    );
    await expectExpired(await fetch(base + dataPath, { method: 'DELETE', headers: bound }));
    await expectExpired(
      await first(dataPath, 'DELETE', { ...bound, cookie: 'nextstop_guest=invalid' }),
    );

    await rmdir(blockedSidecar);
    const deleted = await first(dataPath, 'DELETE', resume);
    expect(deleted.status).toBe(204);
    expect(deleted.headers.get('set-cookie')).toContain('Max-Age=0');
    expect((await first('/me/export')).status).toBe(401);
    expect((await first(dataPath, 'DELETE', bound)).status).toBe(204);
    expect(await (await second('/me/export')).text()).toContain('访客乙的苏州');
    const remaining = await readdir(join(dataDir, 'users'));
    expect(remaining.filter((name) => name.endsWith('.sqlite'))).toHaveLength(1);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dataDir, { recursive: true, force: true });
  }
});

it('removes exclusive trip uploads, retains shared sources, and removes both source copies on explicit deletion', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'nextstop-privacy-sources-'));
  const oldPoi = { id: 'old', name: '误匹配门店', address: '旧地址' };
  const newPoi = { id: 'new', name: '正确门店', address: '新地址' };
  let startedLookups = 0;
  let notifyRoutesStarted = () => {};
  const routesStarted = new Promise<void>((resolve) => {
    notifyRoutesStarted = resolve;
  });
  const server = createApp({
    dataDir,
    cookieSecret: 'test-only-privacy-sources-signing-value',
    map: createAmap({
      key: 'fixture',
      fetcher: async (url, init) => {
        if (new URL(String(url)).pathname === '/v5/place/detail') {
          const signal = init?.signal;
          assert(signal);
          if (++startedLookups === 2) notifyRoutesStarted();
          return new Promise<Response>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          });
        }
        return Response.json({
          status: '1',
          info: 'OK',
          pois: [String(url).includes(encodeURIComponent(newPoi.name)) ? newPoi : oldPoi],
        });
      },
    }),
    vision: async () => ({
      kind: 'text',
      name: oldPoi.name,
      excerpt: '来源文字',
      confidence: 'high',
    }),
  });
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}/api/v1`;
    const session = await fetch(`${base}/sessions`, { method: 'POST' });
    const cookie = session.headers.get('set-cookie')?.split(';')[0];
    assert(cookie);
    const user = cookie.split('=')[1]?.split('.')[0];
    assert(user);
    const call = (path: string, method = 'GET', input?: unknown) => {
      const url = `${base}${path}`;
      if (method === 'GET' || method === 'DELETE')
        return fetch(url, { method, headers: { cookie } });
      if (input instanceof FormData)
        return fetch(url, { method: 'POST', headers: { cookie }, body: input });
      return fetch(url, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify(input),
      });
    };
    const date = { date: '2026-11-20', start: '09:00', end: '20:00', time_zone: 'Asia/Shanghai' };
    const other: unknown = await (
      await call('/trips', 'POST', { ...date, destination: '另一趟旅行' })
    ).json();
    const owned: unknown = await (
      await call('/trips', 'POST', { ...date, destination: '待删除旅行' })
    ).json();
    assert(tripDetailValidator.check(other) && tripDetailValidator.check(owned));
    const bytes = await readFile(new URL('../test/import-synthetic.png', import.meta.url));
    const form = new FormData();
    form.append('images', new File([bytes], '共同来源.png', { type: 'image/png' }));
    form.append('images', new File([bytes], '独占图像.png', { type: 'image/png' }));
    const uploaded = await call('/import-batches', 'POST', form);
    expect(uploaded.status).toBe(202);
    const initial: unknown = await uploaded.json();
    assert(importBatchValidator.check(initial));
    const batchPath = `/import-batches/${initial.batch_id}`;
    let batch = initial;
    await expect
      .poll(async () => {
        const current: unknown = await (await call(batchPath)).json();
        assert(importBatchValidator.check(current));
        batch = current;
        return batch.items.map(({ kind }) => kind);
      })
      .toEqual(['ready', 'ready']);
    const [shared, exclusive] = batch.items;
    assert(shared && exclusive);
    const confirmed = await call(`${batchPath}/confirm`, 'POST', {
      revision: batch.revision,
      new_count: 1,
      selections: [{ import_id: shared.import_id, poi_id: oldPoi.id }],
    });
    expect(confirmed.status).toBe(200);
    const correction = await call(`/wishlist/amap/${oldPoi.id}/correction`, 'POST', {
      query: newPoi.name,
      poi_id: newPoi.id,
    });
    expect(correction.status).toBe(200);
    expect(await (await call(`/wishlist/amap/${newPoi.id}`)).json()).toMatchObject({
      name: newPoi.name,
      address: newPoi.address,
    });
    const imageRoot = join(dataDir, 'import-images', user);
    expect(await readdir(join(imageRoot, exclusive.import_id))).toEqual(['normalized', 'original']);
    const tripPath = `/trips/${owned.trip_id}`;
    const runningRadar = [
      call('/radar/sessions', 'POST', {
        origin_id: oldPoi.id,
        poi_id: newPoi.id,
        available_min: 75,
      }),
      call('/radar/sessions', 'POST', { origin_id: oldPoi.id, available_min: 75 }),
    ];
    await Promise.race([
      routesStarted,
      ...runningRadar.map((request) =>
        request.then((response) => {
          throw new Error(`Radar returned ${response.status} before both map lookups started`);
        }),
      ),
    ]);
    expect((await call(tripPath, 'DELETE')).status).toBe(204);
    expect((await Promise.all(runningRadar)).map(({ status }) => status)).toEqual([409, 409]);
    expect((await call(tripPath, 'DELETE')).status).toBe(204);
    expect((await call(tripPath)).status).toBe(404);
    expect((await call(`/trips/${other.trip_id}`)).status).toBe(200);
    expect((await call(`${batchPath}/items/${exclusive.import_id}/image`)).status).toBe(404);
    expect(await readdir(imageRoot)).toEqual([shared.import_id]);
    const sourcePath = `/imports/${shared.import_id}`;
    expect((await call(`${sourcePath}/image`)).status).toBe(200);
    const before: unknown = await (await call('/me/export')).json();
    assert(anonymousDataValidator.check(before));
    expect(before.uploads).toMatchObject([{ import_id: shared.import_id, trip_id: null }]);
    expect(before.places[0]?.sources).toHaveLength(1);
    expect((await call(sourcePath, 'DELETE')).status).toBe(204);
    expect((await call(sourcePath, 'DELETE')).status).toBe(204);
    expect((await call(`${sourcePath}/image`)).status).toBe(404);
    expect((await call(`${batchPath}/items/${shared.import_id}/image`)).status).toBe(404);
    expect(await readdir(imageRoot)).toEqual([]);
    const after: unknown = await (await call('/me/export')).json();
    assert(anonymousDataValidator.check(after));
    expect(after.uploads).toEqual([]);
    expect(after.places).toMatchObject([{ poi_id: newPoi.id, sources: [] }]);
    expect(importReviewValidator.check(await (await call(sourcePath)).json())).toBe(false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dataDir, { recursive: true, force: true });
  }
});

it.each(['source', 'trip'])(
  'preserves references and images on %s deletion rollback and scopes the retry',
  async (target) => {
    const dataDir = await mkdtemp(join(tmpdir(), 'nextstop-privacy-rollback-'));
    const poi = { id: 'settings-poi', name: '合成收藏', address: '合成地址' };
    const server = createApp({
      dataDir,
      cookieSecret: 'test-only-privacy-rollback-signing-value',
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
    });
    try {
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      assert(address && typeof address !== 'string');
      const base = `http://127.0.0.1:${address.port}/api/v1`;
      const session = await fetch(`${base}/sessions`, { method: 'POST' });
      const cookie = session.headers.get('set-cookie')?.split(';')[0];
      assert(cookie);
      const call = (path: string, method = 'GET') =>
        fetch(base + path, { method, headers: { cookie } });
      const post = (path: string, input: unknown) =>
        fetch(
          base + path,
          input instanceof FormData
            ? { method: 'POST', headers: { cookie }, body: input }
            : {
                method: 'POST',
                headers: { cookie, 'content-type': 'application/json' },
                body: JSON.stringify(input),
              },
        );
      const createTrip = async (destination: string) => {
        const response = await post('/trips', {
          destination,
          date: '2026-11-20',
          start: '09:00',
          end: '20:00',
          time_zone: 'Asia/Shanghai',
        });
        expect(response.status).toBe(201);
        const body: unknown = await response.json();
        assert(tripDetailValidator.check(body));
        return body;
      };
      const readData = async () => {
        const response = await call('/me/data');
        expect(response.status).toBe(200);
        const body: unknown = await response.json();
        assert(anonymousDataValidator.check(body));
        return body;
      };
      const other = await createTrip('保留旅行');
      const owned = await createTrip('目标旅行');
      const png = await readFile(new URL('../test/import-synthetic.png', import.meta.url));
      const form = new FormData();
      for (const name of ['单删来源.png', '共享来源.png', '独占来源.png']) {
        form.append('images', new File([png], name, { type: 'image/png' }));
      }
      const response = await post('/import-batches', form);
      expect(response.status).toBe(202);
      const initial: unknown = await response.json();
      assert(importBatchValidator.check(initial));
      const batchPath = `/import-batches/${initial.batch_id}`;
      const readBatch = async () => {
        const response = await call(batchPath);
        expect(response.status).toBe(200);
        const body: unknown = await response.json();
        assert(importBatchValidator.check(body));
        return body;
      };
      const ready = await vi.waitFor(async () => {
        const batch = await readBatch();
        expect(batch.items.map(({ kind }) => kind)).toEqual(['ready', 'ready', 'ready']);
        return batch;
      });
      const [single, shared, exclusive] = ready.items;
      assert(single && shared && exclusive);
      const confirm = await post(`${batchPath}/confirm`, {
        revision: ready.revision,
        new_count: 1,
        selections: [single, shared].map(({ import_id }) => ({ import_id, poi_id: poi.id })),
      });
      expect(confirm.status).toBe(200);
      const saved = await readBatch();
      const before = await readData();
      expect(before.uploads).toHaveLength(3);
      expect(before.uploads.every(({ trip_id }) => trip_id === owned.trip_id)).toBe(true);
      expect(before.places).toMatchObject([
        { sources: [{ import_id: single.import_id }, { import_id: shared.import_id }] },
      ]);

      const users = join(dataDir, 'users');
      const files = (await readdir(users)).filter((name) => name.endsWith('.sqlite'));
      const [database] = files;
      assert(files.length === 1 && database);
      const sqlite = (sql: string) => {
        using db = new DatabaseSync(join(users, database));
        db.exec(sql);
      };
      const directory = (id: string) =>
        join(dataDir, 'import-images', database.slice(0, -'.sqlite'.length), id);
      const batchImage = (id: string) => `${batchPath}/items/${id}/image`;
      const source = (id: string) => `/imports/${id}`;
      const checkImage = async (id: string, confirmed: boolean) => {
        const paths = confirmed ? [batchImage(id), `${source(id)}/image`] : [batchImage(id)];
        for (const path of paths) {
          const response = await call(path);
          assert.equal(response.status, 200, path);
          expect(Buffer.from(await response.arrayBuffer())).toEqual(png);
        }
        expect(await readFile(join(directory(id), 'original'))).toEqual(png);
        expect(await readFile(join(directory(id), 'normalized'))).toEqual(png);
      };
      const removed = target === 'source' ? single : exclusive;
      const path = target === 'source' ? source(single.import_id) : `/trips/${owned.trip_id}`;
      for (const item of [single, shared, exclusive])
        await checkImage(item.import_id, item !== exclusive);

      // Abort the real SQLite write that would publish the changed batch revision.
      sqlite(`CREATE TRIGGER fail_privacy_delete BEFORE INSERT ON document_revisions
      WHEN NEW.document_id IN (SELECT id FROM documents WHERE kind = json_quote('nextstop.import_batch'))
      BEGIN SELECT RAISE(ABORT, 'controlled privacy delete failure'); END`);
      expect((await call(path, 'DELETE')).status).toBe(500);
      expect(await readData()).toEqual(before);
      expect(await readBatch()).toEqual(saved);
      await checkImage(removed.import_id, removed === single);
      for (const item of [single, shared, exclusive].filter((item) => item !== removed)) {
        await checkImage(item.import_id, item !== exclusive);
      }

      sqlite('DROP TRIGGER fail_privacy_delete');
      expect((await call(path, 'DELETE')).status).toBe(204);
      expect((await call(path)).status).toBe(404);
      expect((await call(batchImage(removed.import_id))).status).toBe(404);
      expect((await call(`${source(removed.import_id)}/image`)).status).toBe(404);
      expect(await stat(directory(removed.import_id), { throwIfNoEntry: false })).toBeUndefined();
      expect((await readBatch()).items).toEqual(
        saved.items.filter(({ import_id }) => import_id !== removed.import_id),
      );
      const after = await readData();
      expect(after.trips).toEqual(target === 'trip' ? [other] : before.trips);
      expect(after.uploads).toEqual(
        before.uploads
          .filter(({ import_id }) => import_id !== removed.import_id)
          .map((upload) => (target === 'trip' ? { ...upload, trip_id: null } : upload)),
      );
      expect(after.places).toEqual(
        before.places.map((place) => ({
          ...place,
          sources: place.sources.filter(({ import_id }) => import_id !== removed.import_id),
        })),
      );
      for (const item of [single, shared, exclusive].filter((item) => item !== removed)) {
        await checkImage(item.import_id, item !== exclusive);
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dataDir, { recursive: true, force: true });
    }
  },
);

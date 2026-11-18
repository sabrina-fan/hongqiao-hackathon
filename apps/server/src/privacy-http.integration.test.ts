import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm, rmdir } from 'node:fs/promises';
import {
  anonymousDataValidator,
  importBatchValidator,
  importReviewValidator,
  tripDetailValidator,
} from '@nextstop/core';
import { createAmap } from './radar/amap.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
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
      return (path: string, method = 'GET') => fetch(`${base}${path}`, { headers, method });
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
    const blockedSidecar = join(dataDir, 'users', `${firstDb}-journal`);
    await mkdir(blockedSidecar);
    const failed = await first('/me/data', 'DELETE');
    expect(failed.status).toBe(500);
    expect(failed.headers.has('set-cookie')).toBe(false);
    expect((await first('/trips')).status).toBe(401);
    await rmdir(blockedSidecar);
    const deleted = await first('/me/data', 'DELETE');
    expect(deleted.status).toBe(204);
    expect(deleted.headers.get('set-cookie')).toContain('Max-Age=0');
    expect((await first('/me/export')).status).toBe(401);
    expect((await first('/me/data', 'DELETE')).status).toBe(204);
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
  let notifyRouteStarted = () => {};
  const routeStarted = new Promise<void>((resolve) => {
    notifyRouteStarted = resolve;
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
          notifyRouteStarted();
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
    const runningRadar = call('/radar/sessions', 'POST', {
      origin_id: oldPoi.id,
      poi_id: newPoi.id,
      available_min: 75,
    });
    await Promise.race([
      routeStarted,
      runningRadar.then((response) => {
        throw new Error(`Radar returned ${response.status} before map lookup`);
      }),
    ]);
    expect((await call(tripPath, 'DELETE')).status).toBe(204);
    expect((await runningRadar).status).toBe(409);
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

import assert from 'node:assert/strict';
import { once } from 'node:events';
import { chmod, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export async function reproduce(createApp, createAmap) {
  assert.notEqual(process.getuid?.(), 0, 'Run as an unprivileged user for the chmod fault');
  const dataDir = await mkdtemp(join(tmpdir(), 'nextstop-retired-batch-'));
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4ICICAAMQARkzdtKQAAAAAElFTkSuQmCC',
    'base64',
  );
  const poi = { id: 'fixture', name: '合成地点', address: '合成地址' };
  const server = createApp({
    dataDir,
    cookieSecret: 'local-fixture-only',
    map: createAmap({
      key: 'fixture',
      fetcher: async () => Response.json({ status: '1', info: 'OK', pois: [poi] }),
    }),
    vision: async () => ({ kind: 'text', name: poi.name, excerpt: '合成来源', confidence: 'high' }),
  });
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}/api/v1`;
    const session = await fetch(`${base}/sessions`, { method: 'POST' });
    assert.equal(session.status, 204);
    const cookie = session.headers.get('set-cookie')?.split(';')[0];
    assert(cookie);
    function call(path, method = 'GET') {
      return fetch(base + path, { method, headers: { cookie } });
    }
    function post(path, body) {
      const headers = { cookie };
      if (!(body instanceof FormData)) {
        headers['content-type'] = 'application/json';
        body = JSON.stringify(body);
      }
      return fetch(base + path, { method: 'POST', headers, body });
    }
    async function json(response, status) {
      const text = await response.text();
      assert.equal(response.status, status, text);
      return JSON.parse(text);
    }
    const trip = await json(
      await post('/trips', {
        destination: '目标旅行',
        date: '2026-11-20',
        start: '09:00',
        end: '20:00',
        time_zone: 'Asia/Shanghai',
      }),
      201,
    );
    const form = new FormData();
    form.append('images', new File([png], '截图.png', { type: 'image/png' }));
    const initial = await json(await post('/import-batches', form), 202);
    const batchPath = `/import-batches/${initial.batch_id}`;
    let batch;
    for (let i = 0; i < 100; i++) {
      batch = await json(await call(batchPath), 200);
      if (batch.items[0]?.kind !== 'processing') break;
      await delay(50);
    }
    assert.equal(batch.items[0]?.kind, 'ready');
    const [sqlite] = (await readdir(join(dataDir, 'users'))).filter((file) =>
      file.endsWith('.sqlite'),
    );
    assert(sqlite);
    const id = batch.items[0].import_id;
    const directory = join(dataDir, 'import-images', sqlite.slice(0, -'.sqlite'.length), id);
    const remove = () => post(`${batchPath}/items/${id}/remove`, { revision: batch.revision });

    assert.deepEqual((await readdir(directory)).sort(), ['normalized', 'original']);
    await chmod(directory, 0o500);
    try {
      const failed = await json(await remove(), 500);
      assert.equal(failed.error.code, 'INTERNAL_ERROR');
    } finally {
      await chmod(directory, 0o700);
    }
    const empty = await json(await call(batchPath), 200);
    assert.equal(empty.revision, batch.revision + 1);
    assert.deepEqual(empty.items, []);
    assert.equal((await call(`/trips/${trip.trip_id}`, 'DELETE')).status, 204);
    assert.equal((await json(await call(batchPath), 404)).error.code, 'IMPORT_NOT_FOUND');
    assert.deepEqual((await readdir(directory)).sort(), ['normalized', 'original']);

    for (let i = 0; i < 2; i++) {
      const replay = await json(await remove(), 404);
      assert.equal(replay.error.code, 'IMPORT_NOT_FOUND');
      await assert.rejects(readdir(directory), { code: 'ENOENT' });
    }
    process.stdout.write(
      'remove 500, empty batch 200, trip DELETE 204, same remove 404 twice, files absent\n',
    );
  } finally {
    try {
      await server[Symbol.asyncDispose]();
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  }
}

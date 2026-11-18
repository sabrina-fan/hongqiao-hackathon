import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importReviewValidator, radarViewValidator } from '@nextstop/core';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createApp } from './app.js';
import type { RadarMap } from './radar/amap.js';

const origin = { id: 'fixture-origin', name: '起点', address: '人民路 10 号' };
const place = { id: 'fixture-bookshop', name: '山塘书店', address: '姑苏区广济路 88 号' };
const map: RadarMap = {
  search: async (query) => [place].filter(({ name }) => name.includes(query)),
  walkToFixed: async () => {
    throw new Error('Wishlist test does not use a fixed stop');
  },
  walk: async () => ({
    origin,
    destination: place,
    distance_m: 800,
    travel_min: 10,
    fetched_at: new Date().toISOString(),
  }),
};
let dataDir: string;
let server: ReturnType<typeof createApp>;
let base: string;
const cookieSecret = randomBytes(32).toString('hex');

async function start() {
  server = createApp({
    dataDir,
    cookieSecret,
    map,
    vision: async () => ({
      kind: 'text',
      name: place.name,
      excerpt: '雨天逛书店',
      confidence: 'high',
    }),
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('TCP port required');
  base = `http://127.0.0.1:${address.port}/api/v1`;
}
async function close() {
  if (server.listening)
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
}
beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'nextstop-wishlist-'));
  await start();
});
afterEach(async () => {
  try {
    await close();
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

async function guest() {
  const response = await fetch(`${base}/sessions`, { method: 'POST' });
  expect(response.status).toBe(204);
  const cookie = response.headers.get('set-cookie')?.split(';')[0];
  if (!cookie) throw new Error('Missing guest cookie');
  return { cookie };
}
const item = `/wishlist/amap/${place.id}`;
function json(
  method: 'PATCH' | 'POST',
  path: string,
  body: unknown,
  headers: Record<string, string>,
) {
  return fetch(base + path, {
    method,
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
async function readJson(response: Response, status = 200): Promise<unknown> {
  expect(response.status).toBe(status);
  return response.json();
}
async function confirm(response: Response, headers: Awaited<ReturnType<typeof guest>>) {
  const review = await readJson(response, 201);
  if (!importReviewValidator.check(review)) throw new Error('Invalid import review');
  const path = `/imports/${review.import_id}`;
  const selection = { provider: 'amap', poi_id: place.id, revision: review.revision };
  expect((await json('POST', path + '/confirm', selection, headers)).status).toBe(200);
  return { review, path, selection };
}

it('moves a saved place from want-to-go to visited across a server restart', async () => {
  const headers = await guest();
  await confirm(await json('POST', '/imports/search', { query: '书店' }, headers), headers);
  const list = (query: string) => readJsonFromList(query, headers);
  expect(await list('?visit=unvisited')).toMatchObject({ places: [{ poi_id: place.id }] });
  expect((await json('PATCH', item, { visit: 'visited' }, headers)).status).toBe(200);
  await close();
  await start();
  expect(await list('?visit=visited')).toMatchObject({
    places: [{ poi_id: place.id, visit: 'visited' }],
  });
  expect(await list('?visit=unvisited')).toEqual({ places: [] });
});

function readJsonFromList(query: string, headers: Awaited<ReturnType<typeof guest>>) {
  return fetch(`${base}/wishlist${query}`, { headers }).then((response) => readJson(response));
}

it('preserves sources and isolates edits while filtering by confirmed schedule, evidence and note', async () => {
  const headers = await guest();
  const stranger = await guest();
  const bytes = await readFile(new URL('../test/import-synthetic.png', import.meta.url));
  const form = new FormData();
  form.set('image', new File([Uint8Array.from(bytes)], 'synthetic.png', { type: 'image/png' }));
  const image = await confirm(
    await fetch(`${base}/imports`, { method: 'POST', headers, body: form }),
    headers,
  );
  expect((await fetch(base + item)).status).toBe(401);
  expect((await fetch(base + item, { headers: stranger })).status).toBe(404);
  expect((await json('PATCH', item, { note: '不属于此访客' }, stranger)).status).toBe(404);
  expect((await fetch(base + item, { method: 'DELETE', headers: stranger })).status).toBe(404);
  expect(
    (
      await fetch(base + item, {
        method: 'DELETE',
        headers: { ...headers, origin: 'https://example.invalid' },
      })
    ).status,
  ).toBe(403);
  expect((await json('PATCH', item, { address: '无法覆盖地图地址' }, headers)).status).toBe(400);
  expect((await json('PATCH', item, { note: '夜游备选', visit: 'visited' }, headers)).status).toBe(
    200,
  );

  const manual = await confirm(
    await json('POST', '/imports/search', { query: '书店' }, headers),
    headers,
  );
  expect(await readJson(await fetch(base + item, { headers }))).toMatchObject({
    address: place.address,
    note: '夜游备选',
    visit: 'visited',
    schedule: 'unscheduled',
    evidence: 'unknown',
    sources: [image.review.source, manual.review.source],
  });
  const query = `?visit=visited&evidence=unknown&q=${encodeURIComponent('夜游备选')}&schedule=`;
  expect(await readJsonFromList(query + 'unscheduled', headers)).toMatchObject({
    places: [{ poi_id: place.id }],
  });
  expect(await readJsonFromList(query + 'scheduled', headers)).toEqual({ places: [] });

  const radar = await readJson(
    await json(
      'POST',
      '/radar/sessions',
      {
        origin_id: origin.id,
        poi_id: place.id,
        available_min: 90,
      },
      headers,
    ),
    201,
  );
  if (!radarViewValidator.check(radar)) throw new Error('Invalid radar response');
  const { binding } = radar.outcome;
  expect(
    (
      await json(
        'POST',
        `/radar/sessions/${binding.session_id}/accept`,
        {
          binding,
          poi_id: place.id,
        },
        { ...headers, 'idempotency-key': 'wishlist-trip-accept' },
      )
    ).status,
  ).toBe(200);
  expect(await readJsonFromList(query + 'scheduled', headers)).toMatchObject({
    places: [{ poi_id: place.id }],
  });
  expect(await readJsonFromList(query + 'unscheduled', headers)).toEqual({ places: [] });

  expect((await fetch(base + item, { method: 'DELETE', headers })).status).toBe(204);
  expect((await fetch(base + item, { headers })).status).toBe(404);
  expect((await fetch(base + image.path + '/image', { headers })).status).toBe(200);
  expect((await json('POST', image.path + '/confirm', image.selection, headers)).status).toBe(200);
  expect(await readJsonFromList('', headers)).toEqual({ places: [] });
  expect(await readJson(await fetch(`${base}/trip`, { headers }))).toMatchObject({
    stops: [{ poi_id: place.id }],
  });
});

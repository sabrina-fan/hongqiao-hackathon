import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importReviewValidator, tripDetailValidator, tripDraftValidator } from '@nextstop/core';
import { expect, it } from 'vitest';
import { createApp } from './app.js';
import type { RadarMap } from './radar/amap.js';

const places = [
  { id: 'garden', name: '甲园', address: '苏州市姑苏区甲路 1 号' },
  { id: 'museum', name: '乙馆', address: '苏州市姑苏区甲路 2 号' },
  { id: 'park', name: '丙公园', address: '苏州市姑苏区甲路 3 号' },
  { id: 'shop', name: '丁书店', address: '苏州市姑苏区甲路 4 号' },
  { id: 'dinner', name: '预约晚餐', address: '苏州市姑苏区甲路 5 号' },
  { id: 'z-extra', name: '新增收藏', address: '苏州市姑苏区甲路 6 号' },
];
const appointment = {
  name: '预约晚餐',
  address: '苏州市姑苏区甲路 5 号',
  start: '17:30',
  end: '18:30',
  locked: true,
};
const day = {
  destination: '苏州',
  date: '2026-11-20',
  time_zone: 'Asia/Shanghai',
  start: '15:55',
  end: '18:30',
};

async function tripOf(response: Response, status = 200) {
  expect(response.status).toBe(status);
  const data: unknown = await response.json();
  if (!tripDetailValidator.check(data)) throw new Error('Invalid trip detail');
  return data;
}

async function draftOf(response: Response) {
  expect(response.status).toBe(200);
  const data: unknown = await response.json();
  if (!tripDraftValidator.check(data)) throw new Error('Invalid trip draft');
  return data;
}

it('shows two conflicts in a private draft and applies it only by confirmation, preserving the locked activity', async () => {
  let now = Date.parse('2026-11-18T01:00:00Z');
  const map: RadarMap = {
    async search(query) {
      return places.filter((place) => place.name === query || place.address === query);
    },
    async walk({ origin_id, poi_id }) {
      const origin = places.find(({ id }) => id === origin_id);
      const destination = places.find(({ id }) => id === poi_id);
      if (!origin || !destination) throw new Error('Unexpected walking request');
      return {
        origin,
        destination,
        travel_min: 5,
        distance_m: 350,
        fetched_at: new Date(now).toISOString(),
      };
    },
  };
  const dataDir = await mkdtemp(join(tmpdir(), 'nextstop-draft-'));
  const server = createApp({
    dataDir,
    map,
    now: () => now,
    cookieSecret: randomBytes(32).toString('hex'),
  });
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('TCP port required');
    const base = `http://127.0.0.1:${address.port}/api/v1`;
    async function guest() {
      const session = await fetch(`${base}/sessions`, { method: 'POST' });
      expect(session.status).toBe(204);
      const cookie = session.headers.get('set-cookie')?.split(';')[0];
      if (!cookie) throw new Error('Missing session cookie');
      return { cookie };
    }
    const headers = await guest();
    const get = (path: string) => fetch(base + path, { headers });
    const post = (path: string, body: unknown, identity = headers) =>
      fetch(base + path, {
        method: 'POST',
        headers: { ...identity, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const created = await tripOf(await post('/trips', day), 201);
    const path = `/trips/${created.trip_id}`;
    const before = await tripOf(
      await post(`${path}/arrangements`, { revision: created.revision, arrangement: appointment }),
    );
    async function confirmPlace(place: (typeof places)[number]) {
      const searched = await post('/imports/search', { query: place.name });
      expect(searched.status).toBe(201);
      const review: unknown = await searched.json();
      if (!importReviewValidator.check(review)) throw new Error('Invalid manual review');
      const saved = await post(`/imports/${review.import_id}/confirm`, {
        revision: review.revision,
        provider: 'amap',
        poi_id: place.id,
      });
      expect(saved.status).toBe(200);
    }
    for (const place of places.slice(0, 4)) await confirmPlace(place);

    const draftPath = `${path}/draft`;
    const snapshot = await draftOf(await post(draftPath, { revision: before.revision }));
    expect(snapshot).toMatchObject({
      trip_revision: before.revision,
      day,
      entries: [
        { kind: 'scheduled', poi_id: 'garden', start: '15:55', end: '16:35' },
        { kind: 'scheduled', poi_id: 'museum', start: '16:40', end: '17:20' },
        { kind: 'unscheduled', poi_id: 'park', reason: 'time_conflict' },
        { kind: 'unscheduled', poi_id: 'shop', reason: 'time_conflict' },
      ],
    });
    expect(await tripOf(await get(path))).toEqual(before);
    expect(await (await get(draftPath)).json()).toEqual({ draft: snapshot, needs_review: false });
    const stranger = await guest();
    expect((await post(draftPath, { revision: before.revision }, stranger)).status).toBe(404);
    const version = ({ draft_id, revision }: typeof snapshot) => ({ draft_id, revision });
    const apply = (draft: typeof snapshot) => post(`${draftPath}/apply`, version(draft));
    expect((await post(`${draftPath}/apply`, version(snapshot), stranger)).status).toBe(404);

    const changed = await tripOf(
      await post(path, { revision: before.revision, day: { ...day, start: '15:50' } }),
    );
    const outdated = await apply(snapshot);
    expect(outdated.status).toBe(409);
    expect(await outdated.json()).toMatchObject({ error: { code: 'DRAFT_STALE' } });
    expect(await tripOf(await get(path))).toEqual(changed);
    expect(await (await get(draftPath)).json()).toEqual({ draft: snapshot, needs_review: true });
    const refreshed = await draftOf(await post(draftPath, { revision: changed.revision }));
    expect(refreshed.draft_id).not.toBe(snapshot.draft_id);
    now = refreshed.expires_at;
    expect((await apply(refreshed)).status).toBe(409);
    expect(await tripOf(await get(path))).toEqual(changed);

    const expiredReplacement = await draftOf(await post(draftPath, { revision: changed.revision }));
    const extra = places.find(({ id }) => id === 'z-extra');
    if (!extra) throw new Error('Missing new collection fixture');
    await confirmPlace(extra);
    expect((await apply(expiredReplacement)).status).toBe(409);
    expect(await (await get(draftPath)).json()).toEqual({
      draft: expiredReplacement,
      needs_review: true,
    });
    expect(await tripOf(await get(path))).toEqual(changed);
    const current = await draftOf(await post(draftPath, { revision: changed.revision }));
    const editPath = `${draftPath}/edit`;
    const moved = await draftOf(
      await post(editPath, {
        ...version(current),
        edit: { kind: 'move', poi_id: 'museum', direction: 'up' },
      }),
    );
    expect(moved.entries.slice(0, 2)).toMatchObject([
      { poi_id: 'museum', start: '15:50' },
      { poi_id: 'garden', start: '16:35' },
    ]);
    const locked = await draftOf(
      await post(editPath, {
        ...version(moved),
        edit: { kind: 'lock', poi_id: 'museum', locked: true },
      }),
    );
    expect(
      (await post(editPath, { ...version(locked), edit: { kind: 'skip', poi_id: 'museum' } }))
        .status,
    ).toBe(409);
    const skipped = await draftOf(
      await post(editPath, { ...version(locked), edit: { kind: 'skip', poi_id: 'garden' } }),
    );
    expect(skipped.entries).toMatchObject([
      { poi_id: 'museum', start: '15:50', end: '16:30', locked: true },
      { poi_id: 'garden', kind: 'skipped' },
      { poi_id: 'park', start: '16:35', end: '17:15' },
      { poi_id: 'shop', kind: 'unscheduled' },
      { poi_id: 'z-extra', kind: 'unscheduled' },
    ]);
    expect((await apply(moved)).status).toBe(409);
    expect(await tripOf(await get(path))).toEqual(changed);
    expect(await (await get(draftPath)).json()).toEqual({ draft: skipped, needs_review: false });

    const [applied, replay] = await Promise.all([
      apply(skipped).then((response) => tripOf(response)),
      apply(skipped).then((response) => tripOf(response)),
    ]);
    expect(replay).toEqual(applied);
    expect(applied.revision).toBe(changed.revision + 1);
    expect(applied.arrangements).toMatchObject([
      changed.arrangements[0],
      { poi_id: 'museum', start: '15:50', end: '16:30', locked: true },
      { poi_id: 'park', start: '16:35', end: '17:15', locked: false },
    ]);
    expect(applied.arrangements[0]).toEqual(before.arrangements[0]);
    expect(await tripOf(await get(path))).toEqual(applied);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dataDir, { recursive: true, force: true });
  }
});

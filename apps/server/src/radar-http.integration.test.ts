import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  acceptReceiptValidator,
  radarViewValidator,
  tripDetailValidator,
  type RadarView,
} from '@nextstop/core';
import { createApp } from './app.js';
import { MapFault, type RadarMap } from './radar/amap.js';

let directory: string;
let url: string;
let server: ReturnType<typeof createApp>;
let clock = 0;
let failMap = false;
const secret = randomBytes(32).toString('hex');
const origin = { id: 'origin', name: '起点', address: '' };
const destination = { id: 'candidate', name: '候选地', address: '' };
const map: RadarMap = {
  search: async (q) => [origin, destination].filter((place) => place.name.includes(q)),
  async walk() {
    if (failMap) throw new MapFault('MAP_UNAVAILABLE');
    return {
      origin,
      destination,
      distance_m: 800,
      travel_min: 10,
      fetched_at: new Date(clock).toISOString(),
    };
  },
};
async function listen() {
  server = createApp({ dataDir: directory, cookieSecret: secret, map, now: () => clock });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('TCP port required');
  url = `http://127.0.0.1:${address.port}/api/v1`;
}
async function close() {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'radar-http-'));
  clock = Date.UTC(2026, 10, 18, 8);
  failMap = false;
  await listen();
});
afterEach(async () => {
  try {
    await close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function guest() {
  const result = await fetch(`${url}/sessions`, { method: 'POST' });
  expect(result.status).toBe(204);
  const header = result.headers.get('set-cookie');
  expect(header).toMatch(/HttpOnly; SameSite=Lax/);
  const cookie = header?.split(';')[0];
  if (!cookie) throw new Error('Missing session cookie');
  return cookie;
}
function post(path: string, body: unknown, cookie: string, key?: string) {
  return fetch(url + path, {
    method: 'POST',
    headers: {
      cookie,
      'content-type': 'application/json',
      ...(key ? { 'Idempotency-Key': key } : {}),
    },
    body: JSON.stringify(body),
  });
}
const request = { origin_id: origin.id, poi_id: destination.id, available_min: 90 };
async function propose(cookie: string, available_min = 90) {
  const result = await post('/radar/sessions', { ...request, available_min }, cookie);
  expect(result.status).toBe(201);
  const view: unknown = await result.json();
  if (!radarViewValidator.check(view)) throw new Error('Invalid radar view');
  return view;
}
const pathOf = (view: RadarView) => `/radar/sessions/${view.outcome.binding.session_id}`;
const accept = (cookie: string, view: RadarView, key: string) =>
  post(
    `${pathOf(view)}/accept`,
    { binding: view.outcome.binding, poi_id: destination.id },
    cookie,
    key,
  );
const trip = (cookie: string) =>
  fetch(`${url}/trip`, { headers: { cookie } }).then((response) => response.json());
async function expectFault(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(await response.json()).toMatchObject({ error: { code } });
}

describe('radar through HTTP and per-guest SQLite', () => {
  it('restores the same receipt across concurrent confirmation, expiry and a server restart', async () => {
    const cookie = await guest();
    expect(await trip(cookie)).toBeNull();
    const view = await propose(cookie);
    expect(view.outcome.kind).toBe('recommendations');
    const current = await fetch(url + pathOf(view), { headers: { cookie } });
    expect(await current.json()).toEqual(view);
    const responses = await Promise.all([
      accept(cookie, view, 'same-confirmation'),
      accept(cookie, view, 'same-confirmation'),
    ]);
    const receipts: unknown[] = [];
    for (const response of responses) {
      expect(response.status).toBe(200);
      receipts.push(await response.json());
    }
    const first = receipts[0];
    if (!acceptReceiptValidator.check(first)) throw new Error('Invalid confirmation receipt');
    expect(receipts[1]).toEqual(first);
    clock += 360_000;
    await close();
    await listen();
    const replay = await accept(cookie, view, 'same-confirmation');
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(first);
    expect(await trip(cookie)).toEqual({
      trip_id: first.trip_id,
      revision: first.trip_revision,
      stops: [first.stop],
    });
    const conflict = await post(
      `${pathOf(view)}/accept`,
      { binding: view.outcome.binding, poi_id: 'other' },
      cookie,
      'same-confirmation',
    );
    await expectFault(conflict, 409, 'IDEMPOTENCY_CONFLICT');
  });
  it('lists the legacy trip and keeps a locked arrangement when radar appends to the current trip', async () => {
    const cookie = await guest();
    const initial = await propose(cookie);
    const legacy = await accept(cookie, initial, 'legacy');
    const receipt: unknown = await legacy.json();
    if (!acceptReceiptValidator.check(receipt)) throw new Error('Missing legacy receipt');
    const day = {
      destination: '苏州',
      date: '2026-11-20',
      time_zone: 'Asia/Shanghai',
      start: '09:00',
      end: '20:00',
    };
    const created = await post('/trips', day, cookie);
    const planned: unknown = await created.json();
    if (!tripDetailValidator.check(planned)) throw new Error('Missing planned trip');
    const path = `/trips/${planned.trip_id}`;
    const arrangement = {
      name: '预约晚餐',
      start: '17:30',
      end: '18:30',
      address: '平江路 10 号',
      locked: true,
    };
    expect(
      (await post(`${path}/arrangements`, { revision: planned.revision, arrangement }, cookie))
        .status,
    ).toBe(200);
    const proposal = await propose(cookie);
    expect(proposal.outcome.binding).toMatchObject({
      trip_id: planned.trip_id,
      trip_revision: planned.revision + 1,
    });
    expect((await accept(cookie, proposal, 'planned')).status).toBe(200);
    const get = (path: string) =>
      fetch(url + path, { headers: { cookie } }).then((response) => response.json());
    expect(await get(path)).toMatchObject({
      day,
      revision: planned.revision + 2,
      arrangements: [arrangement],
      stops: [{ name: destination.name }],
    });
    expect(await get('/trips')).toMatchObject({
      current_trip_id: planned.trip_id,
      trips: [{ trip_id: planned.trip_id }, { trip_id: receipt.trip_id, day: null }],
    });
    expect(await get(`/trips/${receipt.trip_id}`)).toMatchObject({
      revision: receipt.trip_revision,
      stops: [receipt.stop],
    });
  });
  it('rejects outdated proposal, pool, ETA and trip bindings, including a competing tab', async () => {
    const cookie = await guest();
    const view = await propose(cookie);
    for (const field of ['proposal_revision', 'pool_revision', 'eta_revision']) {
      await expectFault(
        await post(
          `${pathOf(view)}/accept`,
          { binding: { ...view.outcome.binding, [field]: 9 }, poi_id: destination.id },
          cookie,
          field,
        ),
        409,
        'PROPOSAL_STALE',
      );
    }
    expect(await trip(cookie)).toBeNull();
    const other = await propose(cookie);
    expect((await accept(cookie, other, 'other')).status).toBe(200);
    const before = await trip(cookie);
    await expectFault(await accept(cookie, view, 'late'), 409, 'PROPOSAL_STALE');
    expect(await trip(cookie)).toEqual(before);
    const expired = await propose(cookie);
    clock += 300_001;
    await expectFault(await accept(cookie, expired, 'expired'), 409, 'PROPOSAL_STALE');
    expect(await trip(cookie)).toEqual(before);
  });
  it('returns a validated empty outcome for an infeasible window and preserves map failures', async () => {
    const cookie = await guest();
    const view = await propose(cookie, 5);
    expect(view.outcome.kind).toBe('empty');
    await expectFault(await accept(cookie, view, 'empty'), 409, 'NO_FEASIBLE_OPTION');
    failMap = true;
    await expectFault(await post('/radar/sessions', request, cookie), 502, 'MAP_UNAVAILABLE');
    expect(await trip(cookie)).toBeNull();
  });
  it('isolates guest files, requires a valid cookie and validates search and write inputs', async () => {
    const a = await guest();
    const b = await guest();
    const view = await propose(a);
    expect((await fetch(url + pathOf(view), { headers: { cookie: b } })).status).toBe(404);
    await expectFault(await accept(b, view, 'same-key'), 404, 'NOT_FOUND');
    expect(await trip(b)).toBeNull();
    expect(
      await (
        await fetch(`${url}/places?q=${encodeURIComponent('起点')}`, { headers: { cookie: a } })
      ).json(),
    ).toEqual({ places: [origin] });
    await expectFault(await fetch(`${url}/trip`), 401, 'SESSION_REQUIRED');
    await expectFault(
      await fetch(`${url}/trip`, { headers: { cookie: a + 'x' } }),
      401,
      'SESSION_REQUIRED',
    );
    await expectFault(
      await fetch(`${url}/sessions`, {
        method: 'POST',
        headers: { origin: 'https://elsewhere.invalid' },
      }),
      403,
      'CROSS_ORIGIN',
    );
    await expectFault(
      await post('/radar/sessions', { ...request, validated: true }, a),
      400,
      'INVALID_REQUEST',
    );
    await expectFault(
      await post('/radar/sessions', { oversized: 'x'.repeat(9000) }, a),
      413,
      'REQUEST_TOO_LARGE',
    );
    await expectFault(
      await post(
        `${pathOf(view)}/accept`,
        { binding: view.outcome.binding, poi_id: destination.id },
        a,
      ),
      400,
      'INVALID_REQUEST',
    );
    expect(await trip(a)).toBeNull();
  });
});

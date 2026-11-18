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
  type RadarRequest,
  type RadarView,
} from '@nextstop/core';
import { createApp } from './app.js';
import { MapFault, type RadarMap } from './radar/amap.js';

let directory: string;
let url: string;
let server: ReturnType<typeof createApp>;
let clock = 0;
let failMap = false;
let outboundMinutes = 10;
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
      travel_min: outboundMinutes,
      fetched_at: new Date(clock).toISOString(),
    };
  },
  async walkToFixed({ fixed }) {
    return {
      origin: destination,
      destination: { id: fixed.arrangement_id, name: fixed.name, address: fixed.address },
      distance_m: 1200,
      travel_min: 15,
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
  outboundMinutes = 10;
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
async function propose(
  cookie: string,
  available_min = 90,
  fixed_mode?: RadarRequest['fixed_mode'],
) {
  const result = await post('/radar/sessions', { ...request, available_min, fixed_mode }, cookie);
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
  it('recovers a lost confirmation and undoes only its insertion after later edits', async () => {
    const cookie = await guest();
    const created = await post(
      '/trips',
      {
        destination: '苏州',
        date: '2026-11-18',
        time_zone: 'Asia/Shanghai',
        start: '09:00',
        end: '20:00',
      },
      cookie,
    );
    const planned: unknown = await created.json();
    if (!tripDetailValidator.check(planned)) throw new Error('Missing planned trip');
    const path = `/trips/${planned.trip_id}`;
    const get = (path: string, owner = cookie) => fetch(url + path, { headers: { cookie: owner } });
    const locked = {
      name: '预约晚餐',
      start: '17:30',
      end: '18:30',
      address: '平江路 10 号',
      locked: true,
    };
    expect(
      (
        await post(
          `${path}/arrangements`,
          { revision: planned.revision, arrangement: locked },
          cookie,
        )
      ).status,
    ).toBe(200);
    const view = await propose(cookie);
    const before: unknown = await (await get(path)).json();
    expect(before).toMatchObject({ arrangements: [locked], stops: [] });

    const lost = await accept(cookie, view, 'lost-receipt');
    expect(lost.status).toBe(200);
    await lost.body?.cancel();
    const replay = await accept(cookie, view, 'lost-receipt');
    expect(replay.status).toBe(200);
    const receipt: unknown = await replay.json();
    if (!acceptReceiptValidator.check(receipt)) throw new Error('Missing replayed receipt');
    expect(await (await get(path)).json()).toMatchObject({ stops: [receipt.stop] });

    const independent = {
      name: '夜间散步',
      start: '19:00',
      end: '19:30',
      address: '',
      locked: false,
    };
    const edit = await post(
      `${path}/arrangements`,
      { revision: receipt.trip_revision, arrangement: independent },
      cookie,
    );
    expect(edit.status).toBe(200);
    const second = await propose(cookie);
    const secondAccept = await accept(cookie, second, 'independent-insertion');
    expect(secondAccept.status).toBe(200);
    const secondReceipt: unknown = await secondAccept.json();
    if (!acceptReceiptValidator.check(secondReceipt)) throw new Error('Missing second receipt');
    expect(secondReceipt.stop.poi_id).toBe(receipt.stop.poi_id);
    const switched = await post('/trips', { ...planned.day, date: '2026-11-19' }, cookie);
    expect(switched.status).toBe(201);
    const unrelated: unknown = await switched.json();
    if (!tripDetailValidator.check(unrelated)) throw new Error('Missing newly active trip');

    const acceptance = `${pathOf(view)}/acceptance`;
    clock += 300_001;
    await close();
    await listen();
    const recovered = await get(acceptance);
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toMatchObject({ status: 'added', receipt, destination });
    const outsider = await guest();
    await expectFault(await get(acceptance, outsider), 404, 'NOT_FOUND');
    await expectFault(
      await post(`${acceptance}/undo`, { stop_id: receipt.stop.stop_id }, outsider),
      404,
      'NOT_FOUND',
    );
    await expectFault(
      await post(`${acceptance}/undo`, { stop_id: secondReceipt.stop.stop_id }, cookie),
      409,
      'ACCEPTANCE_MISMATCH',
    );
    const undo = () => post(`${acceptance}/undo`, { stop_id: receipt.stop.stop_id }, cookie);
    for (const response of await Promise.all([undo(), undo()])) {
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ status: 'undone', receipt });
    }
    expect(await (await accept(cookie, view, 'lost-receipt')).json()).toEqual(receipt);
    expect(await (await get(acceptance)).json()).toMatchObject({ status: 'undone', receipt });
    expect(await (await get(path)).json()).toMatchObject({
      revision: secondReceipt.trip_revision + 1,
      arrangements: [locked, independent],
      stops: [secondReceipt.stop],
    });
    expect(await (await get(`/trips/${unrelated.trip_id}`)).json()).toEqual(unrelated);
  });
  it('keeps a running lock out of the next stop until its exact end', async () => {
    const cookie = await guest();
    const created = await post(
      '/trips',
      {
        destination: '苏州',
        date: '2026-11-18',
        time_zone: 'Asia/Shanghai',
        start: '09:00',
        end: '22:00',
      },
      cookie,
    );
    let planned: unknown = await created.json();
    for (const arrangement of [
      { name: '预约晚餐', start: '17:15', end: '18:15', address: '平江路 10 号' },
      { name: '演出', start: '19:30', end: '21:00', address: '演出地址' },
    ]) {
      if (!tripDetailValidator.check(planned)) throw new Error('Missing planned trip');
      const response = await post(
        `/trips/${planned.trip_id}/arrangements`,
        { revision: planned.revision, arrangement: { ...arrangement, locked: true } },
        cookie,
      );
      expect(response.status).toBe(200);
      planned = await response.json();
    }
    const context = async () => {
      const response = await fetch(`${url}/radar/context`, { headers: { cookie } });
      expect(response.status).toBe(200);
      return response.json();
    };
    const start = Date.UTC(2026, 10, 18, 9, 15);
    const end = Date.UTC(2026, 10, 18, 10, 15);
    clock = start - 1;
    expect(await context()).toMatchObject({ fixed: { name: '预约晚餐' } });
    failMap = true;
    for (const at of [start, end - 1]) {
      clock = at;
      expect(await context()).toMatchObject({
        fixed: { name: '演出' },
        in_progress: { name: '预约晚餐', ends_at: new Date(end).toISOString() },
      });
      await expectFault(await post('/radar/sessions', request, cookie), 409, 'FIXED_IN_PROGRESS');
      await expectFault(
        await post('/radar/sessions', { ...request, fixed_mode: 'without_fixed' }, cookie),
        409,
        'FIXED_IN_PROGRESS',
      );
    }
    clock = end;
    failMap = false;
    outboundMinutes = 8;
    expect(await context()).toMatchObject({ fixed: { name: '演出' }, in_progress: null });
    expect(await propose(cookie)).toMatchObject({
      available_min: 75,
      window: { fixed: { name: '演出' }, remaining_min: 2 },
      outcome: { kind: 'recommendations' },
    });
  });
  it('allows a verified 73-minute plan in 75 minutes and rejects it in 72', async () => {
    const cookie = await guest();
    const created = await post(
      '/trips',
      {
        destination: '苏州',
        date: '2026-11-18',
        time_zone: 'Asia/Shanghai',
        start: '09:00',
        end: '20:00',
      },
      cookie,
    );
    const planned: unknown = await created.json();
    if (!tripDetailValidator.check(planned)) throw new Error('Missing planned trip');
    const locked = await post(
      `/trips/${planned.trip_id}/arrangements`,
      {
        revision: planned.revision,
        arrangement: {
          name: '预约晚餐',
          start: '17:15',
          end: '18:30',
          address: '平江路 10 号',
          locked: true,
        },
      },
      cookie,
    );
    expect(locked.status).toBe(200);
    outboundMinutes = 8;
    const fitting = await propose(cookie);
    expect(fitting).toMatchObject({
      available_min: 75,
      window: { limited_by: 'fixed', remaining_min: 2 },
      outcome: {
        kind: 'recommendations',
        best: { travel_to_min: 8, stay_min_estimate: 40, travel_to_next_min: 15, buffer_min: 10 },
      },
    });
    expect(await propose(cookie, 73)).toMatchObject({
      available_min: 73,
      window: { limited_by: 'manual', remaining_min: 0 },
      outcome: { kind: 'recommendations' },
    });
    const tight = await propose(cookie, 72);
    expect(tight).toMatchObject({
      available_min: 72,
      window: { limited_by: 'manual', fixed: { name: '预约晚餐' } },
      outcome: { kind: 'empty' },
    });
    expect(await propose(cookie, 90, 'without_fixed')).toMatchObject({
      available_min: 75,
      window: { limited_by: 'fixed', fixed: { name: '预约晚餐' }, remaining_min: 2 },
      outcome: { kind: 'recommendations', best: { travel_to_next_min: 15 } },
    });
    await expectFault(await accept(cookie, tight, 'tight'), 409, 'NO_FEASIBLE_OPTION');
    expect((await accept(cookie, fitting, 'fitting')).status).toBe(200);
    expect(await trip(cookie)).toMatchObject({ stops: [{ poi_id: destination.id }] });
  });
  it('requires an explicit search without a locationless lock and keeps saved evidence read-only after expiry', async () => {
    const cookie = await guest();
    const created = await post(
      '/trips',
      {
        destination: '苏州',
        date: '2026-11-18',
        time_zone: 'Asia/Shanghai',
        start: '09:00',
        end: '20:00',
      },
      cookie,
    );
    let planned: unknown = await created.json();
    for (const arrangement of [
      { name: '预约晚餐', start: '17:15', end: '18:30', address: '' },
      { name: '演出', start: '19:00', end: '20:00', address: '演出地址' },
    ]) {
      if (!tripDetailValidator.check(planned)) throw new Error('Missing planned trip');
      const response = await post(
        `/trips/${planned.trip_id}/arrangements`,
        { revision: planned.revision, arrangement: { ...arrangement, locked: true } },
        cookie,
      );
      expect(response.status).toBe(200);
      planned = await response.json();
    }
    const history = (owner: string) =>
      fetch(`${url}/radar/history`, { headers: { cookie: owner } }).then((response) =>
        response.json(),
      );
    expect(await history(cookie)).toBeNull();
    await expectFault(
      await post('/radar/sessions', request, cookie),
      409,
      'FIXED_LOCATION_REQUIRED',
    );
    const view = await propose(cookie, 90, 'without_fixed');
    expect(view).toMatchObject({
      available_min: 90,
      window: { fixed: null, limited_by: 'manual' },
      outcome: { best: { travel_to_next_min: null, buffer_min: 0 } },
    });
    expect(await history(cookie)).toEqual({ status: 'saved', view });
    expect(await history(await guest())).toBeNull();
    clock += 300_001;
    await close();
    await listen();
    expect(await history(cookie)).toEqual({ status: 'stale', view });
    await expectFault(await accept(cookie, view, 'history'), 409, 'PROPOSAL_STALE');
    clock = Date.UTC(2026, 10, 18, 9, 14);
    const beforeStart = await propose(cookie, 90, 'without_fixed');
    expect(beforeStart.outcome.kind).toBe('recommendations');
    clock += 60_000;
    await expectFault(await accept(cookie, beforeStart, 'lock-started'), 409, 'PROPOSAL_STALE');
    expect(await trip(cookie)).toMatchObject({ stops: [] });
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

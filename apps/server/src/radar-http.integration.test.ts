import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { json } from 'node:stream/consumers';
import { arr, compile, nullable, obj, opt, str } from '@earendil-works/pi-schema';
import { createRadarModel, type RadarModel } from '@nextstop/model-gateway';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  acceptReceiptValidator,
  importReviewValidator,
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
let savedMinutes: number | null = null;
let blockedRoute: string | null = null;
let farMinutes = 85;
let farOnwardMinutes = 15;
let facts: Map<string, NonNullable<Awaited<ReturnType<RadarMap['walk']>>['facts']>>;
let distance: Map<string, number>;
const mapCalls: string[] = [];
const secret = randomBytes(32).toString('hex');
const origin = { id: 'origin', name: '起点', address: '' };
const destination = { id: 'candidate', name: '候选地', address: '' };
const saved = { id: 'saved', name: '收藏书店', address: '书店路 1 号' };
const far = { id: 'far', name: '远方公园', address: '' };
const recallMap = {
  async resolveOrigin() {
    mapCalls.push('origin');
    return {
      place: origin,
      point: { system: 'gcj02' as const, longitude: 120.62, latitude: 31.32 },
    };
  },
  async nearby() {
    mapCalls.push('nearby');
    return [saved, destination, far];
  },
};
const map: RadarMap = {
  ...recallMap,
  search: async (q) => [origin, destination, saved].filter((place) => place.name.includes(q)),
  async walk({ poi_id }) {
    mapCalls.push(`walk:${poi_id}`);
    if (failMap) throw new MapFault('MAP_UNAVAILABLE');
    if (poi_id === blockedRoute) throw new MapFault('ROUTE_UNVERIFIED');
    const placeFacts = facts.get(poi_id);
    return {
      origin,
      destination: [destination, saved, far].find((place) => place.id === poi_id) ?? destination,
      distance_m: distance.get(poi_id) ?? 800,
      travel_min:
        poi_id === far.id
          ? farMinutes
          : ((poi_id === saved.id ? savedMinutes : null) ?? outboundMinutes),
      fetched_at: new Date(clock).toISOString(),
      ...(placeFacts ? { facts: placeFacts } : {}),
    };
  },
  async walkToFixed({ candidate, fixed }) {
    mapCalls.push(`onward:${candidate.destination.id}:${fixed.name}`);
    return {
      origin: candidate.destination,
      destination: { id: fixed.arrangement_id, name: fixed.name, address: fixed.address },
      distance_m: 1200,
      travel_min: candidate.destination.id === far.id ? farOnwardMinutes : 15,
      fetched_at: new Date(clock).toISOString(),
    };
  },
};
async function listen(radarModel: RadarModel | null = null) {
  server = createApp({
    dataDir: directory,
    cookieSecret: secret,
    map,
    radarModel,
    now: () => clock,
  });
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
  savedMinutes = null;
  blockedRoute = null;
  farMinutes = 85;
  farOnwardMinutes = 15;
  facts = new Map();
  distance = new Map();
  mapCalls.length = 0;
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
function feedbackRequest(cookie: string, view: RadarView, method: 'GET' | 'DELETE') {
  return fetch(`${url}${pathOf(view)}/feedback`, { headers: { cookie }, method });
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
  it('merges saved and nearby places and only confirms screened candidates', async () => {
    const cookie = await guest();
    const search = await post('/imports/search', { query: saved.name }, cookie);
    expect(search.status).toBe(201);
    const review: unknown = await search.json();
    if (!importReviewValidator.check(review)) throw new Error('Invalid import review');
    expect(
      (
        await post(
          `/imports/${review.import_id}/confirm`,
          {
            provider: 'amap',
            poi_id: saved.id,
            revision: review.revision,
          },
          cookie,
        )
      ).status,
    ).toBe(200);

    const response = await post(
      '/radar/sessions',
      { origin_id: origin.id, available_min: 45 },
      cookie,
    );
    expect(response.status).toBe(201);
    const view: unknown = await response.json();
    if (!radarViewValidator.check(view) || view.outcome.kind !== 'recommendations')
      throw new Error('Expected recommendations');
    expect(
      [view.outcome.best, ...view.outcome.alternatives].map(({ choice }) => choice.poi_id),
    ).toEqual([saved.id, destination.id]);
    expect(view).toMatchObject({
      candidates: [
        { place: saved, sources: ['wishlist', 'nearby'] },
        { place: destination, sources: ['nearby'] },
      ],
    });
    const confirm = (poi_id: string) =>
      post(
        `${pathOf(view)}/accept`,
        {
          binding: view.outcome.binding,
          poi_id,
        },
        cookie,
        `accept-${poi_id}`,
      );
    await expectFault(await confirm(far.id), 404, 'NOT_FOUND');
    await expectFault(await confirm('outside-the-pool'), 404, 'NOT_FOUND');
    expect(await trip(cookie)).toBeNull();
    const accepted = await confirm(destination.id);
    expect(accepted.status).toBe(200);
    expect(await trip(cookie)).toMatchObject({ stops: [{ poi_id: destination.id }] });
    const recovered = await fetch(`${url}${pathOf(view)}/acceptance`, { headers: { cookie } });
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toMatchObject({
      status: 'added',
      receipt: await accepted.json(),
      destination,
    });
  });
  it('reranks too far within the original fixed window and persists only this session', async () => {
    const cookie = await guest();
    const planned: unknown = await (
      await post(
        '/trips',
        {
          destination: '苏州',
          date: '2026-11-18',
          time_zone: 'Asia/Shanghai',
          start: '09:00',
          end: '20:00',
        },
        cookie,
      )
    ).json();
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
    const review: unknown = await (
      await post('/imports/search', { query: saved.name }, cookie)
    ).json();
    if (!importReviewValidator.check(review)) throw new Error('Invalid import review');
    expect(
      (
        await post(
          `/imports/${review.import_id}/confirm`,
          {
            provider: 'amap',
            poi_id: saved.id,
            revision: review.revision,
          },
          cookie,
        )
      ).status,
    ).toBe(200);
    savedMinutes = 10;
    outboundMinutes = 8;
    farMinutes = 5;
    farOnwardMinutes = 25; // A shorter outbound leg alone is not enough.
    const input = { origin_id: origin.id, available_min: 90 };
    const initial: unknown = await (await post('/radar/sessions', input, cookie)).json();
    if (!radarViewValidator.check(initial)) throw new Error('Invalid radar view');
    expect(initial.outcome).toMatchObject({
      kind: 'recommendations',
      best: { choice: { poi_id: saved.id } },
    });
    const reject = (view: RadarView, poi_id: string) =>
      post(
        `${pathOf(view)}/reject`,
        {
          binding: view.outcome.binding,
          poi_id,
          reason: 'too_far',
        },
        cookie,
      );
    failMap = true; // Fresh evidence must be sufficient even if the provider is down.
    const simultaneous = await Promise.all([reject(initial, saved.id), reject(initial, saved.id)]);
    const result = simultaneous.find((response) => response.status === 200);
    const conflict = simultaneous.find((response) => response.status === 409);
    expect(simultaneous.map(({ status }) => status).sort()).toEqual([200, 409]);
    if (!result || !conflict) throw new Error('Expected one successful revision');
    await expectFault(conflict, 409, 'PROPOSAL_STALE');
    const view: unknown = await result.json();
    if (!radarViewValidator.check(view)) throw new Error('Invalid reranked view');
    expect(view).toMatchObject({
      available_min: 75,
      window: { fixed: initial.window?.fixed, manual_min: 90, remaining_min: 2 },
      outcome: {
        kind: 'recommendations',
        best: { choice: { poi_id: destination.id }, travel_to_min: 8, travel_to_next_min: 15 },
        alternatives: [],
      },
      feedback: { reason: 'too_far', place: saved },
    });
    expect(pathOf(view)).toBe(pathOf(initial));
    expect(view.outcome.binding.eta_revision).toBe(initial.outcome.binding.eta_revision);
    await expectFault(await reject(initial, saved.id), 409, 'PROPOSAL_STALE');
    await expectFault(await accept(cookie, initial, 'before-feedback'), 409, 'PROPOSAL_STALE');
    expect(
      await fetch(url + pathOf(view), { headers: { cookie: await guest() } }).then((r) => r.status),
    ).toBe(404);
    await close();
    await listen();
    expect(await fetch(url + pathOf(view), { headers: { cookie } }).then((r) => r.json())).toEqual(
      view,
    );
    const empty = await reject(view, destination.id);
    expect(empty.status).toBe(200);
    expect(await empty.json()).toMatchObject({
      outcome: { kind: 'empty' },
      window: { fixed: initial.window?.fixed, manual_min: 90 },
    });
    failMap = false;
    const separate = await post('/radar/sessions', input, cookie);
    expect(separate.status).toBe(201);
    const independent: unknown = await separate.json();
    expect(independent).toMatchObject({
      outcome: { kind: 'recommendations', best: { choice: { poi_id: saved.id } } },
    });
    expect(independent).not.toHaveProperty('feedback');
    failMap = true;
    const before = await feedbackRequest(cookie, view, 'GET');
    expect(before.status).toBe(200);
    expect(await before.json()).toMatchObject({ kind: 'active' });
    const stranger = await guest();
    expect(await (await feedbackRequest(stranger, view, 'DELETE')).json()).toEqual({
      kind: 'none',
    });
    const cleared = await feedbackRequest(cookie, view, 'DELETE');
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toEqual({ kind: 'restored' });
    expect(await (await feedbackRequest(cookie, view, 'GET')).json()).toEqual({ kind: 'none' });
    expect(await (await feedbackRequest(cookie, view, 'DELETE')).json()).toEqual({ kind: 'none' });
    const reset: unknown = await (await fetch(url + pathOf(view), { headers: { cookie } })).json();
    if (!radarViewValidator.check(reset)) throw new Error('Expected a fresh reset');
    expect(reset).toMatchObject({ destination: saved, window: { fixed: initial.window?.fixed } });
    expect(reset?.feedback).toBeUndefined();
    expect(await fetch(url + pathOf(view), { headers: { cookie } }).then((r) => r.json())).toEqual(
      reset,
    );
    expect(
      await fetch(`${url}/radar/history`, { headers: { cookie } }).then((r) => r.json()),
    ).toEqual({ status: 'saved', view: independent });
    expect(await trip(cookie)).toMatchObject({ stops: [] });
    clock += 75 * 60_000;
    const mapReadsBeforeLock = mapCalls.length;
    await expectFault(await reject(reset, saved.id), 409, 'PROPOSAL_STALE');
    await expectFault(
      await post(`${pathOf(reset)}/recheck`, { binding: reset.outcome.binding }, cookie),
      409,
      'PROPOSAL_STALE',
    );
    expect(mapCalls).toHaveLength(mapReadsBeforeLock);
  });

  it('reprioritizes categories and estimated prices while keeping unknown prices eligible', async () => {
    const cookie = await guest();
    farMinutes = 12;
    savedMinutes = 11;
    facts.set(destination.id, { category: '08', price: { text: '100.0', status: 'estimated' } });
    facts.set(saved.id, { category: '08' });
    facts.set(far.id, { category: '05', price: { text: '40', status: 'estimated' } });
    const input = { origin_id: origin.id, available_min: 75 };
    async function change(reason: 'not_interested' | 'too_expensive', budget?: number) {
      const initial: unknown = await (await post('/radar/sessions', input, cookie)).json();
      if (!radarViewValidator.check(initial)) throw new Error('Invalid radar view');
      expect(initial.destination).toEqual(destination);
      const result = await post(
        `${pathOf(initial)}/reject`,
        {
          binding: initial.outcome.binding,
          poi_id: destination.id,
          reason,
          ...(budget === undefined ? {} : { budget_yuan: budget }),
        },
        cookie,
      );
      expect(result.status).toBe(200);
      const view: unknown = await result.json();
      if (!radarViewValidator.check(view)) throw new Error('Invalid reranked view');
      return view;
    }
    const interest = await change('not_interested');
    expect(interest.candidates?.map(({ place }) => place.id)).toEqual([far.id, saved.id]);
    const cheaper = await change('too_expensive');
    expect(cheaper.candidates?.map(({ place }) => place.id)).toEqual([far.id, saved.id]);
    const onBudget = await change('too_expensive', 30);
    expect(onBudget.candidates).toMatchObject([{ place: saved, facts: {} }]);
    expect(onBudget.candidates?.[0]?.facts.price).toBeUndefined();
    expect(await trip(cookie)).toBeNull();
  });

  it('rechecks shorter-walking routes and blocks stale evidence without losing the feedback', async () => {
    const cookie = await guest();
    savedMinutes = 11;
    farMinutes = 12;
    const initial: unknown = await (
      await post('/radar/sessions', { origin_id: origin.id, available_min: 30 }, cookie)
    ).json();
    if (!radarViewValidator.check(initial)) throw new Error('Invalid radar view');
    expect(initial.candidates?.map(({ place }) => place.id)).toEqual([destination.id]);
    // This route is now viable, but only a fresh lookup can know it.
    savedMinutes = 4;
    farMinutes = 5;
    distance.set(far.id, 1600);
    const reads = mapCalls.length;
    const rejection = await post(
      `${pathOf(initial)}/reject`,
      {
        binding: initial.outcome.binding,
        poi_id: destination.id,
        reason: 'less_walking',
      },
      cookie,
    );
    expect(rejection.status).toBe(200);
    const next: unknown = await rejection.json();
    if (!radarViewValidator.check(next)) throw new Error('Invalid reranked view');
    expect(mapCalls.slice(reads)).toContain(`walk:${saved.id}`);
    expect(next).toMatchObject({
      candidates: [{ place: saved }],
      feedback: { reason: 'less_walking' },
    });
    expect(next.outcome.binding.eta_revision).toBe(initial.outcome.binding.eta_revision + 1);
    clock += 300_000;
    const restored = await fetch(url + pathOf(next), { headers: { cookie } });
    expect(restored.status).toBe(200);
    expect(await restored.json()).toMatchObject({
      evidence_status: 'stale',
      feedback: next.feedback,
    });
    await expectFault(
      await post(
        `${pathOf(next)}/accept`,
        {
          binding: next.outcome.binding,
          poi_id: saved.id,
        },
        cookie,
        'expired-feedback',
      ),
      409,
      'PROPOSAL_STALE',
    );
    failMap = true;
    const recheck = () =>
      post(`${pathOf(next)}/recheck`, { binding: next.outcome.binding }, cookie);
    await expectFault(await recheck(), 502, 'MAP_UNAVAILABLE');
    failMap = false;
    const reply = await recheck();
    expect(reply.status).toBe(200);
    const updated: unknown = await reply.json();
    if (!radarViewValidator.check(updated)) throw new Error('Invalid reranked view');
    expect(pathOf(updated)).toBe(pathOf(next));
    expect(updated).toMatchObject({
      feedback: next.feedback,
      // Refresh cannot add five minutes to the original deadline.
      candidates: [{ place: saved, valid_until: new Date(clock + 60_001).toISOString() }],
    });
    expect(updated.evidence_status).toBeUndefined();
    expect(await trip(cookie)).toBeNull();
    const confirmed = await post(
      `${pathOf(updated)}/accept`,
      {
        binding: updated.outcome.binding,
        poi_id: saved.id,
      },
      cookie,
      'rechecked-feedback',
    );
    expect(confirmed.status).toBe(200);
    const receipt: unknown = await confirmed.json();
    if (!acceptReceiptValidator.check(receipt)) throw new Error('Invalid receipt');
    clock += 300_000;
    failMap = true;
    const readback = await feedbackRequest(cookie, updated, 'GET');
    expect(await readback.json()).toMatchObject({ kind: 'active' });
    const cleared = await feedbackRequest(cookie, updated, 'DELETE');
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toEqual({ kind: 'invalidated' });
    expect(await (await feedbackRequest(cookie, updated, 'GET')).json()).toEqual({ kind: 'none' });
    await expectFault(
      await fetch(url + pathOf(updated), { headers: { cookie } }),
      404,
      'NOT_FOUND',
    );
    expect(
      await fetch(`${url}/radar/history`, { headers: { cookie } }).then((r) => r.json()),
    ).toBeNull();
    const acceptance = await fetch(`${url}${pathOf(updated)}/acceptance`, { headers: { cookie } });
    expect(acceptance.status).toBe(200);
    expect(await acceptance.json()).toMatchObject({ status: 'added', receipt, destination: saved });
    expect(await trip(cookie)).toMatchObject({ stops: [receipt.stop] });
  });

  it('keeps a fresh alternative confirmable after another option expires', async () => {
    const cookie = await guest();
    savedMinutes = 24;
    blockedRoute = far.id;
    const response = await post(
      '/radar/sessions',
      { origin_id: origin.id, available_min: 45 },
      cookie,
    );
    expect(response.status).toBe(201);
    const view: unknown = await response.json();
    if (!radarViewValidator.check(view)) throw new Error('Invalid radar view');
    expect(view.excluded).toEqual([{ place: far, reason: 'route_unverified' }]);
    await expectFault(
      await post(
        `${pathOf(view)}/accept`,
        { binding: view.outcome.binding, poi_id: far.id },
        cookie,
        'unverified',
      ),
      404,
      'NOT_FOUND',
    );
    clock += 60_001;
    await close();
    await listen();
    await expectFault(
      await post(
        `${pathOf(view)}/accept`,
        { binding: view.outcome.binding, poi_id: saved.id },
        cookie,
        'expired-option',
      ),
      409,
      'PROPOSAL_STALE',
    );
    expect(await trip(cookie)).toBeNull();
    expect((await accept(cookie, view, 'fresh-option')).status).toBe(200);
  });
  it('runs only the two durable radar tools and rejects out-of-pool and mixed tool proposals', async () => {
    const request = compile(
      obj(
        {
          tools: arr(obj({ function: obj({ name: str() }, { open: true }) }, { open: true })),
          messages: arr(obj({ role: str(), content: opt(nullable(str())) }, { open: true })),
        },
        { open: true },
      ),
    );
    const toolSurfaces: string[][] = [];
    const queryResults: string[] = [];
    let mode: 'valid' | 'outside' | 'mixed' | 'offline' = 'valid';
    const reason = '适合散步时顺道看看。';
    const upstream = createServer(async (incoming, response) => {
      const body: unknown = await json(incoming);
      if (!request.check(body)) {
        response.writeHead(400).end();
        return;
      }
      const names = body.tools.map((tool) => tool.function.name);
      toolSurfaces.push(names);
      if (mode === 'offline') {
        response.writeHead(502).end();
        return;
      }
      const [name] = names;
      const isQuery = name === 'candidates_query';
      const result = body.messages.find(({ role }) => role === 'tool')?.content;
      if (!isQuery && result) queryResults.push(result);
      const args = isQuery
        ? {}
        : {
            best: {
              poi_id: mode === 'outside' ? 'outside-the-pool' : destination.id,
              reason_code: 'short_detour',
              reason_text: reason,
            },
            alternatives: [{ poi_id: saved.id, reason_code: 'short_detour', reason_text: reason }],
          };
      const calls = [
        {
          index: 0,
          id: 'call-a',
          type: 'function',
          function: { name, arguments: JSON.stringify(args) },
        },
      ];
      if (mode === 'mixed' && !isQuery)
        calls.push({
          index: 1,
          id: 'call-b',
          type: 'function',
          function: { name: 'trip_write', arguments: '{}' },
        });
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(
        `data: ${JSON.stringify({ id: 'fixture', model: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: calls }, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`,
      );
    });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    try {
      const address = upstream.address();
      if (!address || typeof address === 'string') throw new Error('TCP port required');
      await close();
      await listen(
        createRadarModel({
          modelId: 'fixture',
          apiKey: 'fixture',
          baseUrl: `http://127.0.0.1:${address.port}`,
        }),
      );
      const cookie = await guest();
      const scan = async () => {
        const response = await post(
          '/radar/sessions',
          { origin_id: origin.id, available_min: 45 },
          cookie,
        );
        expect(response.status).toBe(201);
        const view: unknown = await response.json();
        if (!radarViewValidator.check(view) || view.outcome.kind !== 'recommendations')
          throw new Error('Expected recommendations');
        return view.outcome;
      };
      // Only the two nearby feasible places are visible. A query never sees the rejected route.
      expect((await scan()).best.choice).toMatchObject({
        poi_id: destination.id,
        reason_text: reason,
      });
      mode = 'outside';
      expect((await scan()).best.choice.reason_text).not.toBe(reason);
      mode = 'mixed';
      expect((await scan()).best.choice.reason_text).not.toBe(reason);
      expect(toolSurfaces).toEqual(
        Array.from({ length: 3 }, () => [['candidates_query'], ['candidates_propose']]).flat(),
      );
      expect(queryResults).toEqual(
        Array.from({ length: 3 }, () =>
          JSON.stringify([
            { poi_id: destination.id, saved: false },
            { poi_id: saved.id, saved: false },
          ]),
        ),
      );
      expect(await trip(cookie)).toBeNull();
      mode = 'offline';
      await expectFault(
        await post('/radar/sessions', { origin_id: origin.id, available_min: 45 }, cookie),
        502,
        'RADAR_MODEL_UNAVAILABLE',
      );
    } finally {
      upstream.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        upstream.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
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
    const recall = { origin_id: origin.id, available_min: 90 };
    for (const at of [start, end - 1]) {
      clock = at;
      expect(await context()).toMatchObject({
        fixed: { name: '演出' },
        in_progress: { name: '预约晚餐', ends_at: new Date(end).toISOString() },
      });
      for (const selection of [request, recall]) {
        for (const input of [selection, { ...selection, fixed_mode: 'without_fixed' }]) {
          await expectFault(await post('/radar/sessions', input, cookie), 409, 'FIXED_IN_PROGRESS');
        }
      }
      expect(mapCalls).toEqual([]);
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
    mapCalls.length = 0;
    const response = await post('/radar/sessions', recall, cookie);
    expect(response.status).toBe(201);
    const view: unknown = await response.json();
    if (!radarViewValidator.check(view)) throw new Error('Invalid radar view');
    const segments = {
      travel_to_min: 8,
      stay_min_estimate: 40,
      travel_to_next_min: 15,
      buffer_min: 10,
    };
    expect(view).toMatchObject({
      available_min: 75,
      window: { limited_by: 'fixed', fixed: { name: '演出' }, remaining_min: 2 },
      candidates: [
        { place: destination, remaining_min: 2 },
        { place: saved, remaining_min: 2 },
      ],
      outcome: { kind: 'recommendations', best: segments, alternatives: [segments] },
    });
    expect(mapCalls).toEqual([
      'origin',
      'nearby',
      `walk:${saved.id}`,
      `onward:${saved.id}:演出`,
      `walk:${destination.id}`,
      `onward:${destination.id}:演出`,
      `walk:${far.id}`,
      `onward:${far.id}:演出`,
    ]);
    const tight = await post('/radar/sessions', { ...recall, available_min: 72 }, cookie);
    expect(tight.status).toBe(201);
    expect(await tight.json()).toMatchObject({ outcome: { kind: 'empty' } });
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
    const recall = { origin_id: origin.id, available_min: 90 };
    mapCalls.length = 0;
    await expectFault(
      await post('/radar/sessions', recall, cookie),
      409,
      'FIXED_LOCATION_REQUIRED',
    );
    expect(mapCalls).toEqual([]);
    const withoutFixed = { ...recall, fixed_mode: 'without_fixed' };
    const recalled = await post('/radar/sessions', withoutFixed, cookie);
    expect(recalled.status).toBe(201);
    const recallView: unknown = await recalled.json();
    if (!radarViewValidator.check(recallView)) throw new Error('Invalid radar view');
    expect(recallView).toMatchObject({
      window: { fixed: null, limited_by: 'manual' },
      outcome: { kind: 'recommendations', best: { travel_to_next_min: null, buffer_min: 0 } },
    });
    expect(mapCalls.some((call) => call.startsWith('onward:'))).toBe(false);
    const empty = await post('/radar/sessions', { ...withoutFixed, available_min: 5 }, cookie);
    expect(empty.status).toBe(201);
    const emptyView: unknown = await empty.json();
    if (!radarViewValidator.check(emptyView)) throw new Error('Invalid radar view');
    expect(emptyView.outcome.kind).toBe('empty');
    clock += 60_000;
    await expectFault(await accept(cookie, beforeStart, 'lock-started'), 409, 'PROPOSAL_STALE');
    await expectFault(
      await accept(cookie, recallView, 'recall-lock-started'),
      409,
      'PROPOSAL_STALE',
    );
    const reopened = await fetch(`${url}${pathOf(emptyView)}`, { headers: { cookie } });
    await expectFault(reopened, 409, 'PROPOSAL_STALE');
    expect(await history(cookie)).toEqual({ status: 'stale', view: emptyView });
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

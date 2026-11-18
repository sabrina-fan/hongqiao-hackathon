import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { RadarRequest } from '@nextstop/core';
import { RadarResults } from '../runtime/documents.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openUserRuntime } from '../runtime/open-user-runtime.js';
import { RadarFault } from './evidence.js';
import type { WalkingEvidence } from './evidence.js';
import { acceptRadar, createRadar, getRadar } from './store.js';
import { getTrip } from '../trip/store.js';

type UserRuntime = Awaited<ReturnType<typeof openUserRuntime>>;
const runtimes: UserRuntime[] = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

let clock = Date.parse('2026-11-18T12:00:00.000Z');
const now = () => clock;

const origin = { id: 'origin-suzhou', name: '苏州博物馆', address: '苏州市东北街204号' };
const destination = { id: 'poi-pingjiang', name: '平江历史街区', address: '苏州市平江路' };

function makeRequest(overrides: Partial<RadarRequest> = {}): RadarRequest {
  return { origin_id: origin.id, poi_id: destination.id, available_min: 45, ...overrides };
}

function makeEvidence(overrides: Partial<WalkingEvidence> = {}): WalkingEvidence {
  return {
    origin,
    destination,
    travel_min: 12,
    distance_m: 900,
    fetched_at: new Date(clock).toISOString(),
    ...overrides,
  };
}

async function open(dataDir: string, userId = 'guest-one') {
  const runtime = await openUserRuntime({ dataDir, userId });
  runtimes.push(runtime);
  return runtime;
}

async function freshRuntime() {
  const dataDir = await mkdtemp(join(tmpdir(), 'nextstop-radar-'));
  directories.push(dataDir);
  return open(dataDir);
}

async function close(runtime: UserRuntime) {
  runtimes.splice(runtimes.indexOf(runtime), 1);
  await runtime.close();
}

async function faultCode(promise: Promise<unknown>): Promise<RadarFault['code']> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof RadarFault) return error.code;
    throw error;
  }
  throw new Error('expected RadarFault');
}

describe('雷达用例与真实 SQLite', () => {
  it('创建、展示并接受候选，行程与回执在事务内写入', async () => {
    const runtime = await freshRuntime();
    const view = await createRadar({
      runtime,
      request: makeRequest(),
      evidence: makeEvidence(),
      now,
    });
    expect(view.outcome.kind).toBe('recommendations');
    expect(view.destination.id).toBe(destination.id);
    const sessionId = view.outcome.binding.session_id;
    const shown = await getRadar({ runtime, sessionId, now });
    expect(shown).toEqual(view);
    const input = { binding: view.outcome.binding, poi_id: destination.id };
    const receipt = await acceptRadar({ runtime, sessionId, input, key: 'accept-1', now });
    expect(receipt.trip_revision).toBe(1);
    expect(receipt.stop.poi_id).toBe(destination.id);
    expect(receipt.stop.name).toBe(destination.name);
    const trip = await getTrip({ runtime });
    expect(trip?.stops).toEqual([receipt.stop]);
    expect(trip?.trip_id).toBe(receipt.trip_id);
  });

  it('重开 SQLite 后雷达会话、行程与幂等回执仍然可读', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'nextstop-radar-persist-'));
    directories.push(dataDir);
    const first = await open(dataDir);
    const view = await createRadar({
      runtime: first,
      request: makeRequest(),
      evidence: makeEvidence(),
      now,
    });
    const sessionId = view.outcome.binding.session_id;
    await close(first);
    const second = await open(dataDir);
    const restored = await getRadar({ runtime: second, sessionId, now });
    expect(restored).toEqual(view);
    const input = { binding: view.outcome.binding, poi_id: destination.id };
    const receipt = await acceptRadar({
      runtime: second,
      sessionId,
      input,
      key: 'persist-key',
      now,
    });
    await close(second);
    const third = await open(dataDir);
    expect(await getTrip({ runtime: third })).toMatchObject({
      trip_id: receipt.trip_id,
      revision: 1,
    });
    const replay = await acceptRadar({
      runtime: third,
      sessionId,
      input,
      key: 'persist-key',
      now,
    });
    expect(replay).toEqual(receipt);
  });

  it('可行集为空返回 empty 视图；非法或过期证据报错而不是空态', async () => {
    const runtime = await freshRuntime();
    const far = await createRadar({
      runtime,
      request: makeRequest(),
      evidence: makeEvidence({ distance_m: 6000 }),
      now,
    });
    expect(far.outcome.kind).toBe('empty');
    const farSession = far.outcome.binding.session_id;
    const shown = await getRadar({ runtime, sessionId: farSession, now });
    expect(shown.outcome.kind).toBe('empty');
    const tight = await createRadar({
      runtime,
      request: makeRequest({ available_min: 30 }),
      evidence: makeEvidence(),
      now,
    });
    expect(tight.outcome.kind).toBe('empty');
    await expect(
      createRadar({
        runtime,
        request: makeRequest(),
        evidence: makeEvidence({ fetched_at: new Date(clock - 6 * 60 * 1000).toISOString() }),
        now,
      }),
    ).rejects.toThrowError(RadarFault);
    await expect(
      createRadar({
        runtime,
        request: makeRequest(),
        evidence: makeEvidence({ fetched_at: new Date(clock + 60 * 1000).toISOString() }),
        now,
      }),
    ).rejects.toThrow('Invalid walking evidence');
    await expect(
      createRadar({
        runtime,
        request: makeRequest(),
        evidence: makeEvidence({ travel_min: -1 }),
        now,
      }),
    ).rejects.toThrow('Invalid walking evidence');
    await expect(
      createRadar({
        runtime,
        request: makeRequest({ poi_id: 'poi-other' }),
        evidence: makeEvidence(),
        now,
      }),
    ).rejects.toThrow('Walking evidence does not match the requested candidate');
    expect(
      await faultCode(
        acceptRadar({
          runtime,
          sessionId: farSession,
          input: { binding: far.outcome.binding, poi_id: destination.id },
          key: 'empty-accept',
          now,
        }),
      ),
    ).toBe('NO_FEASIBLE_OPTION');
  });

  it('展示与接受在证据过期或剩余窗口耗尽时报陈旧', async () => {
    const runtime = await freshRuntime();
    const view = await createRadar({
      runtime,
      request: makeRequest(),
      evidence: makeEvidence(),
      now,
    });
    const sessionId = view.outcome.binding.session_id;
    const input = { binding: view.outcome.binding, poi_id: destination.id };
    clock += 5 * 60 * 1000 + 1;
    expect(await faultCode(getRadar({ runtime, sessionId, now }))).toBe('PROPOSAL_STALE');
    expect(
      await faultCode(acceptRadar({ runtime, sessionId, input, key: 'stale-accept', now })),
    ).toBe('PROPOSAL_STALE');
    clock = Date.parse('2026-11-18T12:00:00.000Z');
    const tight = await createRadar({
      runtime,
      request: makeRequest({ available_min: 42 }),
      evidence: makeEvidence({ travel_min: 12 }),
      now,
    });
    expect(tight.outcome.kind).toBe('recommendations');
    clock += 3 * 60 * 1000;
    expect(
      await faultCode(getRadar({ runtime, sessionId: tight.outcome.binding.session_id, now })),
    ).toBe('PROPOSAL_STALE');
  });

  it('拒绝错误版本的绑定、非本池候选与未知会话', async () => {
    const runtime = await freshRuntime();
    const view = await createRadar({
      runtime,
      request: makeRequest(),
      evidence: makeEvidence(),
      now,
    });
    const sessionId = view.outcome.binding.session_id;
    const binding = view.outcome.binding;
    expect(
      await faultCode(
        acceptRadar({
          runtime,
          sessionId,
          input: { binding: { ...binding, proposal_revision: 2 }, poi_id: destination.id },
          key: 'bad-rev',
          now,
        }),
      ),
    ).toBe('PROPOSAL_STALE');
    const other = await createRadar({
      runtime,
      request: makeRequest(),
      evidence: makeEvidence(),
      now,
    });
    expect(
      await faultCode(
        acceptRadar({
          runtime,
          sessionId,
          input: { binding: other.outcome.binding, poi_id: destination.id },
          key: 'bad-session',
          now,
        }),
      ),
    ).toBe('PROPOSAL_UNVALIDATED');
    expect(
      await faultCode(
        acceptRadar({
          runtime,
          sessionId,
          input: { binding, poi_id: 'poi-absent' },
          key: 'bad-poi',
          now,
        }),
      ),
    ).toBe('NOT_FOUND');
    expect(
      await faultCode(
        acceptRadar({
          runtime,
          sessionId: 'radar-missing',
          input: { binding, poi_id: destination.id },
          key: 'bad-missing',
          now,
        }),
      ),
    ).toBe('PROPOSAL_UNVALIDATED');
    expect(await faultCode(getRadar({ runtime, sessionId: 'radar-missing', now }))).toBe(
      'NOT_FOUND',
    );
    expect(await getTrip({ runtime })).toBeNull();
  });

  it.each(['proposal_revision', 'pool_revision', 'eta_revision'] as const)(
    '拒绝服务端快照中已变更的 %s',
    async (field) => {
      const runtime = await freshRuntime();
      const view = await createRadar({
        runtime,
        request: makeRequest(),
        evidence: makeEvidence(),
        now,
      });
      const { binding } = view.outcome;
      const sessionId = binding.session_id;
      await runtime.conversation.commit(async (tx) => {
        const record = await tx.doc(RadarResults, runtime.conversation.id, sessionId, sessionId);
        if (!record.session) throw new Error('Expected a saved snapshot');
        record.session[field] += 1;
      }, BACKGROUND_CONTEXT);
      expect(await faultCode(getRadar({ runtime, sessionId, now }))).toBe('PROPOSAL_STALE');
      expect(
        await faultCode(
          acceptRadar({
            runtime,
            sessionId,
            key: field,
            input: { binding, poi_id: destination.id },
            now,
          }),
        ),
      ).toBe('PROPOSAL_STALE');
      expect(await getTrip({ runtime })).toBeNull();
    },
  );

  it('计入地图请求耗时，并在不足一分钟的余量耗尽时拒绝写入', async () => {
    const runtime = await freshRuntime();
    const request = makeRequest({ available_min: 43 });
    const evidence = makeEvidence();
    const view = await createRadar({ runtime, request, evidence, now, startedAt: clock - 55_000 });
    expect(view.outcome.kind).toBe('recommendations');
    expect(Date.parse(view.valid_until)).toBe(clock + 5000);
    const { binding } = view.outcome;
    expect(
      await faultCode(
        acceptRadar({
          runtime,
          sessionId: binding.session_id,
          key: 'late',
          input: { binding, poi_id: destination.id },
          now: () => clock + 5001,
        }),
      ),
    ).toBe('PROPOSAL_STALE');
    expect(await getTrip({ runtime })).toBeNull();
  });

  it('同键重放同一回执、异参拒绝，重复确认只新增一次', async () => {
    const runtime = await freshRuntime();
    const view = await createRadar({
      runtime,
      request: makeRequest(),
      evidence: makeEvidence(),
      now,
    });
    const sessionId = view.outcome.binding.session_id;
    const input = { binding: view.outcome.binding, poi_id: destination.id };
    const receipt = await acceptRadar({ runtime, sessionId, input, key: 'dup-key', now });
    const replay = await acceptRadar({ runtime, sessionId, input, key: 'dup-key', now });
    expect(replay).toEqual(receipt);
    expect(
      await faultCode(
        acceptRadar({
          runtime,
          sessionId,
          input: { binding: input.binding, poi_id: 'poi-variant' },
          key: 'dup-key',
          now,
        }),
      ),
    ).toBe('IDEMPOTENCY_CONFLICT');
    expect(
      await faultCode(acceptRadar({ runtime, sessionId, input, key: 'another-key', now })),
    ).toBe('PROPOSAL_STALE');
    const trip = await getTrip({ runtime });
    expect(trip?.stops).toHaveLength(1);
    expect(await faultCode(getRadar({ runtime, sessionId, now }))).toBe('PROPOSAL_STALE');
  });
});

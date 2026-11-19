import { expect, it } from 'vitest';
import type { RadarMap } from '../radar/amap.js';
import { MapFault } from '../radar/amap.js';
import { draftWalking } from './draft-walking.js';

const startedAt = Date.parse('2026-11-18T01:00:00Z');
const place = { poi_id: 'p1', name: '甲园', address: '苏州市姑苏区甲路1号' };
const anchor = {
  name: '预约晚餐',
  address: '苏州市姑苏区甲路5号',
  start: '17:30',
  end: '18:30',
};

const evidence = (minutes: number) => ({
  origin: { id: 'a', name: 'a', address: '' },
  destination: { id: 'b', name: 'b', address: '' },
  travel_min: minutes,
  distance_m: minutes * 80,
  fetched_at: new Date(startedAt).toISOString(),
});

function mapOf(overrides: Partial<RadarMap>): RadarMap {
  return {
    async search() {
      throw new Error('Fixed addresses must not be resolved by text search');
    },
    async walk() {
      throw new Error('A fixed address needs address routing');
    },
    async walkToFixed() {
      throw new Error('Draft does not use radar fixed-stop routing');
    },
    ...overrides,
  };
}

it('routes to and from a fixed address through geocoding instead of text search', async () => {
  const calls: unknown[] = [];
  const map = mapOf({
    async walkToAddress(input) {
      calls.push(['to', input]);
      return evidence(6);
    },
    async walkFromAddress(input) {
      calls.push(['from', input]);
      return evidence(7);
    },
  });
  const walking = draftWalking(map, startedAt);
  await expect(walking.walk(place, anchor)).resolves.toBe(6);
  await expect(walking.walk(anchor, place)).resolves.toBe(7);
  expect(calls).toEqual([
    ['to', { origin_id: 'p1', address: '苏州市姑苏区甲路5号' }],
    ['from', { address: '苏州市姑苏区甲路5号', poi_id: 'p1' }],
  ]);
});

it('keeps an unresolvable fixed address unscheduled without failing the draft', async () => {
  const map = mapOf({
    async walkToAddress() {
      throw new MapFault('FIXED_LOCATION_UNRESOLVED');
    },
    async walkFromAddress() {
      throw new MapFault('FIXED_LOCATION_UNRESOLVED');
    },
  });
  const walking = draftWalking(map, startedAt);
  await expect(walking.walk(place, anchor)).resolves.toBeNull();
  await expect(walking.walk(anchor, place)).resolves.toBeNull();
});

it('does not invent walking time when the map cannot route addresses', async () => {
  const walking = draftWalking(mapOf({}), startedAt);
  await expect(walking.walk(place, anchor)).resolves.toBeNull();
  expect(walking.expiresAt()).toBe(startedAt + 30 * 60_000);
});

it('caches address routes and stops trusting stale evidence', async () => {
  let calls = 0;
  const fetched_at = new Date(startedAt).toISOString();
  const map = mapOf({
    async walkToAddress() {
      calls += 1;
      return { ...evidence(4), fetched_at };
    },
    async walkFromAddress() {
      calls += 1;
      return { ...evidence(4), fetched_at };
    },
  });
  const walking = draftWalking(map, startedAt);
  await expect(walking.walk(place, anchor)).resolves.toBe(4);
  await expect(walking.walk(place, anchor)).resolves.toBe(4);
  expect(calls).toBe(1);
  expect(walking.expiresAt()).toBe(startedAt + 30 * 60_000);

  const later = draftWalking(
    mapOf({
      async walkToAddress() {
        return { ...evidence(4), fetched_at: new Date(startedAt - 45 * 60_000).toISOString() };
      },
    }),
    startedAt,
  );
  await expect(later.walk(place, anchor)).resolves.toBeNull();
});

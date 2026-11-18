import type { Arrangement, DraftEntry } from '@nextstop/core';
import { expect, it } from 'vitest';
import { scheduleDraft } from './draft-plan.js';

const day = {
  destination: '苏州',
  date: '2026-11-20',
  time_zone: 'Asia/Shanghai',
  start: '09:00',
  end: '10:00',
};
const anchor: Arrangement = {
  arrangement_id: 'fixed',
  poi_id: 'reservation',
  name: '固定安排',
  address: '预约地点',
  start: '09:45',
  end: '10:00',
  locked: true,
};
const candidate = {
  kind: 'unscheduled',
  reason: 'time_conflict',
  poi_id: 'visit',
  name: '收藏',
  address: '游玩地点',
} satisfies DraftEntry;

it.each([
  { minutes: 5, result: { kind: 'scheduled', start: '09:00', end: '09:40' } },
  { minutes: 6, result: { kind: 'unscheduled', reason: 'time_conflict' } },
  { minutes: null, result: { kind: 'unscheduled', reason: 'walking_unknown' } },
])(
  'uses directed walking evidence at a fixed boundary ($minutes minutes)',
  async ({ minutes, result }) => {
    const plan = await scheduleDraft({
      day,
      arrangements: [anchor],
      entries: [candidate],
      async walk(from, to) {
        expect([from.poi_id, to.poi_id]).toEqual(['visit', 'reservation']);
        return minutes;
      },
    });
    expect(plan).toMatchObject([result]);
  },
);

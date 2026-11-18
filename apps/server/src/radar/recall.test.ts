import { expect, it } from 'vitest';
import { screenRecall } from './recall.js';
import type { RecallSnapshot, VerifiedCandidate } from './recall-snapshot.js';

it('applies booking and hours before choosing up to three distinct experiences', () => {
  const at = Date.UTC(2026, 10, 18, 8);
  const scanned_at = new Date(at).toISOString();
  const origin = { id: 'origin', name: '出发地', address: '' };
  function route(
    id: string,
    travel_min: number,
    facts: VerifiedCandidate['outbound']['facts'],
  ): VerifiedCandidate {
    return {
      sources: ['nearby'],
      onward: null,
      outbound: {
        origin,
        destination: { id, name: id, address: '' },
        travel_min,
        distance_m: 400,
        fetched_at: scanned_at,
        ...(facts ? { facts } : {}),
      },
    };
  }
  const snapshot: RecallSnapshot = {
    origin,
    started_ms: at,
    scanned_at,
    manual_min: 75,
    fixed: null,
    excluded: [],
    verified: [
      route('booked', 1, {
        booking: { state: 'required', source: '场馆公告', status: 'verified' },
      }),
      route('closed', 1, { opening: { today: '09:00-15:00', status: 'verified' } }),
      route('a', 4, { category: '05' }),
      route('b', 5, { category: '05' }),
      route('c', 6, { category: '05' }),
      route('d', 7, { category: '11' }),
    ],
  };
  const screened = screenRecall(snapshot, at);
  expect(screened.excluded.map(({ place, reason }) => [place.id, reason])).toEqual([
    ['booked', 'booking_required'],
    ['closed', 'closed'],
  ]);
  expect(screened.feasible.map(({ candidate }) => candidate.place.id)).toEqual(['a', 'b', 'd']);
  expect(screened.eligible.map(({ candidate }) => candidate.place.id)).toEqual([
    'a',
    'b',
    'c',
    'd',
  ]);
});

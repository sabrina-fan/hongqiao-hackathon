import { describe, expect, it } from 'vitest';
import { radarWindow } from './radar-window.js';

const start = Date.UTC(2026, 10, 18, 8);
const min = 60_000;

describe('radar deadlines', () => {
  it.each([
    { manual: 90, fixed: 75 * min, available: 75, limit: 'fixed' },
    { manual: 72, fixed: 75 * min, available: 72, limit: 'manual' },
    { manual: 75, fixed: 75 * min, available: 75, limit: 'both' },
    { manual: 75, fixed: 75 * min - 1, available: 74, limit: 'fixed' },
    { manual: 75, fixed: -1, available: 0, limit: 'fixed' },
    { manual: 75, fixed: null, available: 75, limit: 'manual' },
  ])(
    'uses the earlier deadline without rounding up ($limit, $available min)',
    ({ manual, fixed, available, limit }) => {
      expect(
        radarWindow({
          started_ms: start,
          manual_min: manual,
          fixed_ms: fixed === null ? null : start + fixed,
        }),
      ).toEqual({
        available_min: available,
        limited_by: limit,
        deadline_ms: start + Math.min(manual * min, fixed ?? Infinity),
      });
    },
  );
});

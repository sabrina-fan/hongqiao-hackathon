import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { modelProposalInputValidator, radarOutcomeValidator } from './contracts.js';
import type { ProposalBinding, RadarOutcome } from './contracts.js';
import { checkProposalBinding } from './proposal-binding.js';
import { fitsTimeWindow } from './time-window.js';

const binding: ProposalBinding = {
  session_id: 'radar-a',
  proposal_id: 'proposal-a',
  proposal_revision: 1,
  pool_revision: 1,
  eta_revision: 1,
  trip_id: 'trip-a',
  trip_revision: 1,
};
const recommendation: RadarOutcome = {
  kind: 'recommendations',
  binding,
  best: {
    choice: { poi_id: 'poi-a', reason_code: 'short_detour', reason_text: '绕路较少' },
    travel_to_min: 5,
    travel_to_next_min: 10,
    stay_min_estimate: 20,
    buffer_min: 10,
    evidence: { provider: 'amap', fetched_at: '2026-11-17T08:00:00Z', status: 'estimated' },
  },
  alternatives: [],
};

describe('radar contracts and binding', () => {
  it('represents zero feasible candidates without creating a best pick', () => {
    const empty = { kind: 'empty', binding, reason_code: 'NO_FEASIBLE_OPTION' };
    expect(radarOutcomeValidator.check(empty)).toBe(true);
    expect(radarOutcomeValidator.check({ ...empty, best: recommendation.best })).toBe(false);
    expect(
      radarOutcomeValidator.check({ kind: 'recommendations', binding, alternatives: [] }),
    ).toBe(false);
    expect(
      radarOutcomeValidator.check({
        ...empty,
        binding: { ...binding, trip_id: null, trip_revision: 0 },
      }),
    ).toBe(true);
    expect(radarOutcomeValidator.check({ ...empty, binding: { ...binding, trip_id: null } })).toBe(
      false,
    );
  });
  it('checks validation and freshness before treating an empty outcome as current', () => {
    const outcome: RadarOutcome = { kind: 'empty', binding, reason_code: 'NO_FEASIBLE_OPTION' };
    expect(checkProposalBinding({ outcome, validated: binding, current: binding })).toBe(
      'NO_FEASIBLE_OPTION',
    );
    expect(checkProposalBinding({ outcome, validated: null, current: binding })).toBe(
      'PROPOSAL_UNVALIDATED',
    );
    expect(
      checkProposalBinding({
        outcome,
        validated: binding,
        current: { ...binding, pool_revision: 2 },
      }),
    ).toBe('PROPOSAL_STALE');
  });
  it('rejects model-supplied timing or validation metadata', () => {
    const input = { best: recommendation.best.choice, alternatives: [] };
    expect(modelProposalInputValidator.check(input)).toBe(true);
    expect(modelProposalInputValidator.check({ ...input, binding })).toBe(false);
    expect(
      modelProposalInputValidator.check({ ...input, best: { ...input.best, travel_to_min: 1 } }),
    ).toBe(false);
  });
  it('rejects stale proposals after any evidence or trip revision changes', () => {
    expect(
      checkProposalBinding({ outcome: recommendation, validated: binding, current: binding }),
    ).toBeNull();
    for (const current of [
      { ...binding, session_id: 'radar-b' },
      { ...binding, proposal_id: 'proposal-b' },
      { ...binding, proposal_revision: 2 },
      { ...binding, pool_revision: 2 },
      { ...binding, eta_revision: 2 },
      { ...binding, trip_id: 'trip-b' },
      { ...binding, trip_revision: 2 },
    ]) {
      expect(checkProposalBinding({ outcome: recommendation, validated: binding, current })).toBe(
        'PROPOSAL_STALE',
      );
    }
    expect(
      checkProposalBinding({ outcome: recommendation, validated: null, current: binding }),
    ).toBe('PROPOSAL_UNVALIDATED');
  });
});

describe('time window hard constraint', () => {
  it('accounts for both legs, stay time and buffer at the boundary', () => {
    const input = {
      available_min: 60,
      travel_to_min: 10,
      stay_min: 25,
      travel_after_min: 15,
      buffer_min: 10,
    };
    expect(fitsTimeWindow(input)).toBe(true);
    expect(fitsTimeWindow({ ...input, available_min: 59 })).toBe(false);
    expect(fitsTimeWindow({ ...input, travel_after_min: Number.NaN })).toBe(false);
  });
  it('never makes an infeasible trip feasible by reducing the available time', () => {
    const result = fc.check(
      fc.property(
        fc.record({
          available_min: fc.integer({ min: 0, max: 300 }),
          travel_to_min: fc.integer({ min: 0, max: 120 }),
          stay_min: fc.integer({ min: 0, max: 120 }),
          travel_after_min: fc.integer({ min: 0, max: 120 }),
          buffer_min: fc.integer({ min: 0, max: 30 }),
        }),
        fc.integer({ min: 0, max: 300 }),
        (input, reduction) =>
          fitsTimeWindow(input) ||
          !fitsTimeWindow({
            ...input,
            available_min: Math.max(0, input.available_min - reduction),
          }),
      ),
    );
    expect(result.failed).toBe(false);
  });
});

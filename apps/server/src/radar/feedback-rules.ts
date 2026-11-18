import { int, lit, obj, opt, str, union, type Static } from '@earendil-works/pi-schema';
import { PlaceOptionSchema, type RadarFeedback, type RejectRadarInput } from '@nextstop/core';
import type { VerifiedCandidate } from './recall-snapshot.js';

const target = { place: PlaceOptionSchema };
export const RejectionSchema = union([
  obj({ ...target, reason: lit('too_far'), travel_to_min: int({ minimum: 0 }) }),
  obj({
    ...target,
    reason: lit('too_expensive'),
    budget_yuan: opt(int({ minimum: 0, maximum: 100_000 })),
  }),
  obj({ ...target, reason: lit('not_interested'), category: opt(str({ pattern: '^\\d{2}$' })) }),
  obj({ ...target, reason: lit('less_walking') }),
]);
export type Rejection = Static<typeof RejectionSchema>;

export function recordRejection(input: RejectRadarInput, entry: VerifiedCandidate): Rejection {
  const { destination: place, travel_min, facts } = entry.outbound;
  switch (input.reason) {
    case 'too_far':
      return { reason: input.reason, place, travel_to_min: travel_min };
    case 'too_expensive':
      return {
        reason: input.reason,
        place,
        ...(input.budget_yuan === undefined ? {} : { budget_yuan: input.budget_yuan }),
      };
    case 'not_interested':
      return {
        reason: input.reason,
        place,
        ...(facts?.category ? { category: facts.category } : {}),
      };
    case 'less_walking':
      return { reason: input.reason, place };
  }
}

export function describeFeedback(rejection: Rejection): RadarFeedback {
  const { reason, place } = rejection;
  return reason === 'too_expensive' && rejection.budget_yuan !== undefined
    ? { reason, place, budget_yuan: rejection.budget_yuan }
    : { reason, place };
}

function priceEstimate(entry: VerifiedCandidate): number | null {
  const text = entry.outbound.facts?.price?.text.trim();
  if (!text || !/^\d{1,6}(?:\.\d{1,2})?$/.test(text)) return null;
  return Number(text);
}

const walkingDistance = ({ outbound, onward }: VerifiedCandidate) =>
  outbound.distance_m + (onward?.distance_m ?? 0);

export function feedbackRules(rejections: Rejection[]) {
  const rejected = new Set(rejections.map(({ place }) => place.id));
  let maxTravel = Infinity;
  let budget = Infinity;
  let preferCheaper = false;
  let lessWalking = false;
  const categories = new Set<string>();
  for (const rejection of rejections) {
    switch (rejection.reason) {
      case 'too_far':
        maxTravel = Math.min(maxTravel, rejection.travel_to_min);
        break;
      case 'too_expensive':
        preferCheaper = true;
        if (rejection.budget_yuan !== undefined) budget = Math.min(budget, rejection.budget_yuan);
        break;
      case 'not_interested':
        if (rejection.category) categories.add(rejection.category);
        break;
      case 'less_walking':
        lessWalking = true;
        break;
    }
  }
  function comparePrice(a: VerifiedCandidate, b: VerifiedCandidate) {
    if (!preferCheaper) return 0;
    const first = priceEstimate(a);
    const second = priceEstimate(b);
    if (first === null) return second === null ? 0 : 1;
    return second === null ? -1 : first - second;
  }
  const sameCategory = ({ outbound }: VerifiedCandidate) =>
    Number(categories.has(outbound.facts?.category ?? ''));
  return {
    rejected,
    permits(entry: VerifiedCandidate) {
      const cost = priceEstimate(entry);
      return (
        entry.outbound.travel_min < maxTravel &&
        (!lessWalking || walkingDistance(entry) <= 1500) &&
        (cost === null || cost <= budget)
      );
    },
    compare(a: VerifiedCandidate, b: VerifiedCandidate) {
      return (
        (maxTravel < Infinity ? a.outbound.travel_min - b.outbound.travel_min : 0) ||
        (lessWalking ? walkingDistance(a) - walkingDistance(b) : 0) ||
        sameCategory(a) - sameCategory(b) ||
        comparePrice(a, b)
      );
    },
  };
}

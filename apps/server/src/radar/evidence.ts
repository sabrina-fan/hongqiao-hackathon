import { PlaceOptionSchema } from '@nextstop/core';
import { int, obj, str } from '@earendil-works/pi-schema';
import type { Static } from '@earendil-works/pi-schema';

export const WalkingEvidenceSchema = obj({
  origin: PlaceOptionSchema,
  destination: PlaceOptionSchema,
  travel_min: int({ minimum: 0 }),
  distance_m: int({ minimum: 0 }),
  fetched_at: str({ format: 'date-time' }),
});
export type WalkingEvidence = Static<typeof WalkingEvidenceSchema>;

export class RadarFault extends Error {
  constructor(
    readonly code:
      | 'NOT_FOUND'
      | 'PROPOSAL_STALE'
      | 'PROPOSAL_UNVALIDATED'
      | 'NO_FEASIBLE_OPTION'
      | 'IDEMPOTENCY_CONFLICT',
  ) {
    super(code);
  }
}

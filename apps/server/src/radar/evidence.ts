import { PlaceOptionSchema, RadarPlaceFactsSchema, RoutePointSchema } from '@nextstop/core';
import { int, obj, opt, str, type Static } from '@earendil-works/pi-schema';

export const WalkingMarkersSchema = obj({
  origin: RoutePointSchema,
  destination: RoutePointSchema,
});

export const WalkingEvidenceSchema = obj({
  origin: PlaceOptionSchema,
  destination: PlaceOptionSchema,
  travel_min: int({ minimum: 0 }),
  distance_m: int({ minimum: 0 }),
  fetched_at: str({ format: 'date-time' }),
  markers: opt(WalkingMarkersSchema),
  facts: opt(RadarPlaceFactsSchema),
});
export type WalkingEvidence = Static<typeof WalkingEvidenceSchema>;

export class RadarFault extends Error {
  constructor(
    readonly code:
      | 'NOT_FOUND'
      | 'PROPOSAL_STALE'
      | 'PROPOSAL_UNVALIDATED'
      | 'NO_FEASIBLE_OPTION'
      | 'RADAR_MODEL_UNAVAILABLE'
      | 'FIXED_LOCATION_REQUIRED'
      | 'FIXED_TIME_INVALID'
      | 'IDEMPOTENCY_CONFLICT',
  ) {
    super(code);
  }
}

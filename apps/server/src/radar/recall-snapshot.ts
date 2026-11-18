import {
  arr,
  int,
  lit,
  nullable,
  obj,
  oneOf,
  opt,
  str,
  type Static,
} from '@earendil-works/pi-schema';
import { FixedStopSchema, PlaceOptionSchema, RadarExclusionSchema } from '@nextstop/core';
import { WalkingEvidenceSchema } from './evidence.js';

const SourceSchema = oneOf(['wishlist', 'nearby']);
export type Source = Static<typeof SourceSchema>;
const VerifiedCandidateSchema = obj({
  sources: arr(SourceSchema, { minItems: 1, maxItems: 2 }),
  outbound: WalkingEvidenceSchema,
  onward: nullable(WalkingEvidenceSchema),
});
export type VerifiedCandidate = Static<typeof VerifiedCandidateSchema>;
export const RecallSnapshotSchema = obj({
  origin: PlaceOptionSchema,
  manual_min: int({ minimum: 1, maximum: 720 }),
  started_ms: int({ minimum: 0 }),
  scanned_at: str({ format: 'date-time' }),
  fixed: nullable(FixedStopSchema),
  fixed_mode: opt(oneOf(['next_locked', 'without_fixed'])),
  preference: opt(lit('short_walk')),
  verified: arr(VerifiedCandidateSchema, { maxItems: 6 }),
  excluded: arr(RadarExclusionSchema, { maxItems: 6 }),
});
export type RecallSnapshot = Static<typeof RecallSnapshotSchema>;

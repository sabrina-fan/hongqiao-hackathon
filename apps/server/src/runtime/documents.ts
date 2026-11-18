import { defineDocFamily } from '@earendil-works/pi-durable';
import { arr, compile, int, nullable, obj, opt, str } from '@earendil-works/pi-schema';
import type { Static } from '@earendil-works/pi-schema';
import {
  AcceptReceiptSchema,
  BindingSchema,
  IdentifierSchema,
  PlaceOptionSchema,
  RadarOutcomeSchema,
  ArrangementSchema,
  TripDaySchema,
  tripFields,
} from '@nextstop/core';

const RadarSessionSnapshotSchema = obj({
  session_id: IdentifierSchema,
  proposal_id: IdentifierSchema,
  origin_id: IdentifierSchema,
  poi_id: IdentifierSchema,
  available_min: int({ minimum: 1, maximum: 720 }),
  origin: PlaceOptionSchema,
  destination: PlaceOptionSchema,
  travel_min: int({ minimum: 0 }),
  distance_m: int({ minimum: 0 }),
  fetched_at: str({ format: 'date-time' }),
  created_ms: int({ minimum: 0 }),
  valid_until: str({ format: 'date-time' }),
  proposal_revision: int({ minimum: 1 }),
  pool_revision: int({ minimum: 1 }),
  eta_revision: int({ minimum: 1 }),
});
export type RadarSessionSnapshot = Static<typeof RadarSessionSnapshotSchema>;

export const RadarRecordSchema = obj({
  outcome: nullable(RadarOutcomeSchema),
  validated: nullable(BindingSchema),
  session: opt(nullable(RadarSessionSnapshotSchema)),
});
export type RadarRecord = Static<typeof RadarRecordSchema>;

export const RadarResults = defineDocFamily<RadarRecord, string>({
  kind: 'nextstop.radar_result',
  version: 1,
  family: true,
  scope: 'conversation',
  history: 'rewindable',
  fork: 'current',
  initial: () => ({ outcome: null, validated: null, session: null }),
  checkpointWhen: () => true,
});

const TripStateSchema = obj({
  trip: nullable(
    obj({
      ...tripFields,
      day: opt(TripDaySchema),
      arrangements: opt(arr(ArrangementSchema)),
    }),
  ),
});
export const tripStateValidator = compile(TripStateSchema);
export type TripState = Static<typeof TripStateSchema>;

export const Trips = defineDocFamily<TripState, string>({
  kind: 'nextstop.trip',
  version: 1,
  family: true,
  scope: 'conversation',
  history: 'rewindable',
  fork: 'current',
  initial: () => ({ trip: null }),
  checkpointWhen: () => true,
});

const TripDirectorySchema = obj({ keys: arr(IdentifierSchema) });
export const tripDirectoryValidator = compile(TripDirectorySchema);
export const TripDirectory = defineDocFamily<Static<typeof TripDirectorySchema>, string>({
  kind: 'nextstop.trip_directory',
  version: 1,
  family: true,
  scope: 'conversation',
  history: 'rewindable',
  fork: 'current',
  initial: () => ({ keys: [] }),
  checkpointWhen: () => true,
});

export const AcceptRecordSchema = obj({
  entry: nullable(
    obj({ fingerprint: str({ minLength: 1, maxLength: 500 }), receipt: AcceptReceiptSchema }),
  ),
});
export type AcceptRecord = Static<typeof AcceptRecordSchema>;

export const AcceptReceipts = defineDocFamily<AcceptRecord, string>({
  kind: 'nextstop.accept_receipt',
  version: 1,
  family: true,
  scope: 'conversation',
  history: 'rewindable',
  fork: 'current',
  initial: () => ({ entry: null }),
  checkpointWhen: () => true,
});

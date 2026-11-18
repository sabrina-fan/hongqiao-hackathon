import {
  arr,
  compile,
  int,
  lit,
  nullable,
  num,
  obj,
  oneOf,
  opt,
  str,
  union,
} from '@earendil-works/pi-schema';
import type { Static } from '@earendil-works/pi-schema';
import {
  BindingSchema,
  IdentifierSchema,
  RadarOutcomeSchema,
  RevisionSchema,
} from './contracts.js';

export const PlaceOptionSchema = obj({
  id: IdentifierSchema,
  name: str({ minLength: 1, maxLength: 200 }),
  address: str({ maxLength: 500 }),
});
export type PlaceOption = Static<typeof PlaceOptionSchema>;
export const placeSearchValidator = compile(
  obj({ places: arr(PlaceOptionSchema, { maxItems: 10 }) }),
);

const AvailableMinutes = int({ minimum: 1, maximum: 720 });
const CoordinateFields = {
  longitude: num({ minimum: -180, maximum: 180 }),
  latitude: num({ minimum: -90, maximum: 90 }),
};
const BrowserPositionSchema = obj({
  system: lit('wgs84'),
  ...CoordinateFields,
  accuracy_m: num({ minimum: 0, maximum: 100 }),
});
export const browserPositionValidator = compile(BrowserPositionSchema);
export type BrowserPosition = Static<typeof BrowserPositionSchema>;
export const RoutePointSchema = obj({ system: lit('gcj02'), ...CoordinateFields });
export type RoutePoint = Static<typeof RoutePointSchema>;

const candidateFields = {
  poi_id: opt(IdentifierSchema),
  available_min: AvailableMinutes,
  fixed_mode: opt(oneOf(['next_locked', 'without_fixed'])),
  preference: opt(lit('short_walk')),
};
const RadarRequestSchema = union([
  obj({ ...candidateFields, origin_id: IdentifierSchema }),
  obj({ ...candidateFields, position: BrowserPositionSchema }),
]);
export const radarRequestValidator = compile(RadarRequestSchema);
export type RadarRequest = Static<typeof RadarRequestSchema>;
export const liveOriginId = 'browser-position';

export const FixedStopSchema = obj({
  arrangement_id: IdentifierSchema,
  name: str({ minLength: 1, maxLength: 100 }),
  address: str({ maxLength: 500 }),
  starts_at: str({ format: 'date-time' }),
  time_zone: str({ minLength: 1, maxLength: 100 }),
});
export type FixedStop = Static<typeof FixedStopSchema>;
export const radarContextValidator = compile(obj({ fixed: nullable(FixedStopSchema) }));

export const RadarMarkersSchema = obj({
  origin: RoutePointSchema,
  destination: RoutePointSchema,
  next: opt(RoutePointSchema),
});
export const RadarPlaceFactsSchema = obj({
  category: opt(str({ pattern: '^\\d{2}$' })),
  opening: opt(obj({ today: str({ minLength: 1, maxLength: 200 }), status: lit('verified') })),
  price: opt(obj({ text: str({ minLength: 1, maxLength: 80 }), status: lit('estimated') })),
  booking: opt(
    obj({
      state: oneOf(['required', 'not_required']),
      source: str({ minLength: 1, maxLength: 200 }),
      status: oneOf(['verified', 'stale']),
    }),
  ),
});
export const RadarCandidateSchema = obj({
  place: PlaceOptionSchema,
  sources: arr(oneOf(['wishlist', 'nearby']), { minItems: 1, maxItems: 2 }),
  markers: opt(RadarMarkersSchema),
  facts: RadarPlaceFactsSchema,
  remaining_min: int({ minimum: 0 }),
  valid_until: str({ format: 'date-time' }),
});
export type RadarCandidate = Static<typeof RadarCandidateSchema>;
export const RadarExclusionSchema = obj({
  place: PlaceOptionSchema,
  reason: oneOf(['time_or_distance', 'route_unverified', 'booking_required', 'closed']),
});
export type RadarExclusion = Static<typeof RadarExclusionSchema>;

const RadarViewSchema = obj({
  outcome: RadarOutcomeSchema,
  origin: PlaceOptionSchema,
  available_min: int({ minimum: 0, maximum: 720 }),
  destination: PlaceOptionSchema,
  valid_until: str({ format: 'date-time' }),
  window: opt(
    obj({
      fixed: nullable(FixedStopSchema),
      manual_min: AvailableMinutes,
      limited_by: oneOf(['manual', 'fixed', 'both']),
      remaining_min: nullable(int({ minimum: 0 })),
    }),
  ),
  markers: opt(RadarMarkersSchema),
  facts: opt(RadarPlaceFactsSchema),
  candidates: opt(arr(RadarCandidateSchema, { maxItems: 3 })),
  excluded: opt(arr(RadarExclusionSchema, { maxItems: 6 })),
});
export type RadarView = Static<typeof RadarViewSchema>;
export const radarViewValidator = compile(RadarViewSchema);
export const radarHistoryValidator = compile(
  nullable(
    obj({
      status: oneOf(['saved', 'stale']),
      view: RadarViewSchema,
    }),
  ),
);

const AcceptRadarSchema = obj({ binding: BindingSchema, poi_id: IdentifierSchema });
export type AcceptRadarInput = Static<typeof AcceptRadarSchema>;
export const acceptRadarValidator = compile(AcceptRadarSchema);

export const TripStopSchema = obj({
  stop_id: IdentifierSchema,
  poi_id: IdentifierSchema,
  name: str({ minLength: 1, maxLength: 200 }),
});
export const tripFields = {
  trip_id: IdentifierSchema,
  revision: RevisionSchema,
  stops: arr(TripStopSchema),
};
export const TripViewSchema = obj(tripFields);
export type TripView = Static<typeof TripViewSchema>;
export const tripViewValidator = compile(TripViewSchema);

export const AcceptReceiptSchema = obj({
  trip_id: IdentifierSchema,
  trip_revision: RevisionSchema,
  stop: TripStopSchema,
});
export type AcceptReceipt = Static<typeof AcceptReceiptSchema>;
export const acceptReceiptValidator = compile(AcceptReceiptSchema);

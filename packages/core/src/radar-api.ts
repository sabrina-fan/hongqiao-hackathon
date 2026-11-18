import { arr, compile, int, obj, str } from '@earendil-works/pi-schema';
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
const RadarRequestSchema = obj({
  origin_id: IdentifierSchema,
  poi_id: IdentifierSchema,
  available_min: AvailableMinutes,
});
export const radarRequestValidator = compile(RadarRequestSchema);
export type RadarRequest = Static<typeof RadarRequestSchema>;

const RadarViewSchema = obj({
  outcome: RadarOutcomeSchema,
  origin: PlaceOptionSchema,
  available_min: AvailableMinutes,
  destination: PlaceOptionSchema,
  valid_until: str({ format: 'date-time' }),
});
export type RadarView = Static<typeof RadarViewSchema>;
export const radarViewValidator = compile(RadarViewSchema);

const AcceptRadarSchema = obj({ binding: BindingSchema, poi_id: IdentifierSchema });
export type AcceptRadarInput = Static<typeof AcceptRadarSchema>;
export const acceptRadarValidator = compile(AcceptRadarSchema);

export const TripStopSchema = obj({
  stop_id: IdentifierSchema,
  poi_id: IdentifierSchema,
  name: str({ minLength: 1, maxLength: 200 }),
});
export const TripViewSchema = obj({
  trip_id: IdentifierSchema,
  revision: RevisionSchema,
  stops: arr(TripStopSchema),
});
export type TripView = Static<typeof TripViewSchema>;
export const tripViewValidator = compile(TripViewSchema);

export const AcceptReceiptSchema = obj({
  trip_id: IdentifierSchema,
  trip_revision: RevisionSchema,
  stop: TripStopSchema,
});
export type AcceptReceipt = Static<typeof AcceptReceiptSchema>;
export const acceptReceiptValidator = compile(AcceptReceiptSchema);

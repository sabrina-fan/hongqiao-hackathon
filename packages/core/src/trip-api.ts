import {
  arr,
  bool,
  compile,
  lit,
  nullable,
  obj,
  str,
  union,
  type Static,
} from '@earendil-works/pi-schema';
import { IdentifierSchema, RevisionSchema } from './contracts.js';
import { tripFields } from './radar-api.js';

const Time = str({ pattern: '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$' });
export const TripDaySchema = obj({
  destination: str({ minLength: 1, maxLength: 100, pattern: '\\S' }),
  date: str({ pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' }),
  time_zone: str({ minLength: 1, maxLength: 100 }),
  start: Time,
  end: Time,
});
export type TripDay = Static<typeof TripDaySchema>;
export const tripDayValidator = compile(TripDaySchema);
export const tripEditValidator = compile(obj({ revision: RevisionSchema, day: TripDaySchema }));

const arrangementFields = {
  name: str({ minLength: 1, maxLength: 100, pattern: '\\S' }),
  start: Time,
  end: Time,
  address: str({ maxLength: 500 }),
  locked: bool(),
};
export const ArrangementSchema = obj({ arrangement_id: IdentifierSchema, ...arrangementFields });
export type Arrangement = Static<typeof ArrangementSchema>;
export const arrangementWriteValidator = compile(
  obj({
    revision: RevisionSchema,
    arrangement: obj(arrangementFields),
  }),
);
export type ArrangementInput = Omit<Arrangement, 'arrangement_id'>;

const Warning = union([
  obj({ kind: lit('missing_location'), arrangement_id: IdentifierSchema }),
  obj({ kind: lit('outside_trip_hours'), arrangement_id: IdentifierSchema }),
  obj({ kind: lit('overlap'), arrangement_id: IdentifierSchema, other_id: IdentifierSchema }),
]);
export type ArrangementWarning = Static<typeof Warning>;
export const TripDetailSchema = obj({
  ...tripFields,
  day: nullable(TripDaySchema),
  arrangements: arr(ArrangementSchema),
  warnings: arr(Warning),
});
export type TripDetail = Static<typeof TripDetailSchema>;
export const tripDetailValidator = compile(TripDetailSchema);
const TripListSchema = obj({
  current_trip_id: nullable(IdentifierSchema),
  trips: arr(
    obj({ trip_id: IdentifierSchema, revision: RevisionSchema, day: nullable(TripDaySchema) }),
  ),
});
export type TripList = Static<typeof TripListSchema>;
export const tripListValidator = compile(TripListSchema);

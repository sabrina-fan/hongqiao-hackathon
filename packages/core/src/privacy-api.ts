import { arr, compile, nullable, obj, str, type Static } from '@earendil-works/pi-schema';
import { IdentifierSchema } from './contracts.js';
import { TripDetailSchema } from './trip-api.js';
import { ImportReviewSchema, SavedPlaceSchema } from './wishlist-api.js';

const UploadRecordSchema = obj({
  import_id: IdentifierSchema,
  trip_id: nullable(IdentifierSchema),
  batch_id: nullable(IdentifierSchema),
  name: str({ maxLength: 160 }),
  review: nullable(ImportReviewSchema),
});
const AnonymousDataSchema = obj({
  trips: arr(TripDetailSchema),
  places: arr(SavedPlaceSchema),
  uploads: arr(UploadRecordSchema),
});
export const anonymousDataValidator = compile(AnonymousDataSchema);
export type AnonymousData = Static<typeof AnonymousDataSchema>;
export type UploadRecord = Static<typeof UploadRecordSchema>;

const CorrectPlaceSchema = obj({
  query: str({ minLength: 1, maxLength: 100, pattern: '\\S' }),
  poi_id: IdentifierSchema,
});
export const correctPlaceValidator = compile(CorrectPlaceSchema);
export type CorrectPlace = Static<typeof CorrectPlaceSchema>;

import {
  arr,
  compile,
  lit,
  nullable,
  obj,
  opt,
  str,
  union,
  type Static,
} from '@earendil-works/pi-schema';
import { IdentifierSchema } from './contracts.js';
import { pendingBatchRemovalFields } from './import-batch-api.js';
import { TripDetailSchema } from './trip-api.js';
import { ImportReviewSchema, SavedPlaceSchema } from './wishlist-api.js';

const UploadRecordSchema = obj({
  import_id: IdentifierSchema,
  trip_id: nullable(IdentifierSchema),
  batch_id: nullable(IdentifierSchema),
  name: str({ maxLength: 160 }),
  review: nullable(ImportReviewSchema),
});
const anonymousDataFields = {
  trips: arr(TripDetailSchema),
  places: arr(SavedPlaceSchema),
  uploads: arr(UploadRecordSchema),
};
const AnonymousDataSchema = obj(anonymousDataFields);
export const anonymousDataValidator = compile(AnonymousDataSchema);
export type AnonymousData = Static<typeof AnonymousDataSchema>;
export type UploadRecord = Static<typeof UploadRecordSchema>;

const legacyPendingDeletions = [
  obj({ kind: lit('source'), id: str({ pattern: '^imp-[a-f0-9-]{36}$' }) }),
  obj({ kind: lit('trip'), id: IdentifierSchema }),
] as const;
const PendingDeletionSchema = union(legacyPendingDeletions);
export const pendingDeletionValidator = compile(PendingDeletionSchema);
export type PendingDeletion = Static<typeof PendingDeletionSchema>;

export const RETIRED_BATCH_REMOVALS_QUERY = 'include_retired_batch_removals';
const PendingRetiredBatchRemovalSchema = obj({
  kind: lit('batch_item'),
  batch_id: str({ pattern: '^bat-[a-f0-9-]{36}$' }),
  ...pendingBatchRemovalFields,
});
export const pendingRetiredBatchRemovalValidator = compile(PendingRetiredBatchRemovalSchema);
export type PendingRetiredBatchRemoval = Static<typeof PendingRetiredBatchRemovalSchema>;

const SettingsDataSchema = obj({
  ...anonymousDataFields,
  // Older servers ignore either opt-in and may return the original response.
  pending_deletions: opt(arr(union([...legacyPendingDeletions, PendingRetiredBatchRemovalSchema]))),
});
export const settingsDataValidator = compile(SettingsDataSchema);
export type SettingsData = Static<typeof SettingsDataSchema>;

const CorrectPlaceSchema = obj({
  query: str({ minLength: 1, maxLength: 100, pattern: '\\S' }),
  poi_id: IdentifierSchema,
});
export const correctPlaceValidator = compile(CorrectPlaceSchema);
export type CorrectPlace = Static<typeof CorrectPlaceSchema>;

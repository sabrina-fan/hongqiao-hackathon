import { arr, compile, int, lit, obj, oneOf, str, union } from '@earendil-works/pi-schema';
import type { Static } from '@earendil-works/pi-schema';
import { IdentifierSchema, RevisionSchema } from './contracts.js';
import { ImportReviewSchema } from './wishlist-api.js';

export const IMPORT_BATCH_MAX_IMAGES = 15;
// A client sending this header with value `1` can handle 204 when a completed removal has no batch snapshot.
export const ALLOW_RETIRED_REMOVAL_HEADER = 'x-nextstop-allow-retired-removal';
const image = { import_id: IdentifierSchema, name: str({ maxLength: 160 }) };
const stored = { ...image, image_type: oneOf(['image/png', 'image/jpeg']) };
const reviewed = { ...stored, review: ImportReviewSchema };
const item = union([
  obj({ ...image, kind: lit('invalid'), reason: oneOf(['too_large', 'invalid_image']) }),
  obj({ ...stored, kind: lit('processing') }),
  obj({ ...reviewed, kind: lit('ready') }),
  obj({ ...reviewed, kind: lit('failed'), reason: oneOf(['vision', 'map', 'interrupted']) }),
  obj({ ...stored, kind: lit('skipped') }),
  obj({ ...stored, kind: lit('saved') }),
]);
export const ImportBatchSchema = obj({
  batch_id: IdentifierSchema,
  revision: RevisionSchema,
  items: arr(item, { maxItems: IMPORT_BATCH_MAX_IMAGES }),
});
export const ConfirmBatchSchema = obj({
  revision: RevisionSchema,
  new_count: int({ minimum: 0, maximum: IMPORT_BATCH_MAX_IMAGES }),
  selections: arr(obj({ import_id: IdentifierSchema, poi_id: IdentifierSchema }), {
    minItems: 1,
    maxItems: IMPORT_BATCH_MAX_IMAGES,
  }),
});
export type ImportBatch = Static<typeof ImportBatchSchema>;
export type ImportBatchItem = Static<typeof item>;
export type ConfirmBatch = Static<typeof ConfirmBatchSchema>;
export const importBatchValidator = compile(ImportBatchSchema);
export const confirmBatchValidator = compile(ConfirmBatchSchema);
export const batchRevisionValidator = compile(obj({ revision: RevisionSchema }));
export const batchSearchValidator = compile(
  obj({ revision: RevisionSchema, query: str({ minLength: 1, maxLength: 100, pattern: '\\S' }) }),
);

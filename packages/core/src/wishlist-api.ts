import { arr, compile, lit, nullable, obj, oneOf, str, union } from '@earendil-works/pi-schema';
import type { Static } from '@earendil-works/pi-schema';
import { IdentifierSchema, RevisionSchema } from './contracts.js';
import { PlaceOptionSchema } from './radar-api.js';

export const IMPORT_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const Name = str({ minLength: 1, maxLength: 100, pattern: '\\S' });
const Excerpt = str({ minLength: 1, maxLength: 240, pattern: '\\S' });
const Confidence = oneOf(['high', 'medium', 'low']);
export const VisualExtractionSchema = union([
  obj({ kind: lit('text'), name: Name, excerpt: Excerpt, confidence: Confidence }),
  obj({ kind: lit('guess'), name: Name, confidence: Confidence }),
  obj({ kind: lit('unrecognized') }),
]);
const Extraction = union([
  VisualExtractionSchema,
  obj({ kind: lit('vision_unavailable') }),
  obj({ kind: lit('manual') }),
]);
const Match = union([
  obj({ kind: lit('results'), candidates: arr(PlaceOptionSchema, { maxItems: 10 }) }),
  obj({ kind: lit('not_searched') }),
  obj({ kind: lit('map_unavailable') }),
]);
const Provider = lit('amap');
const poiIdentity = { provider: Provider, poi_id: IdentifierSchema };
const sourceIdentity = { import_id: IdentifierSchema };
const ImportSource = union([
  obj({ ...sourceIdentity, kind: lit('image'), excerpt: nullable(Excerpt) }),
  obj({ ...sourceIdentity, kind: lit('manual') }),
]);
export const ImportReviewSchema = obj({
  ...sourceIdentity,
  revision: RevisionSchema,
  source: ImportSource,
  extraction: Extraction,
  match: Match,
});
export const ConfirmImportSchema = obj({ revision: RevisionSchema, ...poiIdentity });
export const WishlistPlaceSchema = obj({
  ...poiIdentity,
  city: lit('苏州'),
  name: str({ minLength: 1, maxLength: 200 }),
  address: str({ maxLength: 500 }),
  sources: arr(ImportSource, { minItems: 1 }),
});
const WishlistSchema = obj({ places: arr(WishlistPlaceSchema) });
export type VisualExtraction = Static<typeof VisualExtractionSchema>;
export type ImportReview = Static<typeof ImportReviewSchema>;
export type ConfirmImport = Static<typeof ConfirmImportSchema>;
export type WishlistPlace = Static<typeof WishlistPlaceSchema>;
export type Wishlist = Static<typeof WishlistSchema>;
export const visualExtractionValidator = compile(VisualExtractionSchema);
export const importReviewValidator = compile(ImportReviewSchema);
export const confirmImportValidator = compile(ConfirmImportSchema);
export const importSearchValidator = compile(obj({ query: Name }));
export const wishlistPlaceValidator = compile(WishlistPlaceSchema);
export const wishlistValidator = compile(WishlistSchema);

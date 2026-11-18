import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { defineDocFamily } from '@earendil-works/pi-durable';
import { compile, nullable, obj, union, lit } from '@earendil-works/pi-schema';
import type { Static } from '@earendil-works/pi-schema';
import {
  ConfirmImportSchema,
  ImportReviewSchema,
  WishlistPlaceSchema,
  wishlistValidator,
  type ConfirmImport,
  type ImportReview,
  type Wishlist,
  type WishlistPlace,
} from '@nextstop/core';
import { HttpFault } from '../http.js';
import type { UserRuntime } from '../runtime/open-user-runtime.js';

const ReceiptSchema = obj({ selection: ConfirmImportSchema, place: WishlistPlaceSchema });
const ImportRecordSchema = obj({
  review: nullable(ImportReviewSchema),
  image_type: nullable(union([lit('image/png'), lit('image/jpeg')])),
  receipt: nullable(ReceiptSchema),
});
const importRecordValidator = compile(ImportRecordSchema);
type ImportRecord = Static<typeof ImportRecordSchema>;
const Imports = defineDocFamily<ImportRecord, string>({
  kind: 'nextstop.import',
  version: 1,
  family: true,
  scope: 'conversation',
  history: 'rewindable',
  fork: 'current',
  checkpointWhen: () => true,
  initial: () => ({ review: null, image_type: null, receipt: null }),
});
const Wishes = defineDocFamily<Wishlist, string>({
  kind: 'nextstop.wishlist',
  version: 1,
  family: true,
  scope: 'conversation',
  history: 'rewindable',
  fork: 'current',
  checkpointWhen: () => true,
  initial: () => ({ places: [] }),
});
const WISHLIST_KEY = 'current';

function checkedRecord(record: ImportRecord | undefined, id: string) {
  if (!record?.review) throw new HttpFault('IMPORT_NOT_FOUND');
  if (
    !importRecordValidator.check(record) ||
    record.review.import_id !== id ||
    record.review.source.import_id !== id
  )
    throw new Error('Invalid stored import');
  return { record, review: record.review };
}

export function saveImport({
  runtime,
  review,
  imageType,
}: {
  runtime: UserRuntime;
  review: ImportReview;
  imageType: ImportRecord['image_type'];
}) {
  const id = review.import_id;
  return runtime.conversation.commit(async (tx) => {
    const record = await tx.doc(Imports, runtime.conversation.id, id, id);
    if (record.review) throw new Error('Import ID collision');
    record.review = review;
    record.image_type = imageType;
  }, BACKGROUND_CONTEXT);
}

export async function readImport(runtime: UserRuntime, id: string) {
  return checkedRecord(
    await runtime.harness.snapshot(Imports, runtime.conversation.id, id, BACKGROUND_CONTEXT),
    id,
  );
}

export function updateMatch({
  runtime,
  id,
  match,
  revision,
}: {
  runtime: UserRuntime;
  id: string;
  match: ImportReview['match'];
  revision: number;
}) {
  return runtime.conversation.commit(async (tx) => {
    const { record, review } = checkedRecord(
      await tx.doc(Imports, runtime.conversation.id, id, id),
      id,
    );
    if (record.receipt) throw new HttpFault('IMPORT_CONFIRMED');
    if (review.revision !== revision) throw new HttpFault('IMPORT_STALE');
    const changed = {
      ...review,
      source: { ...review.source },
      extraction: { ...review.extraction },
      match,
      revision: revision + 1,
    };
    record.review = changed;
    return changed;
  }, BACKGROUND_CONTEXT);
}

export async function readWishlist(runtime: UserRuntime): Promise<Wishlist> {
  const state = await runtime.harness.snapshot(
    Wishes,
    runtime.conversation.id,
    WISHLIST_KEY,
    BACKGROUND_CONTEXT,
  );
  if (!state) return { places: [] };
  if (!wishlistValidator.check(state)) throw new Error('Invalid stored wishlist');
  return state;
}

export function confirmImport({
  runtime,
  id,
  selection,
}: {
  runtime: UserRuntime;
  id: string;
  selection: ConfirmImport;
}) {
  const scope = runtime.conversation.id;
  return runtime.conversation.commit(async (tx): Promise<WishlistPlace> => {
    const { record, review } = checkedRecord(await tx.doc(Imports, scope, id, id), id);
    if (record.receipt) {
      const prior = record.receipt.selection;
      if (
        prior.revision === selection.revision &&
        prior.provider === selection.provider &&
        prior.poi_id === selection.poi_id
      ) {
        const { place } = record.receipt;
        return { ...place, sources: place.sources.map((source) => ({ ...source })) };
      }
      throw new HttpFault('IMPORT_CONFIRMED');
    }
    if (review.revision !== selection.revision) throw new HttpFault('IMPORT_STALE');
    const candidates = review.match.kind === 'results' ? review.match.candidates : [];
    const chosen = candidates.find(({ id: poiId }) => poiId === selection.poi_id);
    if (!chosen) throw new HttpFault('IMPORT_INVALID_CHOICE');
    const wishlist = await tx.doc(Wishes, scope, WISHLIST_KEY, WISHLIST_KEY);
    if (!wishlistValidator.check(wishlist)) throw new Error('Invalid stored wishlist');
    const index = wishlist.places.findIndex(
      ({ provider, poi_id }) => provider === selection.provider && poi_id === chosen.id,
    );
    const existing = wishlist.places[index];
    const place: WishlistPlace = {
      provider: selection.provider,
      poi_id: chosen.id,
      city: '苏州',
      name: chosen.name,
      address: chosen.address,
      sources: [
        ...(existing?.sources ?? []).map((source) => ({ ...source })),
        { ...review.source },
      ],
    };
    if (existing) wishlist.places[index] = place;
    else wishlist.places.push(place);
    record.receipt = { selection, place };
    return place;
  }, BACKGROUND_CONTEXT);
}

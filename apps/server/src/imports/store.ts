import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { defineDocFamily } from '@earendil-works/pi-durable';
import { compile, nullable, obj, union, lit } from '@earendil-works/pi-schema';
import type { Static } from '@earendil-works/pi-schema';
import {
  ConfirmImportSchema,
  ImportReviewSchema,
  WishlistPlaceSchema,
  type ConfirmImport,
  type ImportReview,
  type WishlistPlace,
} from '@nextstop/core';
import { HttpFault } from '../http.js';
import type { UserRuntime } from '../runtime/open-user-runtime.js';
import { saveWishlistSource } from '../wishlist/store.js';

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
    const place = await saveWishlistSource({
      runtime,
      tx,
      incoming: {
        provider: selection.provider,
        poi_id: chosen.id,
        city: '苏州',
        name: chosen.name,
        address: chosen.address,
        sources: [{ ...review.source }],
      },
    });
    record.receipt = { selection, place };
    return place;
  }, BACKGROUND_CONTEXT);
}

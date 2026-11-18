import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { defineDocFamily, type Tx } from '@earendil-works/pi-durable';
import { compile, nullable, obj, opt, type Static } from '@earendil-works/pi-schema';
import {
  ConfirmBatchSchema,
  ImportBatchSchema,
  IdentifierSchema,
  type ConfirmBatch,
  type ConfirmImport,
  type ImportBatch,
  type ImportBatchItem,
  type ImportReview,
} from '@nextstop/core';
import { HttpFault } from '../http.js';
import type { UserRuntime } from '../runtime/open-user-runtime.js';
import {
  listPendingRetiredBatchRemovals,
  recordImageCleanup,
  resumeImageCleanup,
} from './image-cleanup.js';
import { emptyImageReview } from './review.js';
import { writeBatchChoices } from './store.js';

const BatchRecordSchema = obj({
  batch: nullable(ImportBatchSchema),
  confirmation: nullable(ConfirmBatchSchema),
  trip_id: opt(IdentifierSchema),
});
const batchRecord = compile(BatchRecordSchema);
type BatchRecord = Static<typeof BatchRecordSchema>;
const Batches = defineDocFamily<BatchRecord, string>({
  kind: 'nextstop.import_batch',
  version: 1,
  family: true,
  scope: 'conversation',
  history: 'rewindable',
  fork: 'current',
  checkpointWhen: () => true,
  initial: () => ({ batch: null, confirmation: null }),
});

type UserTransaction = Parameters<Parameters<UserRuntime['conversation']['commit']>[0]>[0];
type Processing = Extract<ImportBatchItem, { kind: 'processing' }>;

function checkedBatch(record: BatchRecord | undefined, id: string) {
  if (!record?.batch) throw new HttpFault('IMPORT_NOT_FOUND');
  if (!batchRecord.check(record) || record.batch.batch_id !== id)
    throw new Error('Invalid stored import batch');
  return record.batch;
}

export function saveBatch(runtime: UserRuntime, batch: ImportBatch, tripId?: string) {
  const id = batch.batch_id;
  return runtime.conversation.commit(async (tx) => {
    const record = await tx.doc(Batches, runtime.conversation.id, id, id);
    if (record.batch) throw new Error('Import batch ID collision');
    record.batch = batch;
    if (tripId) record.trip_id = tripId;
  }, BACKGROUND_CONTEXT);
}

export async function listImportBatches(runtime: UserRuntime) {
  const scope = runtime.conversation.id;
  return Promise.all(
    (await runtime.familyKeys(Batches.definition.kind)).map(async (id) => {
      const record = await runtime.harness.snapshot(Batches, scope, id, BACKGROUND_CONTEXT);
      const batch = checkedBatch(record, id);
      return { batch, tripId: record?.trip_id ?? null };
    }),
  );
}

export async function listRetiredBatchRemovals(runtime: UserRuntime) {
  const activeBatchIds = new Set(await runtime.familyKeys(Batches.definition.kind));
  return listPendingRetiredBatchRemovals(runtime, activeBatchIds);
}

export async function removeBatchImages({
  runtime,
  tx,
  ids,
  batches,
  tripId,
}: {
  runtime: UserRuntime;
  tx: Tx;
  ids: ReadonlySet<string>;
  batches: Awaited<ReturnType<typeof listImportBatches>>;
  tripId?: string;
}) {
  const scope = runtime.conversation.id;
  for (const entry of batches) {
    const { batch_id, items } = entry.batch;
    const owned = tripId !== undefined && entry.tripId === tripId;
    if (!owned && !items.some(({ import_id }) => ids.has(import_id))) continue;
    const retained = items.filter(
      (item) => !ids.has(item.import_id) && (!owned || item.kind !== 'invalid'),
    );
    if (retained.length === 0) {
      await tx.retireDoc(Batches, scope, batch_id);
    } else {
      const record = await tx.doc(Batches, scope, batch_id, batch_id);
      record.batch = {
        ...entry.batch,
        revision: entry.batch.revision + 1,
        items: retained.map((item) => structuredClone(item)),
      };
      record.confirmation = null;
      if (owned) delete record.trip_id;
    }
  }
}

async function findBatch(runtime: UserRuntime, id: string) {
  const record = await runtime.harness.snapshot(
    Batches,
    runtime.conversation.id,
    id,
    BACKGROUND_CONTEXT,
  );
  return record?.batch ? checkedBatch(record, id) : null;
}

export async function readBatch(runtime: UserRuntime, id: string) {
  const batch = await findBatch(runtime, id);
  if (!batch) throw new HttpFault('IMPORT_NOT_FOUND');
  return batch;
}

async function changeBatch(
  runtime: UserRuntime,
  id: string,
  change: (
    batch: ImportBatch,
    record: BatchRecord,
    tx: UserTransaction,
  ) => boolean | Promise<boolean>,
) {
  await runtime.conversation.commit(async (tx) => {
    const record = await tx.doc(Batches, runtime.conversation.id, id, id);
    const batch = checkedBatch(record, id);
    if (await change(batch, record, tx)) batch.revision += 1;
  }, BACKGROUND_CONTEXT);
  return readBatch(runtime, id);
}

function checkRevision(batch: ImportBatch, revision: number) {
  if (batch.revision !== revision) throw new HttpFault('IMPORT_STALE');
}

export function batchItem(batch: ImportBatch, id: string) {
  const item = batch.items.find(({ import_id }) => import_id === id);
  if (!item) throw new HttpFault('IMPORT_NOT_FOUND');
  return item;
}

export function reviewedItem(item: ImportBatchItem) {
  return item.kind === 'ready' || item.kind === 'failed' ? item : null;
}

export function storedImage({
  import_id,
  name,
  image_type,
}: Exclude<ImportBatchItem, { kind: 'invalid' }>) {
  return { import_id, name, image_type };
}

export function updateBatchItem({
  runtime,
  id,
  imageId,
  revision,
  update,
}: {
  runtime: UserRuntime;
  id: string;
  imageId: string;
  revision: number;
  update: (item: ImportBatchItem) => ImportBatchItem;
}) {
  return changeBatch(runtime, id, (batch) => {
    checkRevision(batch, revision);
    const item = batchItem(batch, imageId);
    const index = batch.items.findIndex(({ import_id }) => import_id === imageId);
    batch.items[index] = update(item);
    return true;
  });
}

export async function removeBatchItem({
  runtime,
  id,
  imageId,
  revision,
  remove,
}: {
  runtime: UserRuntime;
  id: string;
  imageId: string;
  revision: number;
  remove: (id: string) => Promise<void>;
}) {
  const deletion = { kind: 'batch_item' as const, batchId: id, imageId, revision };
  // Only an exact, completed cleanup replay can succeed without a live batch.
  if (await resumeImageCleanup(runtime, deletion, remove)) return findBatch(runtime, id);
  const batch = await changeBatch(runtime, id, async (current, _record, tx) => {
    checkRevision(current, revision);
    const item = batchItem(current, imageId);
    if (item.kind === 'saved') throw new HttpFault('IMPORT_CONFIRMED');
    current.items = current.items.filter(({ import_id }) => import_id !== imageId);
    await recordImageCleanup(runtime, tx, deletion, item.kind === 'invalid' ? [] : [imageId]);
    return true;
  });
  await resumeImageCleanup(runtime, deletion, remove);
  return batch;
}

export function replaceProcessing(
  runtime: UserRuntime,
  id: string,
  replace: (item: Processing) => ImportBatchItem | null,
) {
  return changeBatch(runtime, id, (batch) => {
    let changed = false;
    for (const [index, item] of batch.items.entries()) {
      if (item.kind !== 'processing') continue;
      const next = replace(item);
      if (!next) continue;
      batch.items[index] = next;
      changed = true;
    }
    return changed;
  });
}

export function interrupted(item: Processing): ImportBatchItem {
  return {
    ...item,
    kind: 'failed',
    reason: 'interrupted',
    review: emptyImageReview(item.import_id),
  };
}

function copyReview(review: ImportReview): ImportReview {
  const { match } = review;
  return {
    ...review,
    source: { ...review.source },
    extraction: { ...review.extraction },
    match:
      match.kind === 'results'
        ? { ...match, candidates: match.candidates.map((candidate) => ({ ...candidate })) }
        : { ...match },
  };
}

export function confirmBatch(runtime: UserRuntime, id: string, input: ConfirmBatch) {
  const { revision, selections, new_count } = input;
  return changeBatch(runtime, id, async (batch, record, tx) => {
    const prior = record.confirmation;
    if (
      batch.revision === revision + 1 &&
      prior?.revision === revision &&
      prior.new_count === new_count &&
      prior.selections.length === selections.length &&
      selections.every((selection, index) => {
        const previous = prior.selections[index];
        return previous?.import_id === selection.import_id && previous.poi_id === selection.poi_id;
      })
    )
      return false;
    checkRevision(batch, revision);
    const selected = new Set<string>();
    const choices = selections.map(({ import_id, poi_id }) => {
      const item = reviewedItem(batchItem(batch, import_id));
      if (!item || item.review.import_id !== import_id || selected.has(import_id))
        throw new HttpFault('IMPORT_INVALID_CHOICE');
      const match = item.review.match;
      const chosen =
        match.kind === 'results' && match.candidates.find(({ id: poiId }) => poiId === poi_id);
      if (!chosen) throw new HttpFault('IMPORT_INVALID_CHOICE');
      selected.add(import_id);
      const selection: ConfirmImport = { revision: item.review.revision, provider: 'amap', poi_id };
      return {
        selection,
        chosen: { ...chosen },
        review: copyReview(item.review),
        imageType: item.image_type,
      };
    });
    await writeBatchChoices({ runtime, tx, choices, newCount: new_count });
    for (const [index, item] of batch.items.entries()) {
      if (item.kind !== 'invalid' && selected.has(item.import_id))
        batch.items[index] = { ...storedImage(item), kind: 'saved' };
    }
    record.confirmation = input;
    return true;
  });
}

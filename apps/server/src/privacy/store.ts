import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { AnonymousData, UploadRecord } from '@nextstop/core';
import { listImportBatches, removeBatchImages } from '../imports/batch-store.js';
import { recordImageCleanup, resumeImageCleanup } from '../imports/image-cleanup.js';
import { listImportRecords, removeImportRecords } from '../imports/store.js';
import { prepareRadarRetirement } from '../radar/store.js';
import type { UserRuntime } from '../runtime/open-user-runtime.js';
import { retireTripDraft } from '../trip/draft-store.js';
import { findTrip, getTripDetail, listTrips, retireTrip, TripFault } from '../trip/store.js';
import { readWishlist, removeImageSources } from '../wishlist/store.js';

async function inventory(runtime: UserRuntime) {
  const batches = await listImportBatches(runtime);
  const records = await listImportRecords(runtime);
  const uploads = new Map<string, UploadRecord>();
  for (const { record, review } of records) {
    if (record.image_type)
      uploads.set(review.import_id, {
        import_id: review.import_id,
        trip_id: record.trip_id ?? null,
        batch_id: null,
        name: '攻略截图',
        review,
      });
  }
  for (const { batch, tripId } of batches) {
    for (const item of batch.items) {
      if (item.kind === 'invalid') continue;
      uploads.set(item.import_id, {
        import_id: item.import_id,
        trip_id: tripId,
        batch_id: batch.batch_id,
        name: item.name,
        review: 'review' in item ? item.review : (uploads.get(item.import_id)?.review ?? null),
      });
    }
  }
  return { batches, records, uploads: [...uploads.values()] };
}

export async function exportData(runtime: UserRuntime): Promise<AnonymousData> {
  const { trips } = await listTrips(runtime);
  return {
    trips: await Promise.all(trips.map(({ trip_id }) => getTripDetail(runtime, trip_id))),
    places: (await readWishlist(runtime, {})).places,
    uploads: (await inventory(runtime)).uploads,
  };
}

export async function eraseSource(
  runtime: UserRuntime,
  id: string,
  remove: (id: string) => Promise<void>,
) {
  const deletion = { kind: 'source' as const, id };
  if (await resumeImageCleanup(runtime, deletion, remove)) return;
  const { uploads, records, batches } = await inventory(runtime);
  if (!uploads.some(({ import_id }) => import_id === id)) return;
  const ids = new Set([id]);
  await runtime.conversation.commit(async (tx) => {
    await removeBatchImages({ runtime, tx, ids, batches });
    await removeImportRecords(runtime, tx, ids, records);
    await removeImageSources(runtime, tx, ids);
    await recordImageCleanup(runtime, tx, deletion, ids);
  }, BACKGROUND_CONTEXT);
  await resumeImageCleanup(runtime, deletion, remove);
}

export async function eraseTrip(
  runtime: UserRuntime,
  id: string,
  remove: (id: string) => Promise<void>,
  cancelRadar: () => void,
) {
  const deletion = { kind: 'trip' as const, id };
  if (await resumeImageCleanup(runtime, deletion, remove)) return;
  const target = await findTrip(runtime, id).catch((error: unknown) => {
    if (error instanceof TripFault && error.code === 'TRIP_NOT_FOUND') return null;
    throw error;
  });
  if (!target) return;
  cancelRadar();
  const { uploads, records, batches } = await inventory(runtime);
  const { places } = await readWishlist(runtime, {});
  const shared = new Set(
    places.flatMap(({ sources }) => sources.map(({ import_id }) => import_id)),
  );
  const ids = new Set(
    uploads
      .filter(({ import_id, trip_id }) => trip_id === id && !shared.has(import_id))
      .map(({ import_id }) => import_id),
  );
  const retireRadar = await prepareRadarRetirement(runtime, id);
  await runtime.conversation.commit(async (tx) => {
    await removeBatchImages({ runtime, tx, ids, batches, tripId: id });
    await removeImportRecords(runtime, tx, ids, records, id);
    await retireRadar(tx);
    await retireTripDraft(runtime, tx, id);
    await retireTrip(runtime, tx, target.key);
    await recordImageCleanup(runtime, tx, deletion, ids);
  }, BACKGROUND_CONTEXT);
  await resumeImageCleanup(runtime, deletion, remove);
}

import {
  ALLOW_RETIRED_REMOVAL_HEADER,
  batchRevisionValidator,
  batchSearchValidator,
  confirmBatchValidator,
  type ImportBatchItem,
} from '@nextstop/core';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpFault, readJson, send } from '../http.js';
import type { createUserAccess } from '../radar/user-access.js';
import { readActiveTrip } from '../trip/store.js';
import {
  batchItem,
  confirmBatch,
  interrupted,
  readBatch,
  removeBatchItem,
  replaceProcessing,
  reviewedItem,
  saveBatch,
  storedImage,
  updateBatchItem,
} from './batch-store.js';
import {
  prepareImportImage,
  readBatchFiles,
  sendImportImage,
  type createImportImages,
} from './images.js';
import type { createImportReview } from './review.js';

export function batchRoute(method: string | undefined, path: string) {
  if (method === 'POST' && path === '/api/v1/import-batches')
    return { kind: 'create_batch' } as const;
  const match =
    /^\/api\/v1\/import-batches\/(bat-[a-f0-9-]{36})(?:\/(confirm)|\/items\/(imp-[a-f0-9-]{36})\/(image|retry|remove|skip|search))?$/.exec(
      path,
    );
  const id = match?.[1];
  if (!id) return null;
  const [, , confirm, imageId, action] = match;
  if (method === 'GET' && !confirm && !imageId) return { kind: 'read_batch', id } as const;
  if (method === 'POST' && confirm) return { kind: 'confirm_batch', id } as const;
  if (!imageId) return null;
  if (method === 'GET' && action === 'image') return { kind: 'batch_image', id, imageId } as const;
  if (
    method === 'POST' &&
    (action === 'retry' || action === 'remove' || action === 'skip' || action === 'search')
  )
    return { kind: 'batch_item_action', id, imageId, action } as const;
  return null;
}

type Processing = Extract<ImportBatchItem, { kind: 'processing' }>;

export function createBatchHandler(
  images: ReturnType<typeof createImportImages>,
  review: ReturnType<typeof createImportReview>,
) {
  const scheduled = new Map<string, symbol>();
  let workers = 0;
  let receivingBatch = false;

  function reserveWorker() {
    if (workers >= 4) throw new HttpFault('IMPORT_BUSY');
    workers += 1;
  }

  function start(
    userId: string,
    id: string,
    items: Processing[],
    withUser: ReturnType<typeof createUserAccess>,
  ) {
    const job = Symbol();
    for (const item of items) scheduled.set(item.import_id, job);
    void (async () => {
      try {
        for (const item of items) {
          const imageId = item.import_id;
          const data = await withUser(userId, async (runtime) => {
            const batch = await readBatch(runtime, id);
            if (
              !batch.items.some(
                (current) => current.import_id === imageId && current.kind === 'processing',
              )
            )
              return null;
            return images.read(userId, imageId);
          });
          if (!data) continue;
          const result = await withUser.task(userId, (signal) =>
            review.image(
              imageId,
              {
                data: data.toString('base64'),
                mimeType: item.image_type,
              },
              signal,
            ),
          );
          const reason =
            result.extraction.kind === 'vision_unavailable'
              ? 'vision'
              : result.match.kind === 'map_unavailable'
                ? 'map'
                : null;
          const next: ImportBatchItem = reason
            ? { ...item, kind: 'failed', reason, review: result }
            : { ...item, kind: 'ready', review: result };
          await withUser(userId, (runtime) =>
            replaceProcessing(runtime, id, (current) =>
              current.import_id === imageId ? next : null,
            ),
          );
        }
      } finally {
        for (const item of items) {
          if (scheduled.get(item.import_id) === job) scheduled.delete(item.import_id);
        }
        workers -= 1;
      }
    })().catch(() => {
      // An interrupted worker leaves its unfinished items eligible for recovery on read.
    });
  }

  return async ({
    route,
    request,
    response,
    userId,
    withUser,
  }: {
    route: NonNullable<ReturnType<typeof batchRoute>>;
    request: IncomingMessage;
    response: ServerResponse;
    userId: string;
    withUser: ReturnType<typeof createUserAccess>;
  }) => {
    if (route.kind === 'create_batch') {
      if (receivingBatch) throw new HttpFault('IMPORT_BUSY');
      reserveWorker();
      receivingBatch = true;
      const stored: { item: Processing; image: Awaited<ReturnType<typeof prepareImportImage>> }[] =
        [];
      try {
        const id = `bat-${randomUUID()}`;
        const items: ImportBatchItem[] = [];
        for (const file of await readBatchFiles(request)) {
          const base = { import_id: `imp-${randomUUID()}`, name: file.name.slice(0, 160) };
          let prepared;
          try {
            prepared = await prepareImportImage(file);
          } catch (error) {
            if (!(error instanceof HttpFault)) throw error;
            items.push({
              ...base,
              kind: 'invalid',
              reason: error.code === 'REQUEST_TOO_LARGE' ? 'too_large' : 'invalid_image',
            });
            continue;
          }
          const item: Processing = { ...base, image_type: prepared.mimeType, kind: 'processing' };
          stored.push({ item, image: prepared });
          items.push(item);
        }
        const batch = { batch_id: id, revision: 1, items };
        await withUser(userId, async (runtime) => {
          const tripId = (await readActiveTrip(runtime))?.trip_id;
          for (const { item, image } of stored) await images.put(userId, item.import_id, image);
          await saveBatch(runtime, batch, tripId);
        });
        start(
          userId,
          id,
          stored.map(({ item }) => item),
          withUser,
        );
        return send(response, 202, batch);
      } catch (error) {
        workers -= 1;
        await Promise.allSettled(stored.map(({ item }) => images.remove(userId, item.import_id)));
        throw error;
      } finally {
        receivingBatch = false;
      }
    }
    const { id } = route;
    if (route.kind === 'read_batch') {
      const batch = await withUser(userId, async (runtime) => {
        const current = await readBatch(runtime, id);
        return current.items.some(
          (item) => item.kind === 'processing' && !scheduled.has(item.import_id),
        )
          ? replaceProcessing(runtime, id, (item) =>
              scheduled.has(item.import_id) ? null : interrupted(item),
            )
          : current;
      });
      return send(response, 200, batch);
    }
    if (route.kind === 'confirm_batch') {
      const input = await readJson(request, confirmBatchValidator.check);
      return send(
        response,
        200,
        await withUser(userId, (runtime) => confirmBatch(runtime, id, input)),
      );
    }
    const { imageId } = route;
    if (route.kind === 'batch_image') {
      const { data, imageType } = await withUser(userId, async (runtime) => {
        const item = batchItem(await readBatch(runtime, id), imageId);
        if (item.kind === 'invalid') throw new HttpFault('IMPORT_NOT_FOUND');
        return { data: await images.read(userId, imageId), imageType: item.image_type };
      });
      return sendImportImage(response, imageType, data);
    }
    if (route.action === 'search') {
      const { revision, query } = await readJson(request, batchSearchValidator.check);
      const current = await withUser(userId, (runtime) => readBatch(runtime, id));
      if (current.revision !== revision) throw new HttpFault('IMPORT_STALE');
      if (!reviewedItem(batchItem(current, imageId))) throw new HttpFault('IMPORT_INVALID_CHOICE');
      const match = await review.match(query);
      const batch = await withUser(userId, (runtime) =>
        updateBatchItem({
          runtime,
          id,
          imageId,
          revision,
          update(item) {
            const reviewed = reviewedItem(item);
            if (!reviewed) throw new HttpFault('IMPORT_INVALID_CHOICE');
            const updated = { ...reviewed.review, match, revision: reviewed.review.revision + 1 };
            const image = storedImage(reviewed);
            return match.kind === 'map_unavailable'
              ? { ...image, kind: 'failed', reason: 'map', review: updated }
              : { ...image, kind: 'ready', review: updated };
          },
        }),
      );
      return send(response, 200, batch);
    }
    const { revision } = await readJson(request, batchRevisionValidator.check);
    if (route.action === 'retry') {
      reserveWorker();
      const storage = await withUser(userId, async (runtime) => {
        const batch = await updateBatchItem({
          runtime,
          id,
          imageId,
          revision,
          update(item) {
            if (item.kind !== 'failed') throw new HttpFault('IMPORT_INVALID_CHOICE');
            return { ...storedImage(item), kind: 'processing' };
          },
        });
        const item = batchItem(batch, imageId);
        if (item.kind !== 'processing') throw new Error('Retry did not start');
        start(userId, id, [item], withUser);
        return batch;
      }).catch((error: unknown) => {
        workers -= 1;
        throw error;
      });
      return send(response, 202, storage);
    }
    if (route.action === 'remove') {
      const batch = await withUser(userId, (runtime) =>
        removeBatchItem({
          runtime,
          id,
          imageId,
          revision,
          remove: (target) => images.remove(userId, target),
        }),
      );
      if (batch) return send(response, 200, batch);
      if (request.headers[ALLOW_RETIRED_REMOVAL_HEADER] === '1') return send(response, 204);
      // Older PWAs parse every successful response as an ImportBatch.
      throw new HttpFault('IMPORT_NOT_FOUND');
    }
    const batch = await withUser(userId, (runtime) =>
      updateBatchItem({
        runtime,
        id,
        imageId,
        revision,
        update(item) {
          if (item.kind === 'saved') throw new HttpFault('IMPORT_CONFIRMED');
          const reviewed = reviewedItem(item);
          if (!reviewed) throw new HttpFault('IMPORT_INVALID_CHOICE');
          return { ...storedImage(reviewed), kind: 'skipped' };
        },
      }),
    );
    return send(response, 200, batch);
  };
}

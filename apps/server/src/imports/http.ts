import { confirmImportValidator, importSearchValidator, type ImportReview } from '@nextstop/core';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpFault, readJson, send } from '../http.js';
import type { RadarMap } from '../radar/amap.js';
import type { createUserAccess } from '../radar/user-access.js';
import { readActiveTrip } from '../trip/store.js';
import { batchRoute, createBatchHandler } from './batch-http.js';
import { createImportImages, readImportImage, sendImportImage } from './images.js';
import { createImportReview, type ImportVision } from './review.js';
import { confirmImport, readImport, saveImport, updateMatch } from './store.js';

export type { ImportVision } from './review.js';
export function importRoute(method: string | undefined, path: string) {
  if (method === 'POST' && path === '/api/v1/imports') return { kind: 'upload' } as const;
  if (method === 'POST' && path === '/api/v1/imports/search') return { kind: 'manual' } as const;
  const match = /^\/api\/v1\/imports\/(imp-[a-f0-9-]{36})(?:\/(confirm|search|image))?$/.exec(path);
  const id = match?.[1];
  if (!id) return batchRoute(method, path);
  if (method === 'POST' && match[2] === 'confirm') return { kind: 'confirm', id } as const;
  if (method === 'POST' && match[2] === 'search') return { kind: 'search', id } as const;
  if (method === 'GET' && match[2] === 'image') return { kind: 'image', id } as const;
  if (method === 'GET' && !match[2]) return { kind: 'review', id } as const;
  return null;
}

export function createImportHandler({
  dataDir,
  map,
  vision,
}: {
  dataDir: string;
  map: RadarMap | null | undefined;
  vision: ImportVision | null | undefined;
}) {
  const images = createImportImages(dataDir);
  const reviewImage = createImportReview(map, vision);
  const match = reviewImage.match;
  const handleBatch = createBatchHandler(images, reviewImage);
  let activeUploads = 0;

  return async (input: {
    request: IncomingMessage;
    response: ServerResponse;
    route: NonNullable<ReturnType<typeof importRoute>>;
    userId: string;
    withUser: ReturnType<typeof createUserAccess>;
  }) => {
    const { request, response, route, userId, withUser } = input;
    switch (route.kind) {
      case 'review': {
        const { review } = await withUser(userId, (runtime) => readImport(runtime, route.id));
        return send(response, 200, review);
      }
      case 'image': {
        const { data, imageType } = await withUser(userId, async (runtime) => {
          const { record } = await readImport(runtime, route.id);
          if (!record.image_type) throw new HttpFault('IMPORT_NOT_FOUND');
          return { data: await images.read(userId, route.id), imageType: record.image_type };
        });
        return sendImportImage(response, imageType, data);
      }
      case 'confirm': {
        const selection = await readJson(request, confirmImportValidator.check);
        return send(
          response,
          200,
          await withUser(userId, (runtime) => confirmImport({ runtime, id: route.id, selection })),
        );
      }
      case 'search': {
        const { query } = await readJson(request, importSearchValidator.check);
        const { record, review } = await withUser(userId, (runtime) =>
          readImport(runtime, route.id),
        );
        if (record.receipt) throw new HttpFault('IMPORT_CONFIRMED');
        const candidates = await match(query);
        const updated = await withUser(userId, (runtime) =>
          updateMatch({ runtime, id: route.id, match: candidates, revision: review.revision }),
        );
        return send(response, 200, updated);
      }
      case 'manual': {
        const { query } = await readJson(request, importSearchValidator.check);
        const id = `imp-${randomUUID()}`;
        const review: ImportReview = {
          import_id: id,
          revision: 1,
          source: { kind: 'manual', import_id: id },
          extraction: { kind: 'manual' },
          match: await match(query),
        };
        await withUser(userId, (runtime) => saveImport({ runtime, review, imageType: null }));
        return send(response, 201, review);
      }
      case 'upload': {
        if (activeUploads >= 4) throw new HttpFault('IMPORT_BUSY');
        activeUploads += 1;
        try {
          const image = await readImportImage(request);
          const id = `imp-${randomUUID()}`;
          const review = await withUser.task(userId, (signal) =>
            reviewImage.image(
              id,
              {
                data: image.data,
                mimeType: image.mimeType,
              },
              signal,
            ),
          );
          await withUser(userId, async (runtime) => {
            const tripId = (await readActiveTrip(runtime))?.trip_id;
            try {
              await images.put(userId, id, image);
              await saveImport({
                runtime,
                review,
                imageType: image.mimeType,
                ...(tripId && { tripId }),
              });
            } catch (error) {
              await images.remove(userId, id);
              throw error;
            }
          });
          return send(response, 201, review);
        } finally {
          activeUploads -= 1;
        }
      }
      default:
        return handleBatch({ ...input, route });
    }
  };
}

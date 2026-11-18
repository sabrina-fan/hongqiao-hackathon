import {
  confirmImportValidator,
  importSearchValidator,
  placeSearchValidator,
  visualExtractionValidator,
  type ImportReview,
  type VisualExtraction,
} from '@nextstop/core';
import type { VisionImage } from '@nextstop/model-gateway';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpFault, readJson, send } from '../http.js';
import type { RadarMap } from '../radar/amap.js';
import type { createUserAccess } from '../radar/user-access.js';
import { createImportImages, readImportImage } from './images.js';
import { confirmImport, readImport, readWishlist, saveImport, updateMatch } from './store.js';

export type ImportVision = (image: VisionImage) => Promise<VisualExtraction>;
export function importRoute(method: string | undefined, path: string) {
  if (method === 'GET' && path === '/api/v1/wishlist') return { kind: 'wishlist' } as const;
  if (method === 'POST' && path === '/api/v1/imports') return { kind: 'upload' } as const;
  if (method === 'POST' && path === '/api/v1/imports/search') return { kind: 'manual' } as const;
  const match = /^\/api\/v1\/imports\/(imp-[a-f0-9-]{36})(?:\/(confirm|search|image))?$/.exec(path);
  const id = match?.[1];
  if (!id) return null;
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
  let activeUploads = 0;
  async function match(query: string): Promise<ImportReview['match']> {
    if (!map) return { kind: 'map_unavailable' };
    try {
      const result = { places: await map.search(query.trim()) };
      if (!placeSearchValidator.check(result)) return { kind: 'map_unavailable' };
      const candidates = [...new Map(result.places.map((place) => [place.id, place])).values()];
      return { kind: 'results', candidates };
    } catch {
      return { kind: 'map_unavailable' };
    }
  }
  async function extract(image: VisionImage): Promise<ImportReview['extraction']> {
    if (!vision) return { kind: 'vision_unavailable' };
    try {
      const result = await vision(image);
      if (visualExtractionValidator.check(result)) return result;
    } catch {
      // The review stays available for manual lookup when the supplier fails.
    }
    return { kind: 'vision_unavailable' };
  }

  return async (input: {
    request: IncomingMessage;
    response: ServerResponse;
    route: NonNullable<ReturnType<typeof importRoute>>;
    userId: string;
    withUser: ReturnType<typeof createUserAccess>;
  }) => {
    const { request, response, route, userId, withUser } = input;
    switch (route.kind) {
      case 'wishlist':
        return send(response, 200, await withUser(userId, readWishlist));
      case 'review': {
        const { review } = await withUser(userId, (runtime) => readImport(runtime, route.id));
        return send(response, 200, review);
      }
      case 'image': {
        const { record } = await withUser(userId, (runtime) => readImport(runtime, route.id));
        if (!record.image_type) throw new HttpFault('IMPORT_NOT_FOUND');
        const data = await images.read(userId, route.id);
        response.setHeader('content-type', record.image_type);
        response.setHeader('content-security-policy', "default-src 'none'; sandbox");
        response.setHeader('cross-origin-resource-policy', 'same-origin');
        response.writeHead(200);
        return response.end(data);
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
          const extraction = await extract({ data: image.data, mimeType: image.mimeType });
          const review: ImportReview = {
            import_id: id,
            revision: 1,
            source: {
              kind: 'image',
              import_id: id,
              excerpt: extraction.kind === 'text' ? extraction.excerpt : null,
            },
            extraction,
            match:
              extraction.kind === 'text' || extraction.kind === 'guess'
                ? await match(extraction.name)
                : { kind: 'not_searched' },
          };
          await images.put(userId, id, image);
          await withUser(userId, (runtime) =>
            saveImport({ runtime, review, imageType: image.mimeType }),
          );
          return send(response, 201, review);
        } finally {
          activeUploads -= 1;
        }
      }
    }
  };
}

import {
  ALLOW_RETIRED_REMOVAL_HEADER,
  importBatchValidator,
  importBatchViewValidator,
  type ConfirmBatch,
} from '@nextstop/core';
import { readResponseJson, request, requestJson } from './api.js';

const batches = '/api/v1/import-batches';
const batchPath = (id: string) => `${batches}/${encodeURIComponent(id)}`;
const itemPath = (id: string, imageId: string) =>
  `${batchPath(id)}/items/${encodeURIComponent(imageId)}`;
const post = (body: unknown, headers?: Record<string, string>): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

export const batchImagePath = (id: string, imageId: string) => `${itemPath(id, imageId)}/image`;
export const getBatch = (id: string, signal: AbortSignal) =>
  requestJson(batchPath(id), {}, importBatchValidator.check, signal);
export const getBatchWithPendingRemovals = (id: string) =>
  requestJson(`${batchPath(id)}?include=pending_removals`, {}, importBatchViewValidator.check);
export function uploadBatch(files: readonly File[]) {
  const body = new FormData();
  for (const file of files) body.append('images', file);
  return requestJson(
    batches,
    { method: 'POST', body },
    importBatchValidator.check,
    undefined,
    60_000,
  );
}
type BatchItemRevision = { id: string; imageId: string; revision: number };

export async function removeBatchItem({ id, imageId, revision }: BatchItemRevision) {
  const response = await request(
    `${itemPath(id, imageId)}/remove`,
    post({ revision }, { [ALLOW_RETIRED_REMOVAL_HEADER]: '1' }),
  );
  return response.status === 204 ? null : readResponseJson(response, importBatchValidator.check);
}

export const editBatchItem = (
  input: BatchItemRevision & ({ action: 'search'; query: string } | { action: 'retry' | 'skip' }),
) =>
  requestJson(
    `${itemPath(input.id, input.imageId)}/${input.action}`,
    post(
      input.action === 'search'
        ? { revision: input.revision, query: input.query }
        : { revision: input.revision },
    ),
    importBatchValidator.check,
  );
export const saveBatchChoices = (id: string, input: ConfirmBatch) =>
  requestJson(`${batchPath(id)}/confirm`, post(input), importBatchValidator.check);

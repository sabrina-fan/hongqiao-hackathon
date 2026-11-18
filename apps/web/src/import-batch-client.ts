import { importBatchValidator, type ConfirmBatch } from '@nextstop/core';
import { requestJson } from './api.js';

const batches = '/api/v1/import-batches';
const batchPath = (id: string) => `${batches}/${encodeURIComponent(id)}`;
const itemPath = (id: string, imageId: string) =>
  `${batchPath(id)}/items/${encodeURIComponent(imageId)}`;
const post = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

export const batchImagePath = (id: string, imageId: string) => `${itemPath(id, imageId)}/image`;
export const getBatch = (id: string, signal?: AbortSignal) =>
  requestJson(batchPath(id), {}, importBatchValidator.check, signal);
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
export const editBatchItem = (
  input: { id: string; imageId: string; revision: number } & (
    | { action: 'search'; query: string }
    | { action: 'retry' | 'skip' | 'remove' }
  ),
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

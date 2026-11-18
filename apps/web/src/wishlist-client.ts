import {
  confirmImportValidator,
  importReviewValidator,
  wishlistPlaceValidator,
  wishlistValidator,
  type ConfirmImport,
} from '@nextstop/core';
import { ApiError, requestJson } from './api.js';

const imports = '/api/v1/imports';
const importPath = (id: string) => `${imports}/${encodeURIComponent(id)}`;
function post(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}
export const importImagePath = (id: string) => `${importPath(id)}/image`;
export const getWishlist = (signal?: AbortSignal) =>
  requestJson('/api/v1/wishlist', {}, wishlistValidator.check, signal);
export function searchImport(query: string, id?: string) {
  return requestJson(
    `${id ? importPath(id) : imports}/search`,
    post({ query }),
    importReviewValidator.check,
  );
}
export function confirmImport(id: string, selection: ConfirmImport) {
  if (!confirmImportValidator.check(selection))
    throw new ApiError('INVALID_REQUEST', '请选择地图候选。', 0);
  return requestJson(`${importPath(id)}/confirm`, post(selection), wishlistPlaceValidator.check);
}

import {
  confirmImportValidator,
  importReviewValidator,
  savedPlaceValidator,
  wishlistPlaceValidator,
  wishlistValidator,
  type ConfirmImport,
  type CorrectPlace,
  type EditWishlist,
  type WishlistPlace,
} from '@nextstop/core';
import { ApiError, request, requestJson } from './api.js';

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
const wishlist = '/api/v1/wishlist';
const savedPath = ({ provider, poi_id }: Pick<WishlistPlace, 'provider' | 'poi_id'>) =>
  `${wishlist}/${provider}/${encodeURIComponent(poi_id)}`;
export const getWishlist = (signal?: AbortSignal) =>
  requestJson(wishlist, {}, wishlistValidator.check, signal);
export const getSavedPlace = (key: Parameters<typeof savedPath>[0], signal?: AbortSignal) =>
  requestJson(savedPath(key), {}, savedPlaceValidator.check, signal);
export const editSavedPlace = (key: Parameters<typeof savedPath>[0], edit: EditWishlist) =>
  requestJson(savedPath(key), { ...post(edit), method: 'PATCH' }, savedPlaceValidator.check);
export const correctSavedPlace = (key: Parameters<typeof savedPath>[0], input: CorrectPlace) =>
  requestJson(`${savedPath(key)}/correction`, post(input), savedPlaceValidator.check);
export async function removeSavedPlace(key: Parameters<typeof savedPath>[0]) {
  await request(savedPath(key), { method: 'DELETE' });
}
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

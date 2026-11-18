import { anonymousDataValidator } from '@nextstop/core';
import { request, requestJson } from './api.js';
import { invalidateTripData } from './offline-trip.js';

const dataPath = '/api/v1/me/data';
export const readAnonymousData = (signal?: AbortSignal) =>
  requestJson(dataPath, {}, anonymousDataValidator.check, signal);

export type DeleteTarget =
  | { kind: 'all' }
  | { kind: 'trip'; id: string; label: string; exclusive: number; shared: number }
  | { kind: 'image'; id: string; label: string };

export async function deleteData(target: DeleteTarget) {
  const path =
    target.kind === 'all'
      ? dataPath
      : `/api/v1/${target.kind === 'trip' ? 'trips' : 'imports'}/${encodeURIComponent(target.id)}`;
  try {
    await request(path, { method: 'DELETE' });
  } finally {
    // The server may have committed even if the reply was lost. Never serve the affected cache offline after an attempt.
    if (target.kind !== 'image') invalidateTripData(target.kind === 'trip' ? target.id : null);
  }
}

export async function downloadData() {
  const response = await request('/api/v1/me/export', {});
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement('a');
  link.href = url;
  link.download = 'nextstop-data.json';
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

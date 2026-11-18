import {
  RETIRED_BATCH_REMOVALS_QUERY,
  settingsDataValidator,
  type SettingsData,
} from '@nextstop/core';
import { ApiError, request, requestJson } from './api.js';
import { removeBatchItem } from './import-batch-client.js';
import { invalidateTripData } from './offline-trip.js';

const dataPath = '/api/v1/me/data';
export const readSettingsData = (signal?: AbortSignal) =>
  requestJson(
    `${dataPath}?include=pending_deletions&${RETIRED_BATCH_REMOVALS_QUERY}=1`,
    {},
    settingsDataValidator.check,
    signal,
  );

export type DeleteTarget = NonNullable<SettingsData['pending_deletions']>[number] | { kind: 'all' };

export async function deleteData(target: DeleteTarget) {
  if (target.kind === 'batch_item') {
    await removeBatchItem({
      id: target.batch_id,
      imageId: target.import_id,
      revision: target.revision,
    });
    return;
  }
  const path =
    target.kind === 'all'
      ? dataPath
      : `/api/v1/${target.kind === 'trip' ? 'trips' : 'imports'}/${encodeURIComponent(target.id)}`;
  try {
    const response = await request(path, { method: 'DELETE' });
    if (response.status !== 204)
      throw new ApiError('INVALID_RESPONSE', '服务响应格式无效。', response.status);
  } finally {
    // The server may have committed even if the reply was lost. Never serve the affected cache offline after an attempt.
    if (target.kind !== 'source') invalidateTripData(target.kind === 'trip' ? target.id : null);
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

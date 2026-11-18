import {
  ERASE_BINDING_HEADER,
  ERASE_RECOVERY_HEADER,
  ERASE_RECOVERY_QUERY,
  RETIRED_BATCH_REMOVALS_QUERY,
  eraseBindingValidator,
  settingsViewValidator,
  type SettingsData,
} from '@nextstop/core';
import { ApiError, readResponseJson, readWithGuestSession, request } from './api.js';
import { removeBatchItem } from './import-batch-client.js';
import { invalidateTripData } from './offline-trip.js';

const dataPath = '/api/v1/me/data';
const settingsPath = `${dataPath}?include=pending_deletions&${RETIRED_BATCH_REMOVALS_QUERY}=1&${ERASE_RECOVERY_QUERY}=1`;
export const readSettingsData = (signal: AbortSignal) =>
  // A revoked cookie can read recovery status but cannot pass session initialization.
  readWithGuestSession(
    async () => {
      const response = await request(settingsPath, {}, signal);
      const binding = response.headers.get(ERASE_BINDING_HEADER);
      return {
        view: await readResponseJson(response, settingsViewValidator.check),
        eraseBinding: eraseBindingValidator.check(binding) ? binding : null,
      };
    },
    signal,
    { readFirst: true },
  );

export type DeleteTarget =
  | NonNullable<SettingsData['pending_deletions']>[number]
  | { kind: 'all'; eraseBinding: string; recoveryOnly: boolean };

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
  const headers =
    target.kind === 'all'
      ? {
          [ERASE_BINDING_HEADER]: target.eraseBinding,
          ...(target.recoveryOnly && { [ERASE_RECOVERY_HEADER]: '1' }),
        }
      : undefined;
  let confirmationExpired = false;
  try {
    const response = await request(path, { method: 'DELETE', ...(headers && { headers }) });
    if (response.status !== 204)
      throw new ApiError('INVALID_RESPONSE', '服务响应格式无效。', response.status);
  } catch (error) {
    if (target.kind === 'all' && error instanceof ApiError && error.code === 'SESSION_REQUIRED') {
      confirmationExpired = true;
      return 'confirmation-expired';
    }
    throw error;
  } finally {
    // A rejected confirmation did not touch the guest. Other failures may have committed.
    if (!confirmationExpired && target.kind !== 'source')
      invalidateTripData(target.kind === 'trip' ? target.id : null);
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

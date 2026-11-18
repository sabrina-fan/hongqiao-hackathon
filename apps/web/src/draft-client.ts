import {
  draftReadValidator,
  tripDetailValidator,
  tripDraftValidator,
  type DraftEdit,
  type DraftVersion,
} from '@nextstop/core';
import { requestJson } from './api.js';

const path = (id: string) => `/api/v1/trips/${encodeURIComponent(id)}/draft`;
const post = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});
const PLAN_TIMEOUT_MS = 30_000;

export const readDraft = (id: string, signal: AbortSignal) =>
  requestJson(path(id), {}, draftReadValidator.check, signal);
export const generateDraft = (id: string, revision: number) =>
  requestJson(path(id), post({ revision }), tripDraftValidator.check, undefined, PLAN_TIMEOUT_MS);
export const editDraft = (id: string, version: DraftVersion, edit: DraftEdit) =>
  requestJson(
    `${path(id)}/edit`,
    post({ ...version, edit }),
    tripDraftValidator.check,
    undefined,
    PLAN_TIMEOUT_MS,
  );
export const applyDraft = (id: string, version: DraftVersion) =>
  requestJson(`${path(id)}/apply`, post(version), tripDetailValidator.check);

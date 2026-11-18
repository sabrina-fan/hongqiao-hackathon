import { draftApplyValidator, draftEditValidator, draftGenerateValidator } from '@nextstop/core';
import type { IncomingMessage } from 'node:http';
import { readJson } from '../http.js';
import type { RadarMap } from '../radar/amap.js';
import { applyDraft, editDraft, generateDraft, getDraft, type RunForGuest } from './draft-store.js';

export function draftRoute(
  method: string | undefined,
  path: string,
  map: RadarMap | null | undefined,
  now: () => number,
) {
  const match = /^\/api\/v1\/trips\/([A-Za-z0-9_-]{1,100})\/draft(?:\/(edit|apply))?$/.exec(path);
  const id = match?.[1];
  if (!id) return null;
  const action = match[2];
  if (method === 'GET' && !action)
    return { status: 200, handle: (run: RunForGuest) => getDraft({ id, run, now }) };
  if (method !== 'POST') return null;
  return {
    status: 200,
    async handle(run: RunForGuest, request: IncomingMessage) {
      const context = { id, run, now, map };
      if (action === 'apply')
        return applyDraft(context, await readJson(request, draftApplyValidator.check));
      if (action === 'edit') {
        const { edit, ...version } = await readJson(request, draftEditValidator.check);
        return editDraft(context, version, edit);
      }
      const { revision } = await readJson(request, draftGenerateValidator.check);
      return generateDraft(context, revision);
    },
  };
}

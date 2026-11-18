import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  ERASE_BINDING_HEADER,
  ERASE_RECOVERY_HEADER,
  ERASE_RECOVERY_QUERY,
  RETIRED_BATCH_REMOVALS_QUERY,
  eraseBindingValidator,
  type SettingsView,
} from '@nextstop/core';
import type { createGuestSessions } from '../guest-session.js';
import { HttpFault, send } from '../http.js';
import { createImportImages } from '../imports/images.js';
import type { createUserAccess } from '../radar/user-access.js';
import { eraseSource, eraseTrip, exportData, readSettingsData } from './store.js';

type Route =
  | { kind: 'export' | 'read' }
  | { kind: 'erase'; recoveryOnly: boolean; binding: string | string[] | undefined }
  | { kind: 'settings'; includeRetiredBatchRemovals: boolean; includeEraseRecovery: boolean }
  | { kind: 'trip' | 'source'; id: string };

export function privacyRoute({ method, headers }: IncomingMessage, url: URL): Route | null {
  const path = url.pathname;
  if (method === 'GET' && path === '/api/v1/me/data') {
    if (url.searchParams.get('include') !== 'pending_deletions') return { kind: 'read' };
    return {
      kind: 'settings',
      includeRetiredBatchRemovals: url.searchParams.get(RETIRED_BATCH_REMOVALS_QUERY) === '1',
      includeEraseRecovery: url.searchParams.get(ERASE_RECOVERY_QUERY) === '1',
    };
  }
  if (method === 'GET' && path === '/api/v1/me/export') return { kind: 'export' };
  if (method !== 'DELETE') return null;
  if (path === '/api/v1/me/data')
    return {
      kind: 'erase',
      recoveryOnly: headers[ERASE_RECOVERY_HEADER] === '1',
      binding: headers[ERASE_BINDING_HEADER],
    };
  const source = /^\/api\/v1\/imports\/(imp-[a-f0-9-]{36})$/.exec(path)?.[1];
  if (source) return { kind: 'source', id: source };
  const trip = /^\/api\/v1\/trips\/([A-Za-z0-9_-]{1,100})$/.exec(path)?.[1];
  return trip ? { kind: 'trip', id: trip } : null;
}

export async function handlePrivacy({
  route,
  response,
  userId,
  dataDir,
  withUser,
  sessions,
}: {
  route: Route;
  response: ServerResponse;
  userId: string | null;
  dataDir: string;
  withUser: ReturnType<typeof createUserAccess>;
  sessions: Pick<ReturnType<typeof createGuestSessions>, 'clear' | 'eraseBinding'>;
}) {
  const images = createImportImages(dataDir);
  if (route.kind === 'erase') {
    // The request Cookie is shared across tabs, but the confirmation belongs to the guest read by Settings.
    if (
      !userId ||
      !eraseBindingValidator.check(route.binding) ||
      !timingSafeEqual(Buffer.from(route.binding), Buffer.from(sessions.eraseBinding(userId)))
    )
      throw new HttpFault('SESSION_REQUIRED');
    if (route.recoveryOnly && !(await withUser.isRevoked(userId)))
      throw new HttpFault('SESSION_REQUIRED');
    await withUser.erase(userId, () => images.removeAll(userId));
    response.setHeader('set-cookie', sessions.clear());
    return send(response, 204);
  }
  if (!userId) throw new HttpFault('SESSION_REQUIRED');
  switch (route.kind) {
    case 'read':
      return send(response, 200, await withUser(userId, exportData));
    case 'settings': {
      const settings = await withUser(userId, (runtime) =>
        readSettingsData(runtime, route.includeRetiredBatchRemovals),
      ).catch((error: unknown): SettingsView => {
        // withUser rejects a revoked guest inside the same queue used by erase, before opening SQLite.
        if (
          route.includeEraseRecovery &&
          error instanceof HttpFault &&
          error.code === 'SESSION_REQUIRED'
        )
          return { kind: 'erase_recovery' };
        throw error;
      });
      response.setHeader(ERASE_BINDING_HEADER, sessions.eraseBinding(userId));
      return send(response, 200, settings);
    }
    case 'export': {
      const data = await withUser(userId, exportData);
      response.setHeader('content-disposition', 'attachment; filename="nextstop-data.json"');
      response.writeHead(200);
      return response.end(JSON.stringify(data, null, 2));
    }
    case 'source':
    case 'trip': {
      await withUser(userId, (runtime) => {
        const remove = (id: string) => images.remove(userId, id);
        return route.kind === 'source'
          ? eraseSource(runtime, route.id, remove)
          : eraseTrip(runtime, route.id, remove, () => withUser.cancelTrip(userId, route.id));
      });
      return send(response, 204);
    }
  }
}

import type { ServerResponse } from 'node:http';
import { HttpFault, send } from '../http.js';
import { createImportImages } from '../imports/images.js';
import type { createUserAccess } from '../radar/user-access.js';
import { eraseSource, eraseTrip, exportData } from './store.js';

type Route = { kind: 'export' | 'read' | 'erase' } | { kind: 'trip' | 'source'; id: string };

export function privacyRoute(method: string | undefined, path: string): Route | null {
  if (method === 'GET' && path === '/api/v1/me/data') return { kind: 'read' };
  if (method === 'GET' && path === '/api/v1/me/export') return { kind: 'export' };
  if (method !== 'DELETE') return null;
  if (path === '/api/v1/me/data') return { kind: 'erase' };
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
  clearCookie,
}: {
  route: Route;
  response: ServerResponse;
  userId: string | null;
  dataDir: string;
  withUser: ReturnType<typeof createUserAccess>;
  clearCookie: () => string;
}) {
  const images = createImportImages(dataDir);
  if (route.kind === 'erase') {
    if (userId) await withUser.erase(userId, () => images.removeAll(userId));
    response.setHeader('set-cookie', clearCookie());
    return send(response, 204);
  }
  if (!userId) throw new HttpFault('SESSION_REQUIRED');
  switch (route.kind) {
    case 'read':
      return send(response, 200, await withUser(userId, exportData));
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

import { compile } from '@earendil-works/pi-schema';
import {
  acceptRadarValidator,
  IdentifierSchema,
  radarRequestValidator,
  type Capabilities,
} from '@nextstop/core';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createGuestSessions } from './guest-session.js';
import { checkPostOrigin, HttpFault, readJson, send, sendError } from './http.js';
import { createImportHandler, importRoute, type ImportVision } from './imports/http.js';
import type { RadarMap } from './radar/amap.js';
import { acceptRadar, createRadar, getRadar } from './radar/store.js';
import { createUserAccess } from './radar/user-access.js';

import { getTrip } from './trip/store.js';
import { tripRoute } from './trip/routes.js';

const identifier = compile(IdentifierSchema);
type Options = {
  dataDir: string;
  cookieSecret: string | null;
  map: RadarMap | null;
  vision?: ImportVision | null;
  secureCookie?: boolean;
  now?: () => number;
};

export function createApp(options?: Options) {
  const now = options?.now ?? Date.now;
  const map = options?.map;
  const sessions = options?.cookieSecret
    ? createGuestSessions(options.cookieSecret, options.secureCookie ?? false, now)
    : null;
  const withUser = options && sessions ? createUserAccess(options.dataDir) : null;
  const handleImport =
    options && createImportHandler({ dataDir: options.dataDir, map, vision: options.vision });
  const capabilities: Capabilities = {
    stage: sessions && map ? 'radar' : 'scaffold',
    radar: Boolean(sessions && map),
    imports: Boolean(sessions && map),
    trip_writes: Boolean(sessions),
    model_calls: Boolean(sessions && map && options?.vision),
  };
  async function handle(request: IncomingMessage, response: ServerResponse) {
    const url = URL.parse(request.url ?? '/', 'http://localhost');
    if (!url || !request.url?.startsWith('/') || request.url.startsWith('//'))
      throw new HttpFault('INVALID_REQUEST');
    const path = url.pathname;
    if (request.method === 'GET' && path === '/health/ready')
      return send(response, 200, { status: 'ok', service: 'nextstop', stage: capabilities.stage });
    if (request.method === 'GET' && path === '/health/capabilities')
      return send(response, 200, capabilities);
    if (!path.startsWith('/api/v1/')) throw new HttpFault('NOT_IMPLEMENTED');
    if (request.method === 'POST') checkPostOrigin(request);
    const createSession = request.method === 'POST' && path === '/api/v1/sessions';
    const search = request.method === 'GET' && path === '/api/v1/places';
    const create = request.method === 'POST' && path === '/api/v1/radar/sessions';
    const trip = request.method === 'GET' && path === '/api/v1/trip';
    const manageTrip = tripRoute(request.method, path);
    const member = /^\/api\/v1\/radar\/sessions\/([A-Za-z0-9_-]{1,100})(\/accept)?$/.exec(path);
    const sessionId = member?.[1];
    const accept = Boolean(member?.[2]) && request.method === 'POST';
    const view = sessionId && !member?.[2] && request.method === 'GET';
    const imports = importRoute(request.method, path);
    if (!(createSession || search || create || trip || manageTrip || accept || view || imports))
      throw new HttpFault('NOT_IMPLEMENTED');
    if (!sessions || !withUser) throw new HttpFault('RADAR_NOT_CONFIGURED');
    const userId = sessions.read(request.headers.cookie);
    if (createSession) {
      if (!userId) response.setHeader('set-cookie', sessions.issue());
      return send(response, 204);
    }
    if (!userId) throw new HttpFault('SESSION_REQUIRED');
    if (manageTrip)
      return send(
        response,
        manageTrip.status,
        await manageTrip.handle((run) => withUser(userId, run), request),
      );
    if (imports && handleImport)
      return handleImport({ request, response, route: imports, userId, withUser });
    if (search || create) {
      if (!map) throw new HttpFault('RADAR_NOT_CONFIGURED');
      if (search) {
        const q = url.searchParams.get('q')?.trim();
        if (!q || q.length > 100) throw new HttpFault('INVALID_REQUEST');
        return send(response, 200, { places: await map.search(q) });
      }
      const input = await readJson(request, radarRequestValidator.check);
      const startedAt = now();
      const evidence = await map.walk(input);
      return send(
        response,
        201,
        await withUser(userId, (runtime) =>
          createRadar({ runtime, request: input, evidence, now, startedAt }),
        ),
      );
    }
    if (trip) return send(response, 200, await withUser(userId, (runtime) => getTrip({ runtime })));
    if (sessionId && accept) {
      const key = request.headers['idempotency-key'];
      if (!identifier.check(key)) throw new HttpFault('INVALID_REQUEST');
      const input = await readJson(request, acceptRadarValidator.check);
      return send(
        response,
        200,
        await withUser(userId, (runtime) => acceptRadar({ runtime, sessionId, input, key, now })),
      );
    }
    if (sessionId && view)
      return send(
        response,
        200,
        await withUser(userId, (runtime) => getRadar({ runtime, sessionId, now })),
      );
    throw new HttpFault('NOT_IMPLEMENTED');
  }
  return createServer((request, response) => {
    response.setHeader('content-type', 'application/json; charset=utf-8');
    response.setHeader('cache-control', 'no-store');
    response.setHeader('x-content-type-options', 'nosniff');
    void handle(request, response).catch((error: unknown) => sendError(response, error));
  });
}

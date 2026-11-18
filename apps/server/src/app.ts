import { compile } from '@earendil-works/pi-schema';
import {
  acceptRadarValidator,
  IdentifierSchema,
  radarRequestValidator,
  recheckRadarValidator,
  rejectRadarValidator,
  type Capabilities,
} from '@nextstop/core';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { RadarModel } from '@nextstop/model-gateway';
import { createGuestSessions } from './guest-session.js';
import { checkPostOrigin, HttpFault, readJson, send, sendError } from './http.js';
import { createImportHandler, importRoute, type ImportVision } from './imports/http.js';
import { handlePrivacy, privacyRoute } from './privacy/http.js';
import type { RadarMap } from './radar/amap.js';
import { acceptRadar, getRadar, getRadarHistory } from './radar/store.js';
import { radarAcceptanceRoute } from './radar/acceptance-http.js';
import { radarFeedbackRoute } from './radar/feedback-http.js';
import { getRadarContext, proposeRadar } from './radar/propose.js';
import { recheckRecall, rejectRecall } from './radar/recall-store.js';
import { createUserAccess } from './radar/user-access.js';

import { draftRoute } from './trip/draft-routes.js';
import { getTrip } from './trip/store.js';
import { tripRoute } from './trip/routes.js';
import { handleWishlist, wishlistRoute } from './wishlist/http.js';

const identifier = compile(IdentifierSchema);
type Options = {
  dataDir: string;
  cookieSecret: string | null;
  map: RadarMap | null;
  radarModel?: RadarModel | null;
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
  const withUser =
    options && sessions ? createUserAccess(options.dataDir, options.radarModel) : null;
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
    if (request.method === 'POST' || request.method === 'PATCH' || request.method === 'DELETE')
      checkPostOrigin(request);
    const createSession = request.method === 'POST' && path === '/api/v1/sessions';
    const search = request.method === 'GET' && path === '/api/v1/places';
    const create = request.method === 'POST' && path === '/api/v1/radar/sessions';
    const context = request.method === 'GET' && path === '/api/v1/radar/context';
    const history = request.method === 'GET' && path === '/api/v1/radar/history';
    const trip = request.method === 'GET' && path === '/api/v1/trip';
    const manageTrip =
      draftRoute(request.method, path, map, now) ?? tripRoute(request.method, path);
    const acceptance = radarAcceptanceRoute(request, path);
    const feedback = radarFeedbackRoute(request.method, path, now);
    const member =
      /^\/api\/v1\/radar\/sessions\/([A-Za-z0-9_-]{1,100})(\/(?:accept|reject|recheck))?$/.exec(
        path,
      );
    const sessionId = member?.[1];
    const accept = member?.[2] === '/accept' && request.method === 'POST';
    const reject = member?.[2] === '/reject' && request.method === 'POST';
    const recheck = member?.[2] === '/recheck' && request.method === 'POST';
    const view = sessionId && !member?.[2] && request.method === 'GET';
    const imports = importRoute(request.method, url);
    const wishlist = wishlistRoute(request.method, path);
    const privacy = privacyRoute(request, url);
    if (
      !(
        createSession ||
        search ||
        create ||
        context ||
        history ||
        trip ||
        manageTrip ||
        accept ||
        reject ||
        recheck ||
        acceptance ||
        feedback ||
        view ||
        imports ||
        wishlist ||
        privacy
      )
    )
      throw new HttpFault('NOT_IMPLEMENTED');
    if (!options || !sessions || !withUser) throw new HttpFault('RADAR_NOT_CONFIGURED');
    const userId = sessions.read(request.headers.cookie);
    if (privacy)
      return handlePrivacy({
        route: privacy,
        response,
        userId,
        withUser,
        dataDir: options.dataDir,
        clearCookie: sessions.clear,
      });
    if (userId && (await withUser.isRevoked(userId))) throw new HttpFault('SESSION_REQUIRED');
    if (createSession) {
      if (!userId) {
        response.setHeader('set-cookie', sessions.issue());
        response.setHeader('x-nextstop-new-session', '1');
      }
      return send(response, 204);
    }
    if (!userId) throw new HttpFault('SESSION_REQUIRED');
    if (manageTrip)
      return send(
        response,
        manageTrip.status,
        await manageTrip.handle((run) => withUser(userId, run), request),
      );
    if (wishlist)
      return handleWishlist({
        request,
        response,
        route: wishlist,
        params: url.searchParams,
        map,
        withUser: (run) => withUser(userId, run),
      });
    if (imports && handleImport)
      return handleImport({ request, response, route: imports, userId, withUser });
    if (context)
      return send(
        response,
        200,
        await withUser(userId, (runtime) => getRadarContext(runtime, now())),
      );
    if (history)
      return send(
        response,
        200,
        await withUser(userId, (runtime) => getRadarHistory(runtime, now())),
      );
    if (search || create) {
      if (!map) throw new HttpFault('RADAR_NOT_CONFIGURED');
      if (search) {
        const q = url.searchParams.get('q')?.trim();
        if (!q || q.length > 100) throw new HttpFault('INVALID_REQUEST');
        return send(response, 200, { places: await map.search(q) });
      }
      const input = await readJson(request, radarRequestValidator.check);
      return send(
        response,
        201,
        await withUser.task(userId, (signal, bindTrip) =>
          proposeRadar({
            request: input,
            map,
            model: options.radarModel ?? null,
            now,
            signal,
            bindTrip,
            withRuntime: (run) => withUser(userId, run),
          }),
        ),
      );
    }
    if (trip) return send(response, 200, await withUser(userId, (runtime) => getTrip({ runtime })));
    if (acceptance) return send(response, 200, await withUser(userId, acceptance));
    if (feedback) return send(response, 200, await withUser(userId, feedback));
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
    if (sessionId && (reject || recheck)) {
      if (!map) throw new HttpFault('RADAR_NOT_CONFIGURED');
      if (reject) {
        const input = await readJson(request, rejectRadarValidator.check);
        return send(
          response,
          200,
          await withUser(userId, (runtime) =>
            rejectRecall({ runtime, sessionId, input, map, now }),
          ),
        );
      }
      const { binding } = await readJson(request, recheckRadarValidator.check);
      return send(
        response,
        200,
        await withUser(userId, (runtime) =>
          recheckRecall({ runtime, sessionId, binding, map, now }),
        ),
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

import { arr, compile, int, lit, obj, opt, str, union } from '@earendil-works/pi-schema';
import { IdentifierSchema } from '@nextstop/core';
import type { PlaceOption, RadarRequest } from '@nextstop/core';
import { setTimeout as delay } from 'node:timers/promises';
import type { WalkingEvidence } from './evidence.js';

export type RadarMap = {
  search(query: string): Promise<PlaceOption[]>;
  walk(request: Pick<RadarRequest, 'origin_id' | 'poi_id'>): Promise<WalkingEvidence>;
};

export class MapFault extends Error {
  constructor(readonly code: 'MAP_UNAVAILABLE' | 'MAP_RATE_LIMITED' | 'PLACE_NOT_FOUND') {
    super(code);
  }
}

const envelope = compile(obj({ status: str(), info: str() }, { open: true }));
const placeFields = {
  id: IdentifierSchema,
  name: str({ minLength: 1, maxLength: 200 }),
  address: opt(union([str({ maxLength: 500 }), arr(str(), { maxItems: 0 })])),
};
const places = compile(
  obj({ pois: arr(obj(placeFields, { open: true }), { maxItems: 10 }) }, { open: true }),
);
const details = compile(
  obj(
    { pois: arr(obj({ ...placeFields, location: str() }, { open: true }), { maxItems: 2 }) },
    { open: true },
  ),
);
const wholeNumber = union([
  str({ pattern: '^\\d{1,12}$' }),
  int({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
]);
const route = compile(
  obj(
    {
      results: arr(
        obj(
          {
            origin_id: lit('1'),
            dest_id: lit('1'),
            info: lit('OK'),
            distance: wholeNumber,
            duration: wholeNumber,
          },
          { open: true },
        ),
        { minItems: 1, maxItems: 1 },
      ),
    },
    { open: true },
  ),
);

function toOption(row: { id: string; name: string; address?: string | string[] }): PlaceOption {
  return {
    id: row.id,
    name: row.name,
    address: typeof row.address === 'string' ? row.address : '',
  };
}

type Gcj02 = string & { readonly __coord: 'gcj02' };
function isGcj02(point: string): point is Gcj02 {
  if (!/^-?\d{1,3}(?:\.\d+)?,-?\d{1,2}(?:\.\d+)?$/.test(point)) return false;
  const [lng, lat] = point.split(',').map(Number);
  return lng !== undefined && lat !== undefined && Math.abs(lng) <= 180 && Math.abs(lat) <= 90;
}

export function createAmap({
  key,
  fetcher = fetch,
  now = Date.now,
}: {
  key: string;
  fetcher?: typeof fetch;
  now?: () => number;
}): RadarMap {
  let nextSlot = 0;
  async function read(
    path: string,
    params: Record<string, string>,
    signal: AbortSignal,
  ): Promise<unknown> {
    // Share the key's QPS budget across searches, routes and retries. Shed a backlog quickly.
    const current = performance.now();
    const slot = Math.max(current, nextSlot);
    if (slot - current > 1000) throw new MapFault('MAP_RATE_LIMITED');
    nextSlot = slot + 250;
    if (slot > current) await delay(slot - current, undefined, { signal });
    const url = new URL(path, 'https://restapi.amap.com');
    url.search = new URLSearchParams({ ...params, key }).toString();
    const response = await fetcher(url, { redirect: 'error', signal });
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      throw new MapFault(response.status === 429 ? 'MAP_RATE_LIMITED' : 'MAP_UNAVAILABLE');
    }
    const body: unknown = await response.json();
    if (!envelope.check(body)) throw new MapFault('MAP_UNAVAILABLE');
    if (body.status !== '1' || body.info !== 'OK') {
      if (/QPS|QUOTA|DAILY_QUERY_OVER_LIMIT|ACCESS_TOO_FREQUENT/.test(body.info))
        throw new MapFault('MAP_RATE_LIMITED');
      throw new MapFault('MAP_UNAVAILABLE');
    }
    return body;
  }
  async function request(path: string, params: Record<string, string>, signal: AbortSignal) {
    try {
      try {
        return await read(path, params, signal);
      } catch (error) {
        if (!(error instanceof MapFault) || error.code !== 'MAP_RATE_LIMITED') throw error;
        await delay(1000, undefined, { signal });
        return await read(path, params, signal);
      }
    } catch (error) {
      // Transport errors can include the complete request URL (including the key).
      throw error instanceof MapFault ? error : new MapFault('MAP_UNAVAILABLE');
    }
  }
  function walkingRoute(origins: Gcj02, destination: Gcj02, signal: AbortSignal) {
    return request('/v3/distance', { origins, destination, type: '3' }, signal);
  }
  return {
    async search(query) {
      const body = await request(
        '/v5/place/text',
        { keywords: query, region: '苏州', city_limit: 'true', page_size: '10' },
        AbortSignal.timeout(6500),
      );
      if (!places.check(body)) throw new MapFault('MAP_UNAVAILABLE');
      return body.pois.map(toOption);
    },
    async walk({ origin_id, poi_id }) {
      const signal = AbortSignal.timeout(6500);
      const ids = Array.from(new Set([origin_id, poi_id]));
      const body = await request('/v5/place/detail', { id: ids.join('|') }, signal);
      if (!details.check(body)) throw new MapFault('MAP_UNAVAILABLE');
      if (
        body.pois.some((poi) => !ids.includes(poi.id)) ||
        new Set(body.pois.map((poi) => poi.id)).size !== body.pois.length
      )
        throw new MapFault('MAP_UNAVAILABLE');
      const origin = body.pois.find((poi) => poi.id === origin_id);
      const destination = body.pois.find((poi) => poi.id === poi_id);
      if (!origin || !destination) throw new MapFault('PLACE_NOT_FOUND');
      if (!isGcj02(origin.location) || !isGcj02(destination.location))
        throw new MapFault('MAP_UNAVAILABLE');
      const result = await walkingRoute(origin.location, destination.location, signal);
      if (!route.check(result) || !result.results[0]) throw new MapFault('MAP_UNAVAILABLE');
      const leg = result.results[0];
      return {
        origin: toOption(origin),
        destination: toOption(destination),
        distance_m: Number(leg.distance),
        travel_min: Math.ceil(Number(leg.duration) / 60),
        fetched_at: new Date(now()).toISOString(),
      };
    },
  };
}

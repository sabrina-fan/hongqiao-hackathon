import { arr, compile, int, lit, obj, opt, str, union } from '@earendil-works/pi-schema';
import {
  IdentifierSchema,
  liveOriginId,
  type FixedStop,
  type PlaceOption,
  type RadarRequest,
  type RoutePoint,
} from '@nextstop/core';
import { setTimeout as delay } from 'node:timers/promises';
import type { WalkingEvidence } from './evidence.js';

export type RadarMap = {
  search(query: string): Promise<PlaceOption[]>;
  walk(
    request: Pick<RadarRequest, 'poi_id'> &
      (
        | { origin_id: string }
        | { position: Extract<RadarRequest, { position: unknown }>['position'] }
      ),
    signal?: AbortSignal,
  ): Promise<WalkingEvidence>;
  walkToFixed(
    input: { candidate: WalkingEvidence; fixed: FixedStop },
    signal?: AbortSignal,
  ): Promise<WalkingEvidence>;
};

export class MapFault extends Error {
  constructor(
    readonly code:
      | 'MAP_UNAVAILABLE'
      | 'MAP_RATE_LIMITED'
      | 'PLACE_NOT_FOUND'
      | 'FIXED_LOCATION_UNRESOLVED',
  ) {
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

const converted = compile(obj({ locations: str() }, { open: true }));
const geocodes = compile(
  obj(
    { geocodes: arr(obj({ location: str(), level: str(), adcode: str() }, { open: true })) },
    { open: true },
  ),
);

function amapPoint(point: string): RoutePoint {
  if (!/^-?\d{1,3}(?:\.\d+)?,-?\d{1,2}(?:\.\d+)?$/.test(point))
    throw new MapFault('MAP_UNAVAILABLE');
  const [longitude, latitude] = point.split(',').map(Number);
  if (
    longitude === undefined ||
    latitude === undefined ||
    Math.abs(longitude) > 180 ||
    Math.abs(latitude) > 90
  )
    throw new MapFault('MAP_UNAVAILABLE');
  return { system: 'gcj02', longitude, latitude };
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
  const pointQuery = ({ longitude, latitude }: RoutePoint) => `${longitude},${latitude}`;
  async function routeBetween(
    origin: PlaceOption,
    destination: PlaceOption,
    markers: NonNullable<WalkingEvidence['markers']>,
    signal: AbortSignal,
  ): Promise<WalkingEvidence> {
    const result = await request(
      '/v3/distance',
      {
        origins: pointQuery(markers.origin),
        destination: pointQuery(markers.destination),
        type: '3',
      },
      signal,
    );
    if (!route.check(result) || !result.results[0]) throw new MapFault('MAP_UNAVAILABLE');
    const leg = result.results[0];
    return {
      origin,
      destination,
      markers,
      distance_m: Number(leg.distance),
      travel_min: Math.ceil(Number(leg.duration) / 60),
      fetched_at: new Date(now()).toISOString(),
    };
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
    async walk(input, signal = AbortSignal.timeout(6500)) {
      const ids = [
        ...new Set('origin_id' in input ? [input.origin_id, input.poi_id] : [input.poi_id]),
      ];
      const body = await request('/v5/place/detail', { id: ids.join('|') }, signal);
      if (!details.check(body)) throw new MapFault('MAP_UNAVAILABLE');
      if (
        body.pois.some((poi) => !ids.includes(poi.id)) ||
        new Set(body.pois.map((poi) => poi.id)).size !== body.pois.length
      )
        throw new MapFault('MAP_UNAVAILABLE');
      const destination = body.pois.find((poi) => poi.id === input.poi_id);
      if (!destination) throw new MapFault('PLACE_NOT_FOUND');
      const destinationPoint = amapPoint(destination.location);
      if ('position' in input) {
        const { longitude, latitude } = input.position;
        const result = await request(
          '/v3/assistant/coordinate/convert',
          {
            locations: `${longitude},${latitude}`,
            coordsys: 'gps',
          },
          signal,
        );
        if (!converted.check(result)) throw new MapFault('MAP_UNAVAILABLE');
        return routeBetween(
          { id: liveOriginId, name: '我的当前位置', address: '' },
          toOption(destination),
          { origin: amapPoint(result.locations), destination: destinationPoint },
          signal,
        );
      }
      const origin = body.pois.find((poi) => poi.id === input.origin_id);
      if (!origin) throw new MapFault('PLACE_NOT_FOUND');
      return routeBetween(
        toOption(origin),
        toOption(destination),
        {
          origin: amapPoint(origin.location),
          destination: destinationPoint,
        },
        signal,
      );
    },
    async walkToFixed({ candidate, fixed }, signal = AbortSignal.timeout(6500)) {
      if (!candidate.markers) throw new MapFault('MAP_UNAVAILABLE');
      const body = await request(
        '/v3/geocode/geo',
        { address: fixed.address, city: '320500' },
        signal,
      );
      if (!geocodes.check(body)) throw new MapFault('MAP_UNAVAILABLE');
      const match = body.geocodes[0];
      if (
        body.geocodes.length !== 1 ||
        !match ||
        !/^3205\d{2}$/.test(match.adcode) ||
        !['门牌号', '兴趣点'].includes(match.level)
      )
        throw new MapFault('FIXED_LOCATION_UNRESOLVED');
      return routeBetween(
        candidate.destination,
        {
          id: fixed.arrangement_id,
          name: fixed.name,
          address: fixed.address,
        },
        { origin: candidate.markers.destination, destination: amapPoint(match.location) },
        signal,
      );
    },
  };
}

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
import { bookingEvidence, type readBookingPolicy } from './booking-policy.js';
import type { WalkingEvidence } from './evidence.js';

export type RadarOrigin =
  | { origin_id: string }
  | { position: Extract<RadarRequest, { position: unknown }>['position'] };
export type LocatedOrigin = { place: PlaceOption; point: RoutePoint };
export type RadarMap = {
  search(query: string, signal?: AbortSignal): Promise<PlaceOption[]>;
  resolveOrigin?(origin: RadarOrigin, signal: AbortSignal): Promise<LocatedOrigin>;
  nearby?(origin: LocatedOrigin, signal: AbortSignal): Promise<PlaceOption[]>;
  walk(
    request: RadarOrigin & { poi_id: string },
    signal?: AbortSignal,
    origin?: LocatedOrigin,
  ): Promise<WalkingEvidence>;
  walkToFixed(
    input: { candidate: WalkingEvidence; fixed: FixedStop },
    signal?: AbortSignal,
  ): Promise<WalkingEvidence>;
  walkToAddress?(
    input: { origin_id: string; address: string },
    signal?: AbortSignal,
  ): Promise<WalkingEvidence>;
  walkFromAddress?(
    input: { address: string; poi_id: string },
    signal?: AbortSignal,
  ): Promise<WalkingEvidence>;
};

export class MapFault extends Error {
  constructor(
    readonly code:
      | 'MAP_UNAVAILABLE'
      | 'MAP_RATE_LIMITED'
      | 'PLACE_NOT_FOUND'
      | 'ROUTE_UNVERIFIED'
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
const optionalBusinessText = (maxLength: number) =>
  opt(union([str({ maxLength }), arr(str(), { maxItems: 0 })]));
const details = compile(
  obj(
    {
      pois: arr(
        obj(
          {
            ...placeFields,
            location: str(),
            typecode: optionalBusinessText(80),
            business: opt(
              union([
                obj(
                  { opentime_today: optionalBusinessText(200), cost: optionalBusinessText(80) },
                  { open: true },
                ),
                arr(str(), { maxItems: 0 }),
              ]),
            ),
          },
          { open: true },
        ),
        { maxItems: 2 },
      ),
    },
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
            info: opt(lit('OK')),
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

const unavailableRoute = compile(
  obj(
    {
      results: arr(
        obj(
          { origin_id: lit('1'), dest_id: lit('1'), info: str({ minLength: 1 }) },
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
    {
      geocodes: arr(
        obj(
          {
            location: str(),
            level: str(),
            adcode: str(),
            formatted_address: optionalBusinessText(500),
          },
          { open: true },
        ),
      ),
    },
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
  bookingPolicy,
}: {
  key: string;
  fetcher?: typeof fetch;
  now?: () => number;
  bookingPolicy?: Awaited<ReturnType<typeof readBookingPolicy>>;
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
    if (unavailableRoute.check(result) && result.results.some(({ info }) => info !== 'OK'))
      throw new MapFault('ROUTE_UNVERIFIED');
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
  async function detail(ids: string[], signal: AbortSignal) {
    const body = await request(
      '/v5/place/detail',
      { id: ids.join('|'), show_fields: 'business' },
      signal,
    );
    if (
      !details.check(body) ||
      body.pois.some((poi) => !ids.includes(poi.id)) ||
      new Set(body.pois.map((poi) => poi.id)).size !== body.pois.length
    )
      throw new MapFault('MAP_UNAVAILABLE');
    return body.pois;
  }
  async function resolveOrigin(input: RadarOrigin, signal: AbortSignal): Promise<LocatedOrigin> {
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
      return {
        place: { id: liveOriginId, name: '我的当前位置', address: '' },
        point: amapPoint(result.locations),
      };
    }
    const [origin] = await detail([input.origin_id], signal);
    if (!origin) throw new MapFault('PLACE_NOT_FOUND');
    return { place: toOption(origin), point: amapPoint(origin.location) };
  }
  async function geocodePoint(address: string, signal: AbortSignal): Promise<RoutePoint> {
    const body = await request('/v3/geocode/geo', { address, city: '320500' }, signal);
    if (!geocodes.check(body)) throw new MapFault('MAP_UNAVAILABLE');
    const rows = body.geocodes;
    const single = rows.length === 1 ? rows[0] : undefined;
    let match = single && ['门牌号', '兴趣点'].includes(single.level) ? single : undefined;
    if (rows.length === 2) {
      const entrance = rows.find(({ level }) => level === '门址');
      const streetNumber = rows.find(({ level }) => level === '门牌号');
      // Amap may return a distinct entrance point alongside the same street number.
      if (
        typeof entrance?.formatted_address === 'string' &&
        entrance.formatted_address.trim() &&
        entrance.formatted_address === streetNumber?.formatted_address &&
        entrance.adcode === streetNumber.adcode
      )
        match = entrance;
    }
    if (!match || !/^3205\d{2}$/.test(match.adcode))
      throw new MapFault('FIXED_LOCATION_UNRESOLVED');
    return amapPoint(match.location);
  }
  return {
    resolveOrigin,
    async nearby({ point }, signal) {
      const body = await request(
        '/v5/place/around',
        {
          location: pointQuery(point),
          radius: '2000',
          page_size: '8',
          types: '050000|080000|110000|140000',
        },
        signal,
      );
      if (!places.check(body)) throw new MapFault('MAP_UNAVAILABLE');
      return body.pois.map(toOption);
    },
    async search(query, signal) {
      const budget = AbortSignal.timeout(6500);
      const body = await request(
        '/v5/place/text',
        { keywords: query, region: '苏州', city_limit: 'true', page_size: '10' },
        signal ? AbortSignal.any([signal, budget]) : budget,
      );
      if (!places.check(body)) throw new MapFault('MAP_UNAVAILABLE');
      return body.pois.map(toOption);
    },
    async walk(input, signal = AbortSignal.timeout(6500), resolved) {
      const ids = [
        ...new Set(
          !resolved && 'origin_id' in input ? [input.origin_id, input.poi_id] : [input.poi_id],
        ),
      ];
      const pois = await detail(ids, signal);
      const destination = pois.find((poi) => poi.id === input.poi_id);
      if (!destination) throw new MapFault('PLACE_NOT_FOUND');
      const originRow = 'origin_id' in input && pois.find((poi) => poi.id === input.origin_id);
      const origin =
        resolved ??
        (originRow
          ? { place: toOption(originRow), point: amapPoint(originRow.location) }
          : await resolveOrigin(input, signal));
      const evidence = await routeBetween(
        origin.place,
        toOption(destination),
        {
          origin: origin.point,
          destination: amapPoint(destination.location),
        },
        signal,
      );
      const business = Array.isArray(destination.business) ? undefined : destination.business;
      const opening =
        typeof business?.opentime_today === 'string' ? business.opentime_today.trim() : '';
      const price = typeof business?.cost === 'string' ? business.cost.trim() : '';
      const category =
        typeof destination.typecode === 'string'
          ? /^\d{2}/.exec(destination.typecode)?.[0]
          : undefined;
      const booking = bookingEvidence(
        bookingPolicy?.get(destination.id),
        Date.parse(evidence.fetched_at),
      );
      return {
        ...evidence,
        ...(opening || price || booking || category
          ? {
              facts: {
                ...(opening ? { opening: { today: opening, status: 'verified' } } : {}),
                ...(price ? { price: { text: price, status: 'estimated' } } : {}),
                ...(booking ? { booking } : {}),
                ...(category ? { category } : {}),
              },
            }
          : {}),
      };
    },
    async walkToFixed({ candidate, fixed }, signal = AbortSignal.timeout(6500)) {
      if (!candidate.markers) throw new MapFault('MAP_UNAVAILABLE');
      return routeBetween(
        candidate.destination,
        {
          id: fixed.arrangement_id,
          name: fixed.name,
          address: fixed.address,
        },
        {
          origin: candidate.markers.destination,
          destination: await geocodePoint(fixed.address, signal),
        },
        signal,
      );
    },
    async walkToAddress({ origin_id, address }, signal = AbortSignal.timeout(6500)) {
      const [origin] = await detail([origin_id], signal);
      if (!origin) throw new MapFault('PLACE_NOT_FOUND');
      return routeBetween(
        toOption(origin),
        { id: address, name: address, address },
        {
          origin: amapPoint(origin.location),
          destination: await geocodePoint(address, signal),
        },
        signal,
      );
    },
    async walkFromAddress({ address, poi_id }, signal = AbortSignal.timeout(6500)) {
      const [destination] = await detail([poi_id], signal);
      if (!destination) throw new MapFault('PLACE_NOT_FOUND');
      return routeBetween(
        { id: address, name: address, address },
        toOption(destination),
        {
          origin: await geocodePoint(address, signal),
          destination: amapPoint(destination.location),
        },
        signal,
      );
    },
  };
}

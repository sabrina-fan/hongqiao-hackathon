import type { RadarMap } from '../radar/amap.js';
import { MapFault } from '../radar/amap.js';
import type { WalkMinutes } from './draft-plan.js';

const WALK_VALIDITY_MS = 30 * 60_000;
const MAX_LOOKUPS = 14;
const normalizeAddress = (address: string) => address.replace(/\s+/g, '');
const usableAddress = (address: string | undefined) =>
  address?.trim() && normalizeAddress(address).length <= 100 ? address.trim() : null;

export function draftWalking(map: RadarMap | null | undefined, startedAt: number) {
  let expiresAt = startedAt + WALK_VALIDITY_MS;
  let lookups = 0;
  const routes = new Map<string, number | null>();

  function remember(key: string, leg: { travel_min: number; fetched_at: string } | null) {
    if (!leg) {
      routes.set(key, null);
      return null;
    }
    if (!Number.isSafeInteger(leg.travel_min) || leg.travel_min < 0) return null;
    const validUntil = Date.parse(leg.fetched_at) + WALK_VALIDITY_MS;
    if (!Number.isFinite(validUntil) || validUntil <= startedAt) {
      routes.set(key, null);
      return null;
    }
    expiresAt = Math.min(expiresAt, validUntil);
    routes.set(key, leg.travel_min);
    return leg.travel_min;
  }

  const walk: WalkMinutes = async (from, to) => {
    if (!map) return null;
    const fromAddress = from.poi_id ? null : usableAddress(from.address);
    const toAddress = to.poi_id ? null : usableAddress(to.address);
    if (!from.poi_id && !fromAddress) return null;
    if (!to.poi_id && !toAddress) return null;
    if (!from.poi_id && !to.poi_id) return null;

    const key = JSON.stringify([from.poi_id ?? fromAddress, to.poi_id ?? toAddress]);
    const known = routes.get(key);
    if (known !== undefined) return known;
    if (lookups >= MAX_LOOKUPS) return null;
    lookups++;
    try {
      // A fixed address is located by geocoding, the same way radar verifies fixed stops.
      if (from.poi_id && toAddress && map.walkToAddress)
        return remember(
          key,
          await map.walkToAddress({ origin_id: from.poi_id, address: toAddress }),
        );
      if (fromAddress && to.poi_id && map.walkFromAddress)
        return remember(
          key,
          await map.walkFromAddress({ address: fromAddress, poi_id: to.poi_id }),
        );
      if (!from.poi_id || !to.poi_id) return null;
      if (from.poi_id === to.poi_id) return 0;
      return remember(key, await map.walk({ origin_id: from.poi_id, poi_id: to.poi_id }));
    } catch (error) {
      if (
        error instanceof MapFault &&
        (error.code === 'PLACE_NOT_FOUND' || error.code === 'FIXED_LOCATION_UNRESOLVED')
      ) {
        routes.set(key, null);
        return null;
      }
      throw error;
    }
  };
  return { walk, expiresAt: () => expiresAt };
}

import type { RadarMap } from '../radar/amap.js';
import { MapFault } from '../radar/amap.js';
import type { WalkMinutes } from './draft-plan.js';

const WALK_VALIDITY_MS = 30 * 60_000;
const MAX_LOOKUPS = 14;
const normalizeAddress = (address: string) => address.replace(/\s+/g, '');

export function draftWalking(map: RadarMap | null | undefined, startedAt: number) {
  let expiresAt = startedAt + WALK_VALIDITY_MS;
  let lookups = 0;
  const anchorIds = new Map<string, string | null>();
  const routes = new Map<string, number | null>();

  async function resolveId(stop: Parameters<WalkMinutes>[0]): Promise<string | null> {
    if (stop.poi_id) return stop.poi_id;
    const address = normalizeAddress(stop.address);
    const key = JSON.stringify([stop.name, address]);
    const known = anchorIds.get(key);
    if (known !== undefined) return known;
    if (!map || !address || address.length > 100 || lookups >= MAX_LOOKUPS) return null;
    lookups++;
    const places = await map.search(stop.address.trim());
    const matching = places.filter((place) => normalizeAddress(place.address) === address);
    const exact = matching.filter((place) => place.name === stop.name);
    const resolved =
      exact.length === 1 ? exact[0]?.id : matching.length === 1 ? matching[0]?.id : null;
    const id = resolved ?? null;
    anchorIds.set(key, id);
    return id;
  }

  const walk: WalkMinutes = async (from, to) => {
    if (!map) return null;
    const origin_id = await resolveId(from);
    const poi_id = await resolveId(to);
    if (!origin_id || !poi_id) return null;
    if (origin_id === poi_id) return 0;
    const key = JSON.stringify([origin_id, poi_id]);
    const known = routes.get(key);
    if (known !== undefined) return known;
    if (lookups >= MAX_LOOKUPS) return null;
    lookups++;
    try {
      const leg = await map.walk({ origin_id, poi_id });
      if (
        leg.origin.id !== origin_id ||
        leg.destination.id !== poi_id ||
        !Number.isSafeInteger(leg.travel_min) ||
        leg.travel_min < 0
      )
        throw new MapFault('MAP_UNAVAILABLE');
      const validUntil = Date.parse(leg.fetched_at) + WALK_VALIDITY_MS;
      if (!Number.isFinite(validUntil)) throw new MapFault('MAP_UNAVAILABLE');
      if (validUntil <= startedAt) {
        routes.set(key, null);
        return null;
      }
      expiresAt = Math.min(expiresAt, validUntil);
      routes.set(key, leg.travel_min);
      return leg.travel_min;
    } catch (error) {
      if (!(error instanceof MapFault) || error.code !== 'PLACE_NOT_FOUND') throw error;
      routes.set(key, null);
      return null;
    }
  };
  return { walk, expiresAt: () => expiresAt };
}

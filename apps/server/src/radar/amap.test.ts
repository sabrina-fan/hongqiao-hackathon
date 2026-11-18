import { describe, expect, it, vi } from 'vitest';
import { createAmap } from './amap.js';

const origin = { id: 'origin', name: '起点', address: [], location: '120.1,31.1' };
const destination = { id: 'poi', name: '目的地', address: '甲街', location: '120.2,31.2' };
const selection = { origin_id: origin.id, poi_id: destination.id };
const ok = (data: object) => Response.json({ status: '1', info: 'OK', ...data });
const leg = { origin_id: '1', dest_id: '1', info: 'OK', distance: '501', duration: '121' };

describe('Amap walking evidence', () => {
  it('projects only public search fields and preserves an empty successful search', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(ok({ pois: [origin] }))
      .mockResolvedValueOnce(ok({ pois: [] }));
    const map = createAmap({ key: 'unused', fetcher });
    await expect(map.search('古城')).resolves.toEqual([
      { id: 'origin', name: '起点', address: '' },
    ]);
    await expect(map.search('无匹配')).resolves.toEqual([]);
    const url = fetcher.mock.calls[0]?.[0];
    expect(url).toBeInstanceOf(URL);
    if (!(url instanceof URL)) throw new Error('Expected a URL');
    expect(url.pathname).toBe('/v5/place/text');
    expect(url.searchParams.get('keywords')).toBe('古城');
  });
  it('matches unordered POI details by ID and asks for the selected walking direction', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(ok({ pois: [destination, origin] }))
      .mockResolvedValueOnce(ok({ results: [leg] }));
    const map = createAmap({ key: 'unused', fetcher, now: () => 0 });
    await expect(map.walk(selection)).resolves.toEqual({
      origin: { id: 'origin', name: '起点', address: '' },
      destination: { id: 'poi', name: '目的地', address: '甲街' },
      travel_min: 3,
      distance_m: 501,
      fetched_at: new Date(0).toISOString(),
    });
    const url = fetcher.mock.calls[1]?.[0];
    if (!(url instanceof URL)) throw new Error('Expected a URL');
    expect(url.pathname).toBe('/v3/distance');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      origins: origin.location,
      destination: destination.location,
      type: '3',
    });
    expect(fetcher.mock.calls[1]?.[1]?.redirect).toBe('error');
  });
  it.each([
    { results: [{ ...leg, info: 'OUT_OF_SERVICE' }] },
    { results: [{ ...leg, duration: '' }] },
    { results: [] },
    { results: [{ ...leg, origin_id: '2' }] },
  ])('rejects unavailable or malformed individual routes', async (data) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(ok({ pois: [origin, destination] }))
      .mockResolvedValueOnce(ok(data));
    await expect(createAmap({ key: 'unused', fetcher }).walk(selection)).rejects.toMatchObject({
      code: 'MAP_UNAVAILABLE',
    });
  });
  it('distinguishes a removed place from an invalid upstream response', async () => {
    const map = createAmap({
      key: 'unused',
      fetcher: vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(ok({ pois: [origin] }))
        .mockResolvedValueOnce(
          ok({ pois: [{ ...origin, location: 'not a coordinate' }, destination] }),
        ),
    });
    await expect(map.walk(selection)).rejects.toMatchObject({ code: 'PLACE_NOT_FOUND' });
    await expect(map.walk(selection)).rejects.toMatchObject({ code: 'MAP_UNAVAILABLE' });
  });
  it('bounds retries and reports supplier throttling as an error', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 429 }))
      .mockResolvedValueOnce(Response.json({ status: '0', info: 'CUQPS_HAS_EXCEEDED_THE_LIMIT' }));
    await expect(createAmap({ key: 'unused', fetcher }).search('甲')).rejects.toMatchObject({
      code: 'MAP_RATE_LIMITED',
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('does not expose transport messages or return empty on an upstream error', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('private request details'))
      .mockResolvedValueOnce(ok({ unexpected: true }));
    const map = createAmap({ key: 'unused', fetcher });
    for (let i = 0; i < 2; i++)
      await expect(map.search('甲')).rejects.toMatchObject({
        code: 'MAP_UNAVAILABLE',
        message: 'MAP_UNAVAILABLE',
      });
  });
});

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
      markers: {
        origin: { system: 'gcj02', longitude: 120.1, latitude: 31.1 },
        destination: { system: 'gcj02', longitude: 120.2, latitude: 31.2 },
      },
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
  it('converts the GPS origin once and uses the same GCJ-02 points for the markers and both legs', async () => {
    const gps = {
      system: 'wgs84',
      longitude: 120.629,
      latitude: 31.312,
      accuracy_m: 12,
    } satisfies import('@nextstop/core').BrowserPosition;
    const gcj = '120.633087,31.309861';
    const fixed = {
      arrangement_id: 'reservation',
      name: '预约',
      address: '平江路 10 号',
      starts_at: '2026-11-18T09:15:00.000Z',
      time_zone: 'Asia/Shanghai',
    };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(ok({ pois: [destination] }))
      .mockResolvedValueOnce(ok({ locations: gcj }))
      .mockResolvedValueOnce(ok({ results: [leg] }))
      .mockResolvedValueOnce(
        ok({ geocodes: [{ location: '120.65,31.32', level: '门牌号', adcode: '320508' }] }),
      )
      .mockResolvedValueOnce(ok({ results: [leg] }));
    const map = createAmap({ key: 'unused', fetcher });
    const outbound = await map.walk({ position: gps, poi_id: destination.id });
    const onward = await map.walkToFixed({ candidate: outbound, fixed });
    const urls = fetcher.mock.calls.map(([url]) => {
      if (!(url instanceof URL)) throw new Error('Expected a URL');
      return { path: url.pathname, ...Object.fromEntries(url.searchParams) };
    });
    expect(urls).toMatchObject([
      { path: '/v5/place/detail', id: destination.id },
      { path: '/v3/assistant/coordinate/convert', locations: '120.629,31.312', coordsys: 'gps' },
      { path: '/v3/distance', origins: gcj, destination: destination.location },
      { path: '/v3/geocode/geo', address: fixed.address, city: '320500' },
      { path: '/v3/distance', origins: destination.location, destination: '120.65,31.32' },
    ]);
    expect(outbound.markers?.origin).toEqual({
      system: 'gcj02',
      longitude: 120.633087,
      latitude: 31.309861,
    });
    expect(onward.markers?.origin).toEqual(outbound.markers?.destination);
  });
  it.each([
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
  it('distinguishes a missing individual walking route from a provider error', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(ok({ pois: [origin, destination] }))
      .mockResolvedValueOnce(
        ok({ results: [{ origin_id: '1', dest_id: '1', info: 'OUT_OF_SERVICE' }] }),
      );
    await expect(createAmap({ key: 'unused', fetcher }).walk(selection)).rejects.toMatchObject({
      code: 'ROUTE_UNVERIFIED',
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

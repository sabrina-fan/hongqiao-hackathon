import { afterEach, expect, it, vi } from 'vitest';

const sessionPath = '/api/v1/sessions';
const dataPath = '/api/v1/me/data';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

it('establishes the guest once, then reads with the existing cookie and recovers if it expires', async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(null, { status: 204 }))
    .mockResolvedValueOnce(Response.json({}))
    .mockResolvedValueOnce(Response.json({}))
    .mockResolvedValueOnce(Response.json({ error: { code: 'SESSION_REQUIRED' } }, { status: 401 }))
    .mockResolvedValueOnce(new Response(null, { status: 204 }))
    .mockResolvedValueOnce(Response.json({}));
  vi.stubGlobal('fetch', fetcher);
  const { readWithGuestSession, request } = await import('./api.js');
  const signal = new AbortController().signal;
  const read = () => request(dataPath, {}, signal);

  expect((await readWithGuestSession(read, signal)).ok).toBe(true);
  expect((await readWithGuestSession(read, signal)).ok).toBe(true);
  expect((await readWithGuestSession(read, signal)).ok).toBe(true);
  expect(fetcher.mock.calls.map(([path]) => path)).toEqual([
    sessionPath,
    dataPath,
    dataPath,
    dataPath,
    sessionPath,
    dataPath,
  ]);
});

import { afterEach, expect, it, vi } from 'vitest';

const sessionPath = '/api/v1/sessions';
const dataPath = '/api/v1/me/data';
const wishlistPath = '/api/v1/wishlist';
const sessionReady = () => new Response(null, { status: 204 });
const sessionRequired = () =>
  Response.json({ error: { code: 'SESSION_REQUIRED' } }, { status: 401 });

function holdResponse() {
  let release: (response: Response) => void = () => {
    throw new Error('Response has no waiting request');
  };
  const response = new Promise<Response>((resolve) => {
    release = resolve;
  });
  return { response, release };
}

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

it('shares a pending session POST when one of two cold reads is canceled', async () => {
  const session = holdResponse();
  const fetcher = vi
    .fn<typeof fetch>()
    .mockReturnValueOnce(session.response)
    .mockResolvedValueOnce(Response.json({}));
  vi.stubGlobal('fetch', fetcher);
  const { readWithGuestSession, request } = await import('./api.js');
  const canceled = new AbortController();
  const active = new AbortController().signal;

  const abandoned = readWithGuestSession(
    () => request(wishlistPath, {}, canceled.signal),
    canceled.signal,
  );
  const other = readWithGuestSession(() => request(dataPath, {}, active), active);
  canceled.abort();
  expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
  session.release(sessionReady());

  await expect(abandoned).rejects.toMatchObject({ name: 'AbortError' });
  await expect(other).resolves.toMatchObject({ ok: true });
  expect(fetcher.mock.calls.map(([path]) => path)).toEqual([sessionPath, dataPath]);
});

it('reuses a successful refresh when a concurrent read gets a late SESSION_REQUIRED', async () => {
  const late = holdResponse();
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(sessionReady())
    .mockReturnValueOnce(late.response)
    .mockResolvedValueOnce(sessionRequired())
    .mockResolvedValueOnce(sessionReady())
    .mockResolvedValueOnce(Response.json({}))
    .mockImplementation(async (path) =>
      path === sessionPath ? sessionReady() : Response.json({}),
    );
  vi.stubGlobal('fetch', fetcher);
  const { createSession, readWithGuestSession, request } = await import('./api.js');
  const signal = new AbortController().signal;
  await createSession(signal);

  const wishlist = readWithGuestSession(() => request(wishlistPath, {}, signal), signal);
  await expect(
    readWithGuestSession(() => request(dataPath, {}, signal), signal),
  ).resolves.toMatchObject({ ok: true });
  late.release(sessionRequired());
  await expect(wishlist).resolves.toMatchObject({ ok: true });
  expect(fetcher.mock.calls.map(([path]) => path)).toEqual([
    sessionPath,
    wishlistPath,
    dataPath,
    sessionPath,
    dataPath,
    wishlistPath,
  ]);
});

it('retries SESSION_REQUIRED once even after a cold session POST, then surfaces the second error', async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockImplementation(async (path) =>
      path === sessionPath ? sessionReady() : sessionRequired(),
    );
  vi.stubGlobal('fetch', fetcher);
  const { readWithGuestSession, request } = await import('./api.js');
  const signal = new AbortController().signal;

  await expect(
    readWithGuestSession(() => request(dataPath, {}, signal), signal),
  ).rejects.toMatchObject({ code: 'SESSION_REQUIRED', status: 401 });
  expect(fetcher.mock.calls.map(([path]) => path)).toEqual([
    sessionPath,
    dataPath,
    sessionPath,
    dataPath,
  ]);
});

it.each(['NETWORK', 'INVALID_RESPONSE', 'HTTP_401'])(
  'propagates %s without retrying',
  async (code) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(sessionReady());
    vi.stubGlobal('fetch', fetcher);
    const { ApiError, createSession, readWithGuestSession } = await import('./api.js');
    const signal = new AbortController().signal;
    await createSession(signal);
    const error = new ApiError(code, 'synthetic read failure', code === 'HTTP_401' ? 401 : 0);
    const read = vi.fn<() => Promise<never>>().mockRejectedValue(error);

    await expect(readWithGuestSession(read, signal)).rejects.toBe(error);
    expect(read).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
  },
);

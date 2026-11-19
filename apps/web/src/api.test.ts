import { ERASE_BINDING_HEADER } from '@nextstop/core';
import { afterEach, expect, it, vi } from 'vitest';

const sessionPath = '/api/v1/sessions';
const dataPath = '/api/v1/me/data';
const settingsPath = `${dataPath}?include=pending_deletions&include_retired_batch_removals=1&include_erase_recovery=1`;
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

it('allows a radar scan 36 seconds while honoring caller cancellation', async () => {
  const { createRadarSession } = await import('./api.js');
  const input = { origin_id: 'origin', available_min: 45 };
  const fetcher = vi.fn<typeof fetch>((_path, init) => {
    const signal = init?.signal;
    if (!signal) throw new Error('Expected a radar request signal');
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  });
  vi.stubGlobal('fetch', fetcher);
  vi.useFakeTimers();
  // Node's native AbortSignal timeout does not use Vitest's fake timer queue.
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), ms);
    return controller.signal;
  });
  try {
    const request = createRadarSession(input).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(35_999);
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    await expect(request).resolves.toMatchObject({ code: 'TIMEOUT', status: 0 });

    const caller = new AbortController();
    const canceled = createRadarSession(input, caller.signal);
    caller.abort();
    await expect(canceled).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  } finally {
    timeout.mockRestore();
    vi.useRealTimers();
  }
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

it('loads settings with the original anonymous-data response from an older server', async () => {
  const legacy = { trips: [], uploads: [], places: [] };
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(legacy));
  vi.stubGlobal('fetch', fetcher);
  const { readSettingsData } = await import('./settings-client.js');

  await expect(readSettingsData(new AbortController().signal)).resolves.toEqual({
    view: legacy,
    eraseBinding: null,
  });
  expect(fetcher.mock.calls.map(([path]) => path)).toEqual([settingsPath]);
});

it('reads deletion recovery without creating a session or issuing a DELETE', async () => {
  const recovery = { kind: 'erase_recovery' };
  const binding = 'a'.repeat(43);
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      Response.json(recovery, { headers: { [ERASE_BINDING_HEADER]: binding } }),
    );
  vi.stubGlobal('fetch', fetcher);
  const { readSettingsData } = await import('./settings-client.js');

  await expect(readSettingsData(new AbortController().signal)).resolves.toEqual({
    view: recovery,
    eraseBinding: binding,
  });
  expect(fetcher.mock.calls.map(([path, init]) => [path, init?.method ?? 'GET'])).toEqual([
    [settingsPath, 'GET'],
  ]);
});

it('initializes the guest and retries settings once when no signed session is present', async () => {
  const empty = { trips: [], uploads: [], places: [] };
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(sessionRequired())
    .mockResolvedValueOnce(sessionReady())
    .mockResolvedValueOnce(Response.json(empty));
  vi.stubGlobal('fetch', fetcher);
  const { readSettingsData } = await import('./settings-client.js');

  await expect(readSettingsData(new AbortController().signal)).resolves.toEqual({
    view: empty,
    eraseBinding: null,
  });
  expect(fetcher.mock.calls.map(([path, init]) => [path, init?.method ?? 'GET'])).toEqual([
    [settingsPath, 'GET'],
    [sessionPath, 'POST'],
    [settingsPath, 'GET'],
  ]);
});

it('continues an import with the plain batch snapshot from an older server', async () => {
  const legacy = { batch_id: 'bat-00000000-0000-4000-8000-000000000000', revision: 3, items: [] };
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(legacy));
  vi.stubGlobal('fetch', fetcher);
  const { getBatchWithPendingRemovals } = await import('./import-batch-client.js');

  await expect(getBatchWithPendingRemovals(legacy.batch_id)).resolves.toEqual(legacy);
  expect(fetcher.mock.calls[0]?.[0]).toBe(
    `/api/v1/import-batches/${legacy.batch_id}?include=pending_removals`,
  );
});

it('requires the DELETE completion status before acknowledging source deletion', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null, { status: 202 }));
  vi.stubGlobal('fetch', fetcher);
  const { deleteData } = await import('./settings-client.js');

  const id = 'imp-00000000-0000-4000-8000-000000000000';
  await expect(deleteData({ kind: 'source', id })).rejects.toMatchObject({
    code: 'INVALID_RESPONSE',
    status: 202,
  });
  expect(fetcher).toHaveBeenCalledWith(
    `/api/v1/imports/${id}`,
    expect.objectContaining({ method: 'DELETE' }),
  );
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

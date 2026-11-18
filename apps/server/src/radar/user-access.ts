import type { RadarModel } from '@nextstop/model-gateway';
import { createHash } from 'node:crypto';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HttpFault } from '../http.js';
import { openUserRuntime, type UserRuntime } from '../runtime/open-user-runtime.js';
import { TripFault } from '../trip/store.js';

// Data deletion shares the SQLite queue so an older request cannot open a writer after revocation.
export function createUserAccess(dataDir: string, radarModel?: RadarModel | null) {
  const tails = new Map<string, Promise<void>>();
  type Task = { controller: AbortController; tripId: string | null };
  const tasks = new Map<string, Set<Task>>();
  const revokedDir = join(dataDir, 'revoked-guests');
  const marker = (userId: string) =>
    join(revokedDir, createHash('sha256').update(userId).digest('hex'));
  async function isRevoked(userId: string) {
    return (await stat(marker(userId), { throwIfNoEntry: false })) !== undefined;
  }
  async function exclusive<T>(userId: string, run: () => Promise<T>): Promise<T> {
    const previous = tails.get(userId) ?? Promise.resolve();
    const result = previous.then(run);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    tails.set(userId, tail);
    try {
      return await result;
    } finally {
      if (tails.get(userId) === tail) tails.delete(userId);
    }
  }
  function withUser<T>(userId: string, run: (runtime: UserRuntime) => Promise<T>): Promise<T> {
    return exclusive(userId, async () => {
      if (await isRevoked(userId)) throw new HttpFault('SESSION_REQUIRED');
      const runtime = await openUserRuntime({ dataDir, userId, radarModel: radarModel ?? null });
      try {
        return await run(runtime);
      } finally {
        await runtime.close();
      }
    });
  }
  async function task<T>(
    userId: string,
    run: (signal: AbortSignal, bindTrip: (id: string) => void) => Promise<T>,
  ) {
    const entry: Task = { controller: new AbortController(), tripId: null };
    const active = tasks.get(userId) ?? new Set<Task>();
    active.add(entry);
    tasks.set(userId, active);
    try {
      if (await isRevoked(userId)) throw new HttpFault('SESSION_REQUIRED');
      const { signal } = entry.controller;
      signal.throwIfAborted();
      const result = await run(signal, (id) => {
        entry.tripId = id;
      }).catch((error: unknown) => {
        signal.throwIfAborted();
        throw error;
      });
      signal.throwIfAborted();
      return result;
    } finally {
      active.delete(entry);
      if (active.size === 0) tasks.delete(userId);
    }
  }
  function cancelTrip(userId: string, tripId: string) {
    for (const entry of tasks.get(userId) ?? []) {
      if (entry.tripId === tripId) entry.controller.abort(new TripFault('TRIP_STALE'));
    }
  }
  function erase(userId: string, removeImages: () => Promise<void>): Promise<void> {
    return exclusive(userId, async () => {
      await mkdir(revokedDir, { recursive: true, mode: 0o700 });
      await writeFile(marker(userId), '', { mode: 0o600 });
      for (const entry of tasks.get(userId) ?? [])
        entry.controller.abort(new HttpFault('SESSION_REQUIRED'));
      await removeImages();
      const file = join(dataDir, 'users', `${userId}.sqlite`);
      for (const suffix of ['', '-wal', '-shm', '-journal']) {
        await rm(file + suffix, { force: true });
      }
    });
  }
  return Object.assign(withUser, { isRevoked, erase, task, cancelTrip });
}

import { openUserRuntime, type UserRuntime } from '../runtime/open-user-runtime.js';

// A file has one writer, even when the same guest opens two tabs. Release it before handing off.
export function createUserAccess(dataDir: string) {
  const tails = new Map<string, Promise<void>>();
  return async function withUser<T>(
    userId: string,
    run: (runtime: UserRuntime) => Promise<T>,
  ): Promise<T> {
    const previous = tails.get(userId) ?? Promise.resolve();
    const result = previous.then(async () => {
      const runtime = await openUserRuntime({ dataDir, userId });
      try {
        return await run(runtime);
      } finally {
        await runtime.close();
      }
    });
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
  };
}

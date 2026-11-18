import { describe, expect, it, vi } from 'vitest';
import { createJevIntentClient } from './jev.js';

const answer = {
  model: 'jev-latest',
  answers: {
    intent: {
      type: 'choice',
      choice: 'unknown',
      confidence: 0.99,
      probabilities: {
        too_far: 0,
        too_expensive: 0,
        no_walking: 0,
        not_interested: 0.01,
        unknown: 0.99,
      },
    },
  },
  usage: { input_tokens: 10, output_tokens: 5 },
};

function client(fetcher: typeof fetch, timeoutMs = 1000) {
  return createJevIntentClient({
    baseUrl: 'https://relay.example',
    apiKey: 'test-key',
    model: 'jev-latest',
    timeoutMs,
    fetcher,
  });
}

describe('Jev native intent transport', () => {
  it('rejects a relay URL path before making any request', () => {
    const fetcher = vi.fn<typeof fetch>();
    expect(() =>
      createJevIntentClient({
        baseUrl: 'https://relay.example/jev',
        apiKey: 'test-key',
        model: 'jev-latest',
        timeoutMs: 1000,
        fetcher,
      }),
    ).toThrow('HTTPS origin');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('keeps unknown as a result, uses SystemOne, and returns usage', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json(answer));
    const result = await client(fetcher).classifyIntent({
      message: '换一个吧',
      deadlineMs: Date.now() + 1000,
    });
    expect(result.intent).toBe('unknown');
    expect(result.usage).toEqual({ input_tokens: 10, output_tokens: 5 });
    const call = fetcher.mock.calls[0];
    expect(String(call?.[0])).toBe('https://relay.example/v1/systemone');
    expect(call?.[1]?.redirect).toBe('manual');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('does not start a call after the shared deadline', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      client(fetcher).classifyIntent({ message: '太远了', deadlineMs: Date.now() - 1 }),
    ).rejects.toMatchObject({ code: 'DEADLINE_EXCEEDED' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('does not return a valid response that finishes at the shared deadline', async () => {
    const deadlineMs = Date.now() + 1000;
    using clock = vi.spyOn(Date, 'now');
    const fetcher = vi.fn<typeof fetch>(async () => {
      clock.mockReturnValue(deadlineMs);
      return Response.json(answer);
    });
    await expect(
      client(fetcher).classifyIntent({ message: '太远了', deadlineMs }),
    ).rejects.toMatchObject({
      code: 'DEADLINE_EXCEEDED',
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('enforces the attempt budget even before the abort timer is dispatched', async () => {
    using clock = vi.spyOn(performance, 'now').mockReturnValue(0);
    const fetcher = vi.fn<typeof fetch>(async () => {
      clock.mockReturnValue(20);
      return Response.json(answer);
    });
    await expect(
      client(fetcher, 20).classifyIntent({ message: '太远了', deadlineMs: Date.now() + 1000 }),
    ).rejects.toMatchObject({
      code: 'ATTEMPT_TIMEOUT',
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('rejects an inconsistent probability distribution', async () => {
    const invalid = structuredClone(answer);
    invalid.answers.intent.probabilities.too_far = 1;
    await expect(
      client(async () => Response.json(invalid)).classifyIntent({
        message: '换一个',
        deadlineMs: Date.now() + 1000,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_MODEL_RESPONSE' });
  });
  it('classifies malformed JSON separately from transport failures', async () => {
    await expect(
      client(async () => new Response('private invalid JSON')).classifyIntent({
        message: '换一个',
        deadlineMs: Date.now() + 1000,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_MODEL_RESPONSE', reason: 'INVALID_JSON' });
  });
  it('keeps a distinct reason for schema-invalid JSON', async () => {
    await expect(
      client(async () => Response.json({ model: 'jev-latest' })).classifyIntent({
        message: '换一个',
        deadlineMs: Date.now() + 1000,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_MODEL_RESPONSE', reason: 'SCHEMA_MISMATCH' });
  });
  it.each(['headers', 'body'])('keeps network failures during %s as failures', async (phase) => {
    const fetcher = vi.fn<typeof fetch>(async () => {
      const error = new TypeError('private network diagnostic');
      if (phase === 'headers') throw error;
      return new Response(new ReadableStream({ start: (stream) => stream.error(error) }));
    });
    await expect(
      client(fetcher).classifyIntent({ message: '换一个', deadlineMs: Date.now() + 1000 }),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', message: 'PROVIDER_UNAVAILABLE' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([
    { phase: 'headers', timeoutMs: 20, remainingMs: 1000, code: 'ATTEMPT_TIMEOUT' },
    { phase: 'body', timeoutMs: 20, remainingMs: 1000, code: 'ATTEMPT_TIMEOUT' },
    { phase: 'headers', timeoutMs: 1000, remainingMs: 20, code: 'DEADLINE_EXCEEDED' },
    { phase: 'body', timeoutMs: 1000, remainingMs: 20, code: 'DEADLINE_EXCEEDED' },
  ])(
    'reports $code during $phase without retrying',
    async ({ phase, timeoutMs, remainingMs, code }) => {
      const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
        const signal = init?.signal;
        if (!signal) throw new Error('Expected a request cancellation signal');
        if (phase === 'headers') {
          return new Promise<Response>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          });
        }
        return new Response(
          new ReadableStream({
            start(stream) {
              signal.addEventListener('abort', () => stream.error(signal.reason), { once: true });
            },
          }),
        );
      });
      await expect(
        client(fetcher, timeoutMs).classifyIntent({
          message: '换一个',
          deadlineMs: Date.now() + remainingMs,
        }),
      ).rejects.toMatchObject({ code });
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );
  it('does not expose provider bodies or credentials in an error', async () => {
    const fetcher: typeof fetch = async () =>
      new Response('upstream private diagnostic', { status: 502 });
    await expect(
      client(fetcher).classifyIntent({ message: '太远了', deadlineMs: Date.now() + 1000 }),
    ).rejects.toThrow('PROVIDER_UNAVAILABLE');
  });
});

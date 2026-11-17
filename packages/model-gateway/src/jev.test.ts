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

function client(fetcher: typeof fetch) {
  return createJevIntentClient({
    baseUrl: 'https://relay.example',
    apiKey: 'test-key',
    model: 'jev-latest',
    timeoutMs: 1000,
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
  it('does not expose provider bodies or credentials in an error', async () => {
    const fetcher: typeof fetch = async () =>
      new Response('upstream private diagnostic', { status: 502 });
    await expect(
      client(fetcher).classifyIntent({ message: '太远了', deadlineMs: Date.now() + 1000 }),
    ).rejects.toThrow('PROVIDER_UNAVAILABLE');
  });
});

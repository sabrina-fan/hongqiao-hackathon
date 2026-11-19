import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { visualExtractionValidator } from '@nextstop/core';
import { createVisionExtractor } from '@nextstop/model-gateway';
import { expect, it } from 'vitest';
import { createImportReview } from './imports/review.js';

const image = {
  data: (await readFile(new URL('../test/import-synthetic.png', import.meta.url))).toString(
    'base64',
  ),
  mimeType: 'image/png' as const,
};
const extraction = {
  kind: 'text',
  name: '山塘街',
  excerpt: '傍晚去山塘街看灯。',
  confidence: 'high',
};
const json = JSON.stringify(extraction);
const fenced = `\`\`\`json\n${json}\n\`\`\``;
const wrongSchema = JSON.stringify({ ...extraction, poi_id: 'untrusted-id' });

type Reply = (response: ServerResponse) => void;
type Route = 'primary' | 'fallback';

function event(choice: Record<string, unknown>) {
  return `data: ${JSON.stringify({ id: 'fixture', choices: [{ index: 0, ...choice }] })}\n\n`;
}

function finish(response: ServerResponse, choice: Record<string, unknown>) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(`${event({ finish_reason: 'stop', ...choice })}data: [DONE]\n\n`);
}

async function withVision(
  replies: Record<Route, Reply>,
  run: (
    review: ReturnType<typeof createImportReview>,
    calls: Route[],
    diagnostics: unknown[],
  ) => Promise<void>,
) {
  const calls: Route[] = [];
  const diagnostics: unknown[] = [];
  const upstream = createServer((request, response) => {
    let route: Route;
    if (request.url === '/primary/chat/completions') route = 'primary';
    else if (request.url === '/fallback/chat/completions') route = 'fallback';
    else {
      response.writeHead(404).end();
      return;
    }
    request.on('end', () => {
      calls.push(route);
      replies[route](response);
    });
    request.resume();
  });
  upstream.listen(0, '127.0.0.1');
  try {
    await once(upstream, 'listening');
    const address = upstream.address();
    if (!address || typeof address === 'string') throw new Error('TCP address required');
    const base = `http://127.0.0.1:${address.port}`;
    const vision = createVisionExtractor(
      [
        {
          provider: 'zhipu',
          modelId: 'vision-fixture',
          baseUrl: `${base}/primary`,
          apiKey: 'fixture',
        },
        {
          provider: 'ark',
          modelId: 'vision-fixture',
          baseUrl: `${base}/fallback`,
          apiKey: 'fixture',
        },
      ],
      visualExtractionValidator.check,
      (failure: unknown) => diagnostics.push(failure),
    );
    await run(createImportReview(null, vision), calls, diagnostics);
  } finally {
    const closed = once(upstream, 'close');
    upstream.close();
    upstream.closeAllConnections();
    await closed;
  }
}

const success: Reply = (response) => finish(response, { delta: { content: json } });
const unsupportedFormat: Reply = (response) => {
  response.writeHead(400, { 'content-type': 'application/json' });
  response.end('{"error":{"code":"unsupported_value","param":"response_format"}}');
};

const failures: [name: string, reason: string, status: number | undefined, reply: Reply][] = [
  ['HTTP 400 for an unsupported response format', 'sdk_error', undefined, unsupportedFormat],
  [
    'SDK stream error',
    'sdk_error',
    200,
    (response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end('event: error\ndata: {"error":{"message":"fixture stream error"}}\n\n');
    },
  ],
  [
    'non-streaming message shape in an SSE event',
    'empty_text',
    200,
    (response) => finish(response, { message: { role: 'assistant', content: json } }),
  ],
  [
    'non-JSON answer text',
    'json_rejected',
    200,
    (response) => finish(response, { delta: { content: fenced } }),
  ],
  [
    'truncated completion with parseable JSON',
    'non_stop',
    200,
    (response) => finish(response, { delta: { content: json }, finish_reason: 'length' }),
  ],
  [
    'valid JSON outside the extraction schema',
    'schema_rejected',
    200,
    (response) => finish(response, { delta: { content: wrongSchema } }),
  ],
  [
    'answer text above the size cap',
    'text_too_large',
    200,
    (response) => finish(response, { delta: { content: 'x'.repeat(4097) } }),
  ],
];

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function diagnostic(route: Route, reason: string, status?: number) {
  return {
    route,
    reason,
    correlation_id: expect.stringMatching(uuid),
    elapsed_ms: expect.any(Number),
    ...(status === undefined ? {} : { http_status: status }),
  };
}

it('uses the primary result when its SSE response is valid and emits no failure diagnostic', async () => {
  await withVision({ primary: success, fallback: success }, async (review, calls, diagnostics) => {
    expect((await review.image('fixture', image)).extraction).toEqual(extraction);
    expect(calls).toEqual(['primary']);
    expect(diagnostics).toStrictEqual([]);
  });
});

it.each(failures)(
  'tries the fallback and logs a bounded reason after %s',
  async (_name, reason, status, reply) => {
    await withVision({ primary: reply, fallback: success }, async (review, calls, diagnostics) => {
      expect((await review.image('fixture', image)).extraction).toEqual(extraction);
      expect(calls).toEqual(['primary', 'fallback']);
      expect(diagnostics).toStrictEqual([diagnostic('primary', reason, status)]);
    });
  },
);

it(
  'closes a stalled SSE body at the attempt timeout and still tries the fallback',
  { timeout: 25_000 },
  async () => {
    let primaryClosed = false;
    await withVision(
      {
        primary: (response) => {
          response.once('close', () => {
            primaryClosed = true;
          });
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          response.write(event({ delta: { content: json } }));
        },
        fallback: success,
      },
      async (review, calls, diagnostics) => {
        expect((await review.image('fixture', image)).extraction).toEqual(extraction);
        expect(calls).toEqual(['primary', 'fallback']);
        await expect.poll(() => primaryClosed).toBe(true);
        expect(diagnostics).toStrictEqual([diagnostic('primary', 'timeout', 200)]);
      },
    );
  },
);

it(
  'accepts a complete fallback SSE reply that arrives after ten seconds',
  { timeout: 25_000 },
  async () => {
    const lateSuccess: Reply = (response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.flushHeaders();
      const release = setTimeout(() => {
        response.end(
          `${event({ delta: { content: json }, finish_reason: 'stop' })}data: [DONE]\n\n`,
        );
      }, 11_000);
      response.once('close', () => clearTimeout(release));
    };
    await withVision(
      { primary: unsupportedFormat, fallback: lateSuccess },
      async (review, calls, diagnostics) => {
        expect((await review.image('fixture', image)).extraction).toEqual(extraction);
        expect(calls).toEqual(['primary', 'fallback']);
        expect(diagnostics).toStrictEqual([diagnostic('primary', 'sdk_error')]);
      },
    );
  },
);

it('classifies caller cancellation and does not start the fallback', async () => {
  const caller = new AbortController();
  await withVision(
    { primary: () => caller.abort(new Error('fixture cancellation detail')), fallback: success },
    async (review, calls, diagnostics) => {
      expect(await review.image('fixture', image, caller.signal)).toMatchObject({
        extraction: { kind: 'vision_unavailable' },
        match: { kind: 'not_searched' },
      });
      expect(calls).toEqual(['primary']);
      expect(diagnostics).toStrictEqual([diagnostic('primary', 'caller_cancelled')]);
    },
  );
});

it('correlates both route failures and uses a fresh ID on the next extraction', async () => {
  await withVision(
    { primary: unsupportedFormat, fallback: unsupportedFormat },
    async (review, calls, diagnostics) => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        expect(await review.image('fixture', image)).toMatchObject({
          extraction: { kind: 'vision_unavailable' },
          match: { kind: 'not_searched' },
        });
      }
      expect(calls).toEqual(['primary', 'fallback', 'primary', 'fallback']);
      expect(diagnostics).toStrictEqual([
        diagnostic('primary', 'sdk_error'),
        diagnostic('fallback', 'sdk_error'),
        diagnostic('primary', 'sdk_error'),
        diagnostic('fallback', 'sdk_error'),
      ]);
      function correlationId(record: unknown) {
        if (typeof record !== 'object' || record === null || !('correlation_id' in record)) {
          throw new Error('Missing diagnostic correlation ID');
        }
        return record.correlation_id;
      }
      const [first, firstFallback, next, nextFallback] = diagnostics.map(correlationId);
      expect(first).toBe(firstFallback);
      expect(next).toBe(nextFallback);
      expect(next).not.toBe(first);
    },
  );
});

import { afterEach, describe, expect, it } from 'vitest';
import { request as httpRequest, type IncomingMessage, type Server } from 'node:http';
import { json } from 'node:stream/consumers';
import { capabilitiesValidator, readyValidator } from '@nextstop/core';
import { createApp } from './app.js';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
});

async function startApp() {
  const server = createApp();
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP listener');
  return `http://127.0.0.1:${address.port}`;
}

describe('HTTP scaffold', () => {
  it('publishes schema-checked readiness and honest capabilities without credentials', async () => {
    const origin = await startApp();
    const ready = await fetch(`${origin}/health/ready`);
    expect(ready.status).toBe(200);
    expect(readyValidator.check(await ready.json())).toBe(true);
    const response = await fetch(`${origin}/health/capabilities`);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body: unknown = await response.json();
    expect(capabilitiesValidator.check(body)).toBe(true);
    expect(body).toEqual({
      stage: 'scaffold',
      radar: false,
      imports: false,
      trip_writes: false,
      model_calls: false,
    });
  });
  it.each(['//', '//['])('returns 400 for %s and keeps serving health requests', async (path) => {
    const origin = await startApp();
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      httpRequest(origin, { path }, resolve).once('error', reject).end();
    });
    expect(response.statusCode).toBe(400);
    const body: unknown = await json(response);
    expect(body).toMatchObject({ error: { code: 'INVALID_REQUEST' } });
    const ready = await fetch(`${origin}/health/ready`);
    expect(ready.status).toBe(200);
    expect(readyValidator.check(await ready.json())).toBe(true);
  });
  it('does not return pretend recommendations from an unimplemented API', async () => {
    const origin = await startApp();
    const response = await fetch(`${origin}/api/v1/radar/sessions`, { method: 'POST' });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: 'NOT_IMPLEMENTED' } });
  });
});

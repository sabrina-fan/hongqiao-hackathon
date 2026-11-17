import type { Capabilities } from '@nextstop/core';
import { createServer } from 'node:http';

const capabilities: Capabilities = {
  stage: 'scaffold',
  radar: false,
  imports: false,
  trip_writes: false,
  model_calls: false,
};

export function createApp() {
  return createServer((request, response) => {
    response.setHeader('content-type', 'application/json; charset=utf-8');
    response.setHeader('cache-control', 'no-store');
    response.setHeader('x-content-type-options', 'nosniff');
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (request.method === 'GET' && path === '/health/ready') {
      response.end(JSON.stringify({ status: 'ok', service: 'nextstop', stage: 'scaffold' }));
    } else if (request.method === 'GET' && path === '/health/capabilities') {
      response.end(JSON.stringify(capabilities));
    } else {
      response.statusCode = 404;
      response.end(
        JSON.stringify({ error: { code: 'NOT_IMPLEMENTED', message: '接口尚未实现。' } }),
      );
    }
  });
}

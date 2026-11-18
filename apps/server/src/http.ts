import type { IncomingMessage, ServerResponse } from 'node:http';
import { RadarFault } from './radar/evidence.js';
import { MapFault } from './radar/amap.js';

export class HttpFault extends Error {
  constructor(
    readonly code:
      | 'INVALID_REQUEST'
      | 'REQUEST_TOO_LARGE'
      | 'SESSION_REQUIRED'
      | 'RADAR_NOT_CONFIGURED'
      | 'CROSS_ORIGIN'
      | 'NOT_IMPLEMENTED',
  ) {
    super(code);
  }
}
const errors = {
  INVALID_REQUEST: [400, '请求参数无效。'],
  REQUEST_TOO_LARGE: [413, '请求内容过大。'],
  CROSS_ORIGIN: [403, '请从当前应用确认。'],
  SESSION_REQUIRED: [401, '请重新建立匿名会话。'],
  RADAR_NOT_CONFIGURED: [503, '雷达服务尚未配置。'],
  NOT_IMPLEMENTED: [404, '接口尚未实现。'],
  NOT_FOUND: [404, '未找到本次雷达提案。'],
  PLACE_NOT_FOUND: [404, '地点已不可用，请重新搜索选择。'],
  MAP_UNAVAILABLE: [502, '地图服务暂不可用，请稍后重试。'],
  MAP_RATE_LIMITED: [429, '地图服务请求受限，请稍后重试。'],
  PROPOSAL_STALE: [409, '提案已过期或行程已更新，请重新计算。'],
  PROPOSAL_UNVALIDATED: [409, '提案未通过校验，请重新计算。'],
  NO_FEASIBLE_OPTION: [409, '没有可接受的可行候选。'],
  IDEMPOTENCY_CONFLICT: [409, '同一确认标识已用于其他操作。'],
  INTERNAL_ERROR: [500, '服务暂不可用。'],
} as const;

export function send(response: ServerResponse, status: number, value?: unknown) {
  response.writeHead(status);
  response.end(value === undefined ? undefined : JSON.stringify(value));
}
export function sendError(response: ServerResponse, error: unknown) {
  const code =
    error instanceof RadarFault || error instanceof MapFault || error instanceof HttpFault
      ? error.code
      : 'INTERNAL_ERROR';
  const [status, message] = errors[code];
  send(response, status, { error: { code, message } });
}

export function checkPostOrigin(request: IncomingMessage) {
  if (request.headers['sec-fetch-site'] === 'cross-site') throw new HttpFault('CROSS_ORIGIN');
  const origin = request.headers.origin;
  if (origin !== undefined && URL.parse(origin)?.host !== request.headers.host)
    throw new HttpFault('CROSS_ORIGIN');
}

export async function readJson<T>(
  request: IncomingMessage,
  check: (value: unknown) => value is T,
): Promise<T> {
  if (request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json')
    throw new HttpFault('INVALID_REQUEST');
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    if (!Buffer.isBuffer(chunk)) throw new HttpFault('INVALID_REQUEST');
    bytes += chunk.length;
    if (bytes > 8192) {
      request.resume();
      throw new HttpFault('REQUEST_TOO_LARGE');
    }
    chunks.push(chunk);
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpFault('INVALID_REQUEST');
  }
  if (!check(value)) throw new HttpFault('INVALID_REQUEST');
  return value;
}

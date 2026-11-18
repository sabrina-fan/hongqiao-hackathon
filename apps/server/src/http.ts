import type { IncomingMessage, ServerResponse } from 'node:http';
import { RadarFault } from './radar/evidence.js';
import { MapFault } from './radar/amap.js';
import { TripFault } from './trip/store.js';

export class HttpFault extends Error {
  constructor(
    readonly code:
      | 'INVALID_REQUEST'
      | 'REQUEST_TOO_LARGE'
      | 'SESSION_REQUIRED'
      | 'RADAR_NOT_CONFIGURED'
      | 'CROSS_ORIGIN'
      | 'INVALID_IMAGE'
      | 'IMPORT_NOT_FOUND'
      | 'IMPORT_STALE'
      | 'IMPORT_CONFIRMED'
      | 'IMPORT_INVALID_CHOICE'
      | 'IMPORT_BUSY'
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
  INVALID_IMAGE: [422, '无法读取图片。请更换 PNG / JPEG，或手动搜索地点。'],
  IMPORT_NOT_FOUND: [404, '未找到此核对记录。'],
  IMPORT_STALE: [409, '候选已更新，请重新核对。'],
  IMPORT_CONFIRMED: [409, '这条记录已经确认。'],
  IMPORT_INVALID_CHOICE: [409, '请选择当前核对中的地图候选。'],
  IMPORT_BUSY: [503, '图片处理繁忙，请稍后重试。'],
  NOT_IMPLEMENTED: [404, '接口尚未实现。'],
  NOT_FOUND: [404, '未找到本次雷达提案。'],
  PLACE_NOT_FOUND: [404, '地点已不可用，请重新搜索选择。'],
  MAP_UNAVAILABLE: [502, '地图服务暂不可用，请稍后重试。'],
  MAP_RATE_LIMITED: [429, '地图服务请求受限，请稍后重试。'],
  PROPOSAL_STALE: [409, '提案已过期或行程已更新，请重新计算。'],
  PROPOSAL_UNVALIDATED: [409, '提案未通过校验，请重新计算。'],
  NO_FEASIBLE_OPTION: [409, '没有可接受的可行候选。'],
  FIXED_LOCATION_REQUIRED: [409, '请在行程中补全固定安排地点，或明确选择本次不使用该安排。'],
  FIXED_LOCATION_UNRESOLVED: [409, '地图无法核验固定安排的地址，请在行程中补全门牌地址后重算。'],
  FIXED_TIME_INVALID: [409, '固定安排的时间在旅行时区中无效，请在行程中修改。'],
  IDEMPOTENCY_CONFLICT: [409, '同一确认标识已用于其他操作。'],
  ACCEPTANCE_MISMATCH: [409, '本次确认与要撤销的地点不匹配，请重新读取行程。'],
  TRIP_NOT_FOUND: [404, '未找到旅行或固定安排。'],
  TRIP_STALE: [409, '行程已更新，请重新读取后再编辑。'],
  INVALID_TRIP_DAY: [400, '请选择有效日期和时区，游玩结束时间须晚于开始时间且在同一天。'],
  INVALID_ARRANGEMENT_TIME: [400, '活动结束时间须晚于开始时间且在同一天。'],
  INTERNAL_ERROR: [500, '服务暂不可用。'],
} as const;

export function send(response: ServerResponse, status: number, value?: unknown) {
  const body = value === undefined ? undefined : JSON.stringify(value);
  response.writeHead(status);
  response.end(body);
}
export function sendError(response: ServerResponse, error: unknown) {
  const code =
    error instanceof RadarFault ||
    error instanceof MapFault ||
    error instanceof HttpFault ||
    error instanceof TripFault
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
  const body = await readBody(request, 8192);
  let value: unknown;
  try {
    value = JSON.parse(body.toString('utf8'));
  } catch {
    throw new HttpFault('INVALID_REQUEST');
  }
  if (!check(value)) throw new HttpFault('INVALID_REQUEST');
  return value;
}

export async function readBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    if (!Buffer.isBuffer(chunk)) throw new HttpFault('INVALID_REQUEST');
    bytes += chunk.length;
    if (bytes > limit) {
      request.resume();
      throw new HttpFault('REQUEST_TOO_LARGE');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

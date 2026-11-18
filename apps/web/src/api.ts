import {
  acceptReceiptValidator,
  placeSearchValidator,
  radarViewValidator,
  tripViewValidator,
} from '@nextstop/core';
import type {
  AcceptRadarInput,
  AcceptReceipt,
  RadarRequest,
  RadarView,
  TripView,
} from '@nextstop/core';

const REQUEST_TIMEOUT_MS = 10_000;

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

export function isCancellation(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

async function request(path: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await fetch(path, { ...init, signal: combined });
  } catch (error) {
    if (isCancellation(error)) throw error;
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new ApiError('TIMEOUT', '请求超时，请重试。', 0);
    }
    throw new ApiError('NETWORK', '网络请求失败，请检查连接后重试。', 0);
  }
  if (!response.ok) {
    let code = `HTTP_${response.status}`;
    let message = `请求失败（${response.status}）。`;
    try {
      const body: unknown = await response.json();
      if (body && typeof body === 'object' && 'error' in body) {
        const detail = body.error;
        if (typeof detail === 'object' && detail !== null) {
          if ('code' in detail && typeof detail.code === 'string' && detail.code)
            code = detail.code;
          if ('message' in detail && typeof detail.message === 'string' && detail.message)
            message = detail.message;
        }
      }
    } catch {
      // Keep the status-derived fallback when the error body is not JSON.
    }
    throw new ApiError(code, message, response.status);
  }
  return response;
}

async function requestJson<T>(
  path: string,
  init: RequestInit,
  check: (body: unknown) => body is T,
  signal?: AbortSignal,
): Promise<T> {
  const response = await request(path, init, signal);
  const body: unknown = await response.json();
  if (!check(body)) throw new ApiError('INVALID_RESPONSE', '服务响应格式无效。', response.status);
  return body;
}

function post(body: unknown, headers: Record<string, string> = {}): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  };
}

export async function createSession(signal?: AbortSignal): Promise<void> {
  await request('/api/v1/sessions', { method: 'POST' }, signal);
}

export async function getTrip(signal?: AbortSignal): Promise<TripView | null> {
  const response = await request('/api/v1/trip', {}, signal);
  const body: unknown = await response.json();
  if (body === null) return null;
  if (!tripViewValidator.check(body)) {
    throw new ApiError('INVALID_RESPONSE', '服务响应格式无效。', response.status);
  }
  return body;
}

export async function searchPlaces(query: string, signal?: AbortSignal) {
  const body = await requestJson(
    `/api/v1/places?q=${encodeURIComponent(query)}`,
    {},
    placeSearchValidator.check,
    signal,
  );
  return body.places;
}

export function createRadarSession(input: RadarRequest, signal?: AbortSignal): Promise<RadarView> {
  return requestJson('/api/v1/radar/sessions', post(input), radarViewValidator.check, signal);
}

export function getRadarSession(sessionId: string, signal?: AbortSignal): Promise<RadarView> {
  return requestJson(
    `/api/v1/radar/sessions/${encodeURIComponent(sessionId)}`,
    {},
    radarViewValidator.check,
    signal,
  );
}

export function acceptRadar(
  sessionId: string,
  input: AcceptRadarInput,
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<AcceptReceipt> {
  return requestJson(
    `/api/v1/radar/sessions/${encodeURIComponent(sessionId)}/accept`,
    post(input, { 'idempotency-key': idempotencyKey }),
    acceptReceiptValidator.check,
    signal,
  );
}

import {
  acceptReceiptValidator,
  placeSearchValidator,
  radarAcceptanceValidator,
  radarContextValidator,
  radarHistoryValidator,
  radarViewValidator,
  tripDetailValidator,
  tripListValidator,
} from '@nextstop/core';
import type {
  AcceptRadarInput,
  AcceptReceipt,
  RadarRequest,
  RadarView,
  RejectRadarInput,
  ProposalBinding,
  ArrangementInput,
  TripDay,
} from '@nextstop/core';

import { invalidateTripData } from './offline-trip.js';

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

export async function request(
  path: string,
  init: RequestInit,
  signal?: AbortSignal,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<Response> {
  const timeout = AbortSignal.timeout(timeoutMs);
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

export async function requestJson<T>(
  path: string,
  init: RequestInit,
  check: (body: unknown) => body is T,
  signal?: AbortSignal,
  timeoutMs?: number,
): Promise<T> {
  return readResponseJson(await request(path, init, signal, timeoutMs), check);
}

export async function readResponseJson<T>(response: Response, check: (body: unknown) => body is T) {
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

let startingSession: Promise<Response> | undefined;
let establishedGuest: symbol | undefined;
export async function createSession(signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  // Views can load together. Share the cookie-setting request.
  startingSession ??= request('/api/v1/sessions', { method: 'POST' })
    .then((response) => {
      if (response.headers.get('x-nextstop-new-session') === '1') {
        invalidateTripData(null, false);
        establishedGuest = Symbol();
      } else {
        establishedGuest ??= Symbol();
      }
      return response;
    })
    .finally(() => {
      startingSession = undefined;
    });
  await startingSession;
  signal?.throwIfAborted();
}

/** A read can validate an existing HttpOnly guest cookie without a preliminary POST. */
export async function readWithGuestSession<T>(
  read: () => Promise<T>,
  signal: AbortSignal,
  { readFirst = false } = {},
) {
  if (!readFirst && (!establishedGuest || startingSession)) await createSession(signal);
  signal.throwIfAborted();
  const guestAtRead = establishedGuest;
  try {
    return await read();
  } catch (error) {
    if (!(error instanceof ApiError) || error.code !== 'SESSION_REQUIRED') throw error;
    signal.throwIfAborted();
    // A late 401 from an older read must not invalidate a session already refreshed by another read.
    if (establishedGuest === guestAtRead) establishedGuest = undefined;
    if (!establishedGuest || startingSession) await createSession(signal);
    return read();
  }
}

const tripsPath = '/api/v1/trips';
const tripPath = (id: string) => `${tripsPath}/${encodeURIComponent(id)}`;

export function listTrips(signal?: AbortSignal) {
  return requestJson(tripsPath, {}, tripListValidator.check, signal);
}
export function getTripDetail(id: string, signal?: AbortSignal) {
  return requestJson(tripPath(id), {}, tripDetailValidator.check, signal);
}
export function createTrip(day: TripDay) {
  return requestJson(tripsPath, post(day), tripDetailValidator.check);
}
export function editTrip(id: string, revision: number, day: TripDay) {
  return requestJson(tripPath(id), post({ revision, day }), tripDetailValidator.check);
}
export function saveArrangement(
  id: string,
  revision: number,
  arrangement: ArrangementInput,
  arrangementId?: string,
) {
  const path = `${tripPath(id)}/arrangements`;
  return requestJson(
    arrangementId ? `${path}/${encodeURIComponent(arrangementId)}` : path,
    post({ revision, arrangement }),
    tripDetailValidator.check,
  );
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

export function getRadarContext(signal?: AbortSignal) {
  return requestJson('/api/v1/radar/context', {}, radarContextValidator.check, signal);
}

export function getRadarHistory(signal?: AbortSignal) {
  return requestJson('/api/v1/radar/history', {}, radarHistoryValidator.check, signal);
}

export function createRadarSession(input: RadarRequest, signal?: AbortSignal): Promise<RadarView> {
  return requestJson(
    '/api/v1/radar/sessions',
    post(input),
    radarViewValidator.check,
    signal,
    32_000,
  );
}

export function getRadarSession(sessionId: string, signal?: AbortSignal): Promise<RadarView> {
  return requestJson(
    `/api/v1/radar/sessions/${encodeURIComponent(sessionId)}`,
    {},
    radarViewValidator.check,
    signal,
  );
}

export function reviseRadar(
  sessionId: string,
  change:
    | { kind: 'reject'; input: RejectRadarInput }
    | { kind: 'recheck'; input: { binding: ProposalBinding } },
  signal?: AbortSignal,
) {
  return requestJson(
    `/api/v1/radar/sessions/${encodeURIComponent(sessionId)}/${change.kind}`,
    post(change.input),
    radarViewValidator.check,
    signal,
    32_000,
  );
}

const acceptancePath = (sessionId: string) =>
  `/api/v1/radar/sessions/${encodeURIComponent(sessionId)}/acceptance`;

export async function getRadarAcceptance(sessionId: string, signal?: AbortSignal) {
  try {
    return await requestJson(acceptancePath(sessionId), {}, radarAcceptanceValidator.check, signal);
  } catch (error) {
    if (error instanceof ApiError && error.code === 'NOT_FOUND') return null;
    throw error;
  }
}

export function undoRadarAcceptance(sessionId: string, stopId: string, signal?: AbortSignal) {
  return requestJson(
    `${acceptancePath(sessionId)}/undo`,
    post({ stop_id: stopId }),
    radarAcceptanceValidator.check,
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

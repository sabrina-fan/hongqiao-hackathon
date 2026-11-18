import { ERASE_BINDING_HEADER } from '@nextstop/core';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { expect, it, vi } from 'vitest';
import { createUserAccess } from '../radar/user-access.js';
import { handlePrivacy, privacyRoute } from './http.js';

it('rejects an old account confirmation before erasing or clearing the current guest', async () => {
  const request = new IncomingMessage(new Socket());
  request.method = 'DELETE';
  request.headers[ERASE_BINDING_HEADER] = 'a'.repeat(43);
  const route = privacyRoute(request, new URL('http://localhost/api/v1/me/data'));
  if (route?.kind !== 'erase') throw new Error('Missing erase route');

  const erase = vi.fn<ReturnType<typeof createUserAccess>['erase']>().mockResolvedValue(undefined);
  const withUser = Object.assign(createUserAccess('unused'), { erase });
  const response = new ServerResponse(request);
  const status = await handlePrivacy({
    route,
    response,
    userId: 'replacement-guest',
    dataDir: 'unused',
    withUser,
    sessions: { clear: () => 'cleared', eraseBinding: () => 'b'.repeat(43) },
  }).then(
    () => response.statusCode,
    (error: unknown) => error,
  );
  expect(status).toMatchObject({ code: 'SESSION_REQUIRED' });
  expect(erase).not.toHaveBeenCalled();
  expect(response.hasHeader('set-cookie')).toBe(false);
});

import { compile } from '@earendil-works/pi-schema';
import { editWishlistValidator, IdentifierSchema, wishlistFilterValidator } from '@nextstop/core';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpFault, readJson, send } from '../http.js';
import type { UserRuntime } from '../runtime/open-user-runtime.js';
import { editSavedPlace, readSavedPlace, readWishlist, removeSavedPlace } from './store.js';

const identifier = compile(IdentifierSchema);
export function wishlistRoute(method: string | undefined, path: string) {
  if (path === '/api/v1/wishlist' && method === 'GET') return { kind: 'list' } as const;
  const id = /^\/api\/v1\/wishlist\/amap\/([^/]+)$/.exec(path)?.[1];
  if (!identifier.check(id)) return null;
  if (method === 'GET') return { kind: 'detail', id } as const;
  if (method === 'PATCH') return { kind: 'edit', id } as const;
  if (method === 'DELETE') return { kind: 'remove', id } as const;
  return null;
}

export async function handleWishlist({
  request,
  response,
  route,
  params,
  withUser,
}: {
  request: IncomingMessage;
  response: ServerResponse;
  route: NonNullable<ReturnType<typeof wishlistRoute>>;
  params: URLSearchParams;
  withUser: <T>(run: (runtime: UserRuntime) => Promise<T>) => Promise<T>;
}) {
  switch (route.kind) {
    case 'list': {
      const filter = Object.fromEntries(params);
      if (!wishlistFilterValidator.check(filter)) throw new HttpFault('INVALID_REQUEST');
      return send(response, 200, await withUser((runtime) => readWishlist(runtime, filter)));
    }
    case 'detail':
      return send(response, 200, await withUser((runtime) => readSavedPlace(runtime, route.id)));
    case 'edit': {
      const edit = await readJson(request, editWishlistValidator.check);
      if (edit.visit === undefined && edit.note === undefined)
        throw new HttpFault('INVALID_REQUEST');
      return send(
        response,
        200,
        await withUser((runtime) => editSavedPlace(runtime, route.id, edit)),
      );
    }
    case 'remove':
      await withUser((runtime) => removeSavedPlace(runtime, route.id));
      return send(response, 204);
  }
}

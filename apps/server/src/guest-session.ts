import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

const cookieName = 'nextstop_guest';
const lifetime = 30 * 24 * 60 * 60;
const tokenPattern = /^([a-f0-9-]{36})\.(\d{1,12})\.([A-Za-z0-9_-]{43})$/;

export function createGuestSessions(secret: string, secure: boolean, now: () => number) {
  const sign = (payload: string) =>
    createHmac('sha256', secret).update(payload).digest('base64url');
  return {
    read(header: string | undefined) {
      const cookies = (header ?? '')
        .split(';')
        .map((item) => item.trim())
        .filter((item) => item.startsWith(`${cookieName}=`));
      if (cookies.length !== 1) return null;
      const match = cookies[0]?.slice(cookieName.length + 1).match(tokenPattern);
      if (!match) return null;
      const [, id, expires, signature] = match;
      if (!id || !expires || !signature || Number(expires) <= Math.floor(now() / 1000)) return null;
      return timingSafeEqual(Buffer.from(signature), Buffer.from(sign(`${id}.${expires}`)))
        ? id
        : null;
    },
    issue() {
      const payload = `${randomUUID()}.${Math.floor(now() / 1000) + lifetime}`;
      return `${cookieName}=${payload}.${sign(payload)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${lifetime}${secure ? '; Secure' : ''}`;
    },
  };
}

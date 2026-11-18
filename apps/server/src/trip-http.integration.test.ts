import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tripDetailValidator } from '@nextstop/core';
import { expect, it } from 'vitest';
import { createApp } from './app.js';

it('creates a Suzhou day trip and reloads its locked 17:30 arrangement', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'trip-http-'));
  const server = createApp({ dataDir, cookieSecret: randomBytes(32).toString('hex'), map: null });
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('TCP port required');
    const url = `http://127.0.0.1:${address.port}/api/v1`;
    const guest = await fetch(`${url}/sessions`, { method: 'POST' });
    const cookie = guest.headers.get('set-cookie')?.split(';')[0];
    if (!cookie) throw new Error('Missing session cookie');
    const headers = { cookie, 'content-type': 'application/json' };
    const day = {
      destination: '苏州',
      date: '2026-11-20',
      time_zone: 'Asia/Shanghai',
      start: '09:00',
      end: '20:00',
    };
    const created = await fetch(`${url}/trips`, {
      method: 'POST',
      headers,
      body: JSON.stringify(day),
    });
    expect(created.status).toBe(201);
    const initial: unknown = await created.json();
    if (!tripDetailValidator.check(initial)) throw new Error('Invalid created trip');
    const { trip_id, revision } = initial;
    const post = (target: string, body: unknown) =>
      fetch(target, { method: 'POST', headers, body: JSON.stringify(body) });
    const appointment = {
      name: '预约晚餐',
      start: '17:30',
      end: '18:30',
      address: '苏州平江路 10 号',
      locked: true,
    };
    const path = `${url}/trips/${trip_id}`;
    const saved = await fetch(`${path}/arrangements`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ revision, arrangement: appointment }),
    });
    expect(saved.status).toBe(200);
    const reloaded = await fetch(path, { headers });
    expect(reloaded.status).toBe(200);
    const before: unknown = await reloaded.json();
    if (!tripDetailValidator.check(before)) throw new Error('Invalid trip detail');
    expect(before).toMatchObject({
      trip_id,
      revision: revision + 1,
      day,
      arrangements: [appointment],
      warnings: [],
    });
    const locked = before.arrangements[0];
    if (!locked) throw new Error('Locked arrangement not found');

    const edit = await post(path, { revision: before.revision, day: { ...day, end: '19:00' } });
    expect(edit.status).toBe(200);
    const stale = await post(path, { revision: before.revision, day });
    expect(stale.status).toBe(409);
    for (const badDay of [
      { ...day, date: '2026-02-30' },
      { ...day, end: '08:00' },
      { ...day, time_zone: 'Moon/Base' },
    ]) {
      expect((await post(`${url}/trips`, badDay)).status).toBe(400);
    }
    const arrangements = `${path}/arrangements`;
    expect(
      (
        await post(arrangements, {
          revision: before.revision + 1,
          arrangement: { ...appointment, end: appointment.start },
        })
      ).status,
    ).toBe(400);
    const adjacent = await post(arrangements, {
      revision: before.revision + 1,
      arrangement: { ...appointment, name: '接续安排', start: '18:30', end: '19:00' },
    });
    expect(adjacent.status).toBe(200);
    expect(await adjacent.json()).toMatchObject({
      arrangements: [locked, { start: '18:30' }],
      warnings: [],
    });
    const overlap = await post(arrangements, {
      revision: before.revision + 2,
      arrangement: { ...appointment, name: '另一预约', start: '17:45', end: '18:15', address: ' ' },
    });
    expect(overlap.status).toBe(200);
    const final: unknown = await (await fetch(path, { headers })).json();
    if (!tripDetailValidator.check(final)) throw new Error('Invalid trip detail');
    const overlapping = final.arrangements[2];
    if (!overlapping) throw new Error('Overlapping arrangement not found');
    expect(final.revision).toBe(before.revision + 3);
    expect(final.arrangements[0]).toEqual(locked);
    expect(final.warnings).toEqual([
      {
        kind: 'overlap',
        arrangement_id: locked.arrangement_id,
        other_id: overlapping.arrangement_id,
      },
      { kind: 'missing_location', arrangement_id: overlapping.arrangement_id },
    ]);
    expect(await (await fetch(`${url}/trips`, { headers })).json()).toMatchObject({
      current_trip_id: trip_id,
      trips: [{ trip_id, revision: final.revision, day: { ...day, end: '19:00' } }],
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dataDir, { recursive: true, force: true });
  }
});

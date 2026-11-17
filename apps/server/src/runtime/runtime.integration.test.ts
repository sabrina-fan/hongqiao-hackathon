import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { RadarOutcome } from '@nextstop/core';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RadarResults } from './documents.js';
import { openUserRuntime } from './open-user-runtime.js';

type UserRuntime = Awaited<ReturnType<typeof openUserRuntime>>;
const runtimes: UserRuntime[] = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function emptyOutcome(session: string): RadarOutcome {
  return {
    kind: 'empty',
    reason_code: 'NO_FEASIBLE_OPTION',
    binding: {
      session_id: session,
      proposal_id: `proposal-${session}`,
      proposal_revision: 1,
      pool_revision: 1,
      eta_revision: 1,
      trip_id: null,
      trip_revision: 0,
    },
  };
}

async function open(dataDir: string, userId = 'guest-one') {
  const runtime = await openUserRuntime({ dataDir, userId });
  runtimes.push(runtime);
  return runtime;
}

describe('pi-durable 1.5.2 with real SQLite', () => {
  it('keeps two radar sessions separate and reloads committed results after reopening', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'nextstop-sqlite-'));
    directories.push(dataDir);
    const first = await open(dataDir);
    const conversationId = first.conversation.id;
    await first.conversation.commit(async (tx) => {
      const a = await tx.doc(RadarResults, conversationId, 'session-a', 'session-a');
      const b = await tx.doc(RadarResults, conversationId, 'session-b', 'session-b');
      a.outcome = emptyOutcome('session-a');
      b.outcome = emptyOutcome('session-b');
    }, BACKGROUND_CONTEXT);
    await first.close();
    runtimes.splice(runtimes.indexOf(first), 1);
    const reopened = await open(dataDir);
    expect(reopened.conversation.id).toBe(conversationId);
    const a = await reopened.harness.snapshot(
      RadarResults,
      conversationId,
      'session-a',
      BACKGROUND_CONTEXT,
    );
    const b = await reopened.harness.snapshot(
      RadarResults,
      conversationId,
      'session-b',
      BACKGROUND_CONTEXT,
    );
    expect(a?.outcome?.binding.session_id).toBe('session-a');
    expect(b?.outcome?.binding.session_id).toBe('session-b');
    expect(a?.validated).toBeNull();
  });
  it('prevents duplicate writers and traversal identifiers while allowing distinct user databases', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'nextstop-writers-'));
    directories.push(dataDir);
    await open(dataDir);
    await expect(openUserRuntime({ dataDir, userId: 'guest-one' })).rejects.toThrow(
      'active SQLite writer',
    );
    await expect(openUserRuntime({ dataDir, userId: '../guest-one' })).rejects.toThrow(
      'identifier',
    );
    const second = await open(dataDir, 'guest-two');
    expect(
      await second.harness.snapshot(
        RadarResults,
        second.conversation.id,
        'session-a',
        BACKGROUND_CONTEXT,
      ),
    ).toBeUndefined();
  });
  it('rolls back all document changes when a transaction fails', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'nextstop-rollback-'));
    directories.push(dataDir);
    const runtime = await open(dataDir);
    await expect(
      runtime.conversation.commit(async (tx) => {
        const record = await tx.doc(RadarResults, runtime.conversation.id, 'aborted', 'aborted');
        record.outcome = emptyOutcome('aborted');
        throw new Error('simulated transaction failure');
      }, BACKGROUND_CONTEXT),
    ).rejects.toThrow('simulated transaction failure');
    expect(
      await runtime.harness.snapshot(
        RadarResults,
        runtime.conversation.id,
        'aborted',
        BACKGROUND_CONTEXT,
      ),
    ).toBeUndefined();
  });
});

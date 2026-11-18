import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createRegistry, Harness } from '@earendil-works/pi-durable';
import type { Conversation, Cursor } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { compile } from '@earendil-works/pi-schema';
import { IdentifierSchema } from '@nextstop/core';
import { createModels, type RadarModel } from '@nextstop/model-gateway';
import { radarProposalTools } from '../radar/model-proposal.js';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const identifier = compile(IdentifierSchema);
const openPaths = new Set<string>();

export type UserRuntime = {
  harness: Harness;
  conversation: Conversation;
  familyKeys(kind: string): Promise<string[]>;
  close(): Promise<void>;
};

export async function openUserRuntime(input: {
  dataDir: string;
  userId: string;
  radarModel?: RadarModel | null;
}): Promise<UserRuntime> {
  if (!identifier.check(input.userId)) throw new Error('Invalid server-assigned user identifier');
  const directory = resolve(input.dataDir, 'users');
  const file = join(directory, `${input.userId}.sqlite`);
  if (openPaths.has(file)) throw new Error('This user already has an active SQLite writer');
  openPaths.add(file);
  let storage: Awaited<ReturnType<typeof openNodeSqliteStorage>> | undefined;
  let harness: Harness | undefined;
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    storage = await openNodeSqliteStorage(file);
    const registry = createRegistry();
    if (input.radarModel) registry.install(radarProposalTools);
    harness = await Harness.open(
      storage,
      {
        models: input.radarModel?.models ?? createModels(),
        registry,
        settings: {
          retry: { enabled: false },
          stream: { maxRetries: 0 },
          compaction: { enabled: false },
        },
        identity: { attribution: null },
      },
      BACKGROUND_CONTEXT,
    );
    const conversation = await harness.root(BACKGROUND_CONTEXT);
    const opened = harness;
    const store = storage;
    let closing: Promise<void> | undefined;
    return {
      harness: opened,
      conversation,
      async familyKeys(kind) {
        const query = {
          kind,
          at: 'current',
          scope: { kind: 'conversation', conversationId: conversation.id },
        } satisfies Parameters<typeof store.scanDocuments>[0];
        const keys: string[] = [];
        let cursor: Cursor | undefined;
        do {
          const page = await store.scanDocuments(query, 100, cursor, BACKGROUND_CONTEXT);
          for (const { key } of page.items) if (key !== undefined) keys.push(key);
          cursor = page.next;
        } while (cursor !== undefined);
        return keys;
      },
      close() {
        closing ??= opened.close(BACKGROUND_CONTEXT).finally(() => openPaths.delete(file));
        return closing;
      },
    };
  } catch (error) {
    try {
      if (harness) await harness.close(BACKGROUND_CONTEXT);
      else if (storage) await storage.close(BACKGROUND_CONTEXT);
    } finally {
      openPaths.delete(file);
    }
    throw error;
  }
}

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { defineDocFamily, type Tx } from '@earendil-works/pi-durable';
import { arr, compile, obj, str, type Static } from '@earendil-works/pi-schema';
import { pendingDeletionValidator, type PendingDeletion } from '@nextstop/core';
import type { UserRuntime } from '../runtime/open-user-runtime.js';

type Deletion =
  | PendingDeletion
  | { kind: 'batch_item'; batchId: string; imageId: string; revision: number };

const CleanupSchema = obj({ image_ids: arr(str({ pattern: '^imp-[a-f0-9-]{36}$' })) });
const cleanupValidator = compile(CleanupSchema);
const ImageCleanups = defineDocFamily<Static<typeof CleanupSchema>, string>({
  kind: 'nextstop.image_cleanup',
  version: 1,
  family: true,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ image_ids: [] }),
  checkpointWhen: () => true,
});

function cleanupKey(deletion: Deletion) {
  return deletion.kind === 'batch_item'
    ? `batch_item:${deletion.batchId}:${deletion.imageId}:${deletion.revision}`
    : `${deletion.kind}:${deletion.id}`;
}

// This family lookup only visits active cleanup records in this visitor's conversation.
export async function listPendingDeletions(runtime: UserRuntime): Promise<PendingDeletion[]> {
  const deletions: PendingDeletion[] = [];
  for (const key of await runtime.familyKeys(ImageCleanups.definition.kind)) {
    const match = /^(source|trip):(.*)$/.exec(key);
    if (!match) continue; // Batch-item replay records belong to the batch workflow.
    const [, kind, id] = match;
    const deletion = { kind, id };
    if (!pendingDeletionValidator.check(deletion)) throw new Error('Invalid stored cleanup key');
    deletions.push(deletion);
  }
  return deletions;
}

export async function recordImageCleanup(
  runtime: UserRuntime,
  tx: Tx,
  deletion: Deletion,
  imageIds: Iterable<string>,
) {
  const pending = { image_ids: [...imageIds] };
  if (!cleanupValidator.check(pending)) throw new Error('Invalid screenshot cleanup targets');
  const key = cleanupKey(deletion);
  const record = await tx.doc(ImageCleanups, runtime.conversation.id, key, key);
  record.image_ids = pending.image_ids;
}

// The caller holds the per-user queue through both the commit and filesystem cleanup.
export async function resumeImageCleanup(
  runtime: UserRuntime,
  deletion: Deletion,
  remove: (id: string) => Promise<void>,
) {
  const scope = runtime.conversation.id;
  const key = cleanupKey(deletion);
  const pending = await runtime.harness.snapshot(ImageCleanups, scope, key, BACKGROUND_CONTEXT);
  if (pending === undefined) return false;
  if (!cleanupValidator.check(pending)) throw new Error('Invalid stored screenshot cleanup');
  // A partial cleanup leaves the committed list in place. Removing an absent directory is safe.
  for (const id of pending.image_ids) await remove(id);
  if (deletion.kind === 'batch_item' && pending.image_ids.length === 0) return true;
  await runtime.conversation.commit(async (tx) => {
    if (deletion.kind === 'batch_item') {
      // Keep the request identity for replay without retaining old batch contents.
      const record = await tx.doc(ImageCleanups, scope, key, key);
      record.image_ids = [];
    } else {
      await tx.retireDoc(ImageCleanups, scope, key);
    }
  }, BACKGROUND_CONTEXT);
  return true;
}

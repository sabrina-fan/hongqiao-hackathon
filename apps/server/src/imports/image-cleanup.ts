import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { defineDocFamily, type Tx } from '@earendil-works/pi-durable';
import { arr, compile, obj, str, type Static } from '@earendil-works/pi-schema';
import {
  pendingBatchRemovalValidator,
  pendingDeletionValidator,
  pendingRetiredBatchRemovalValidator,
  type PendingBatchRemoval,
  type PendingDeletion,
  type PendingRetiredBatchRemoval,
} from '@nextstop/core';
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

async function readCleanup(runtime: UserRuntime, key: string) {
  const pending = await runtime.harness.snapshot(
    ImageCleanups,
    runtime.conversation.id,
    key,
    BACKGROUND_CONTEXT,
  );
  if (pending !== undefined && !cleanupValidator.check(pending))
    throw new Error('Invalid stored screenshot cleanup');
  return pending;
}

async function readPendingBatchRemoval(runtime: UserRuntime, key: string, batchId: string) {
  const pending = await readCleanup(runtime, key);
  if (!pending?.image_ids.length) return null;
  const [, , import_id, originalRevision] = key.split(':');
  const revision = Number(originalRevision);
  const removal = { import_id, revision };
  if (
    !pendingBatchRemovalValidator.check(removal) ||
    !Number.isSafeInteger(revision) ||
    cleanupKey({ kind: 'batch_item', batchId, imageId: removal.import_id, revision }) !== key ||
    pending.image_ids.length !== 1 ||
    pending.image_ids[0] !== removal.import_id
  )
    throw new Error('Invalid stored batch removal');
  return removal;
}

// Called only after a live batch has been read in the same per-user queue.
export async function listPendingBatchRemovals(runtime: UserRuntime, batchId: string) {
  const prefix = `batch_item:${batchId}:`;
  const removals: PendingBatchRemoval[] = [];
  for (const key of await runtime.familyKeys(ImageCleanups.definition.kind)) {
    if (!key.startsWith(prefix)) continue;
    const removal = await readPendingBatchRemoval(runtime, key, batchId);
    if (removal) removals.push(removal);
  }
  return removals;
}

export async function listPendingRetiredBatchRemovals(
  runtime: UserRuntime,
  activeBatchIds: ReadonlySet<string>,
) {
  const removals: PendingRetiredBatchRemoval[] = [];
  // The original cleanup record was committed with the owned batch mutation in this conversation.
  for (const key of await runtime.familyKeys(ImageCleanups.definition.kind)) {
    const [kind, batch_id] = key.split(':', 2);
    if (kind !== 'batch_item' || !batch_id || activeBatchIds.has(batch_id)) continue;
    const removal = await readPendingBatchRemoval(runtime, key, batch_id);
    if (!removal) continue;
    const deletion = { kind, batch_id, ...removal };
    if (!pendingRetiredBatchRemovalValidator.check(deletion))
      throw new Error('Invalid stored retired batch removal');
    removals.push(deletion);
  }
  return removals;
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
  const pending = await readCleanup(runtime, key);
  if (pending === undefined) return false;
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

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import {
  defineDocFamily,
  defineExtension,
  defineTool,
  type Conversation,
} from '@earendil-works/pi-durable';
import { obj, type Static } from '@earendil-works/pi-schema';
import { ModelProposalInputSchema, modelProposalInputValidator } from '@nextstop/core';
import type { RadarModel } from '@nextstop/model-gateway';
import type { UserRuntime } from '../runtime/open-user-runtime.js';
import { RadarFault } from './evidence.js';
import type { RecallSnapshot } from './recall-snapshot.js';
import { screenRecall } from './recall.js';

type Proposal = Static<typeof ModelProposalInputSchema>;
type CandidateSummary = { poi_id: string; saved: boolean };
const Draft = defineDocFamily<
  { candidates: CandidateSummary[]; proposal: Proposal | null },
  string
>({
  kind: 'nextstop.proposal',
  version: 1,
  family: true,
  scope: 'conversation',
  history: 'rewindable',
  fork: 'current',
  checkpointWhen: () => true,
  initial: () => ({ candidates: [], proposal: null }),
});
const key = 'current';
const query = defineTool({
  name: 'candidates_query',
  description: 'Read the current screened candidates.',
  parameters: obj({}),
  replay: 'safe',
  callers: ['model'],
  async execute(_args, api, context) {
    const draft = await api.snapshot(Draft, api.conversationId, key, context);
    return {
      output: [{ type: 'text', text: JSON.stringify(draft?.candidates ?? []) }],
      control: { terminate: true },
    };
  },
});
const propose = defineTool({
  name: 'candidates_propose',
  description: 'Propose only the screened IDs and qualitative reasons.',
  parameters: ModelProposalInputSchema,
  replay: 'safe',
  callers: ['model'],
  async execute(args, api, context) {
    await api.commit(async (tx) => {
      const draft = await tx.doc(Draft, api.conversationId, key, key);
      draft.proposal = args;
    }, context);
    return {
      output: [{ type: 'text', text: 'Proposal submitted for application validation.' }],
      control: { terminate: true },
    };
  },
});
export const radarProposalTools = defineExtension({
  name: 'nextstop-radar-proposal',
  tools: [query, propose],
});

async function run(conversation: Conversation, content: string) {
  const submission = await conversation.submit(
    { type: 'input', content, whenBusy: 'reject' },
    BACKGROUND_CONTEXT,
  );
  const result = await submission.wait(BACKGROUND_CONTEXT);
  if (result.status !== 'done') throw new RadarFault('RADAR_MODEL_UNAVAILABLE');
}

export async function modelReasons(
  runtime: UserRuntime,
  snapshot: RecallSnapshot,
  model: RadarModel,
) {
  const { feasible } = screenRecall(snapshot, Date.parse(snapshot.scanned_at));
  if (!feasible.length) return undefined;
  const conversation = await runtime.harness.createConversation(
    {
      ownership: { kind: 'ownerless' },
      agent: {
        model: model.ref,
        extensions: [radarProposalTools],
        tools: [query, propose],
        modelTools: [query],
        maxTurns: 1,
        instructions:
          'Use only the offered tool. Use screened IDs. Reasons must be short qualitative Chinese text about taking a walk or a saved preference. Do not assert hours, numbers, booking, prices or any outside facts.',
      },
    },
    BACKGROUND_CONTEXT,
  );
  await conversation.commit(async (tx) => {
    const doc = await tx.doc(Draft, conversation.id, key, key);
    doc.candidates = feasible.map(({ candidate }) => ({
      poi_id: candidate.place.id,
      saved: candidate.sources.includes('wishlist'),
    }));
  }, BACKGROUND_CONTEXT);
  await run(conversation, 'Call candidates_query exactly once.');
  await conversation.configure({ modelTools: [propose] }, BACKGROUND_CONTEXT);
  await run(
    conversation,
    'Call candidates_propose exactly once. Include each screened candidate exactly once.',
  );
  const draft = await runtime.harness.snapshot(Draft, conversation.id, key, BACKGROUND_CONTEXT);
  if (!modelProposalInputValidator.check(draft?.proposal)) return undefined;
  const { best, alternatives } = draft.proposal;
  const choices = [best, ...alternatives];
  const allowed = new Set(feasible.map(({ candidate }) => candidate.place.id));
  for (const { poi_id, reason_text, reason_code } of choices) {
    const original = feasible.find(({ pick }) => pick.choice.poi_id === poi_id);
    if (
      !allowed.delete(poi_id) ||
      !reason_text.trim() ||
      /[\p{N}]|分钟|公里|元|价格|预约|免费|营业|开放|闭馆|折扣/u.test(reason_text) ||
      (reason_code === 'saved_fit' && !original?.candidate.sources.includes('wishlist'))
    )
      return undefined;
  }
  return allowed.size === 0 ? new Map(choices.map((choice) => [choice.poi_id, choice])) : undefined;
}

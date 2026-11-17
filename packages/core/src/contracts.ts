import {
  arr,
  bool,
  compile,
  int,
  lit,
  nullable,
  num,
  obj,
  oneOf,
  str,
  union,
} from '@earendil-works/pi-schema';
import type { Static } from '@earendil-works/pi-schema';

export const IdentifierSchema = str({ pattern: '^[A-Za-z0-9_-]{1,100}$' });
export const RevisionSchema = int({ minimum: 1 });
const bindingFields = {
  session_id: IdentifierSchema,
  proposal_id: IdentifierSchema,
  proposal_revision: RevisionSchema,
  pool_revision: RevisionSchema,
  eta_revision: RevisionSchema,
};
export const BindingSchema = union([
  obj({ ...bindingFields, trip_id: lit(null), trip_revision: lit(0) }),
  obj({ ...bindingFields, trip_id: IdentifierSchema, trip_revision: RevisionSchema }),
]);
export type ProposalBinding = Static<typeof BindingSchema>;

export const ReasonCodeSchema = oneOf(['saved_fit', 'short_detour', 'basic_fit']);
const ModelPickSchema = obj({
  poi_id: IdentifierSchema,
  reason_code: ReasonCodeSchema,
  reason_text: str({ maxLength: 160 }),
});
export const ModelProposalInputSchema = obj({
  best: ModelPickSchema,
  alternatives: arr(ModelPickSchema, { maxItems: 2 }),
});
export const modelProposalInputValidator = compile(ModelProposalInputSchema);

export const RecommendationPickSchema = obj({
  choice: ModelPickSchema,
  travel_to_min: num({ minimum: 0 }),
  travel_to_next_min: nullable(num({ minimum: 0 })),
  stay_min_estimate: num({ minimum: 0 }),
  buffer_min: num({ minimum: 0 }),
  evidence: obj({
    provider: lit('amap'),
    fetched_at: str({ format: 'date-time' }),
    status: lit('estimated'),
  }),
});

export const RadarOutcomeSchema = union([
  obj({
    kind: lit('empty'),
    binding: BindingSchema,
    reason_code: lit('NO_FEASIBLE_OPTION'),
  }),
  obj({
    kind: lit('recommendations'),
    binding: BindingSchema,
    best: RecommendationPickSchema,
    alternatives: arr(RecommendationPickSchema, { maxItems: 2 }),
  }),
]);
export type RadarOutcome = Static<typeof RadarOutcomeSchema>;
export const radarOutcomeValidator = compile(RadarOutcomeSchema);

export const CapabilitiesSchema = obj({
  stage: lit('scaffold'),
  radar: bool(),
  imports: bool(),
  trip_writes: bool(),
  model_calls: bool(),
});
export type Capabilities = Static<typeof CapabilitiesSchema>;
export const capabilitiesValidator = compile(CapabilitiesSchema);

export const ReadySchema = obj({
  status: lit('ok'),
  service: lit('nextstop'),
  stage: lit('scaffold'),
});
export const readyValidator = compile(ReadySchema);

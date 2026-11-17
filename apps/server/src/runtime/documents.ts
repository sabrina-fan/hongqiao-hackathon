import { defineDocFamily } from '@earendil-works/pi-durable';
import { nullable, obj } from '@earendil-works/pi-schema';
import type { Static } from '@earendil-works/pi-schema';
import { BindingSchema, RadarOutcomeSchema } from '@nextstop/core';

export const RadarRecordSchema = obj({
  outcome: nullable(RadarOutcomeSchema),
  validated: nullable(BindingSchema),
});
export type RadarRecord = Static<typeof RadarRecordSchema>;

export const RadarResults = defineDocFamily<RadarRecord, string>({
  kind: 'nextstop.radar_result',
  version: 1,
  family: true,
  scope: 'conversation',
  history: 'rewindable',
  fork: 'current',
  initial: () => ({ outcome: null, validated: null }),
  checkpointWhen: () => true,
});

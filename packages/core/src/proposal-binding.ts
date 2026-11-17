import type { ProposalBinding, RadarOutcome } from './contracts.js';

export function sameProposalBinding(left: ProposalBinding, right: ProposalBinding): boolean {
  return (
    left.session_id === right.session_id &&
    left.proposal_id === right.proposal_id &&
    left.proposal_revision === right.proposal_revision &&
    left.pool_revision === right.pool_revision &&
    left.eta_revision === right.eta_revision &&
    left.trip_id === right.trip_id &&
    left.trip_revision === right.trip_revision
  );
}

export function checkProposalBinding(input: {
  outcome: RadarOutcome;
  validated: ProposalBinding | null;
  current: ProposalBinding;
}): 'NO_FEASIBLE_OPTION' | 'PROPOSAL_UNVALIDATED' | 'PROPOSAL_STALE' | null {
  if (input.validated === null || !sameProposalBinding(input.outcome.binding, input.validated)) {
    return 'PROPOSAL_UNVALIDATED';
  }
  if (!sameProposalBinding(input.outcome.binding, input.current)) return 'PROPOSAL_STALE';
  return input.outcome.kind === 'empty' ? 'NO_FEASIBLE_OPTION' : null;
}

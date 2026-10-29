import type {LaneActivity, LaneRepairStatus} from '../../../../packages/core/src/types/lane-restoration.types'

/** A recorded invocation is required; a repair owner or authorized manual session is not a running agent. */
export function repairActivityLabel(attempt?: LaneRepairStatus, lane?: {id: string; activity?: LaneActivity}) {
  if (!attempt) return 'Repair execution unknown'
  switch (attempt.state) {
    case 'halted': return 'Repair halted'
    case 'stopped': return 'Repair stopped'
    case 'awaiting-fixer': return 'Awaiting repair agent'
    case 'needs-input': return 'Repair needs human input'
    case 'resumed': return 'Scheduling resumed'
    case 'working': return lane?.activity?.owner.kind === 'fixer' && lane.activity.owner.id === attempt.executionId
      && lane.id === attempt.laneId && attempt.current && attempt.startedAt && !attempt.finishedAt
      ? 'Repair running' : 'Repair execution unknown'
    default: return 'Repair execution unknown'
  }
}

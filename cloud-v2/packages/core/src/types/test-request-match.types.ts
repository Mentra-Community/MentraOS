import type {PortableRequirements} from './routine-job.types'
import type {ResourceCheckReport} from './resource-check-report.types'

export type MatchStatus = 'match' | 'blocked' | 'unknown' | 'deferred'
export type MatchCondition = {
  id: string; label: string; category: 'placement' | 'capability' | 'permission' | 'source' | 'storage' | 'physical' | 'ownership' | 'lifecycle'
  status: MatchStatus; expected: string; observed: string; observedAt?: string; nextAction?: string
}
export type RequestedResourceMatch = {
  kind: string; resourceId?: string; authorityHostId?: string; owner?: {id: string; kind: string; hostId: string; laneId?: string}
  conditions: MatchCondition[]; physicalReport?: ResourceCheckReport
}
/** Display facts from the same predicates as matching; never an admission or grant. */
export type TestRequestMatchReport = {
  requestId: string; state: string; observedAt: string; stage: string; reason: string; nextAction: string
  identity: {inputSha256?: string; definitionSha256?: string; definitionRevision?: string; appHeadSha?: string; deadline?: string}
  requirements?: {effective: PortableRequirements; declaredResources: PortableRequirements['resources']; human: string[]
    minimumRoutineApiVersion: number; minimumFrameworkVersion?: number; estimatedOutputBytes?: number
    target?: {hostId?: string; laneId?: string}}
  selected?: {hostId: string; laneId?: string; operationId?: string}
  lanes: {hostId: string; laneId: string; platform: string; state: string; dispatchMode: string; observedAt: string
    candidateMatch: MatchStatus; executionCompatibility: MatchStatus; conditions: MatchCondition[]; resources: RequestedResourceMatch[]}[]
  summary: {candidateLanes: number; structurallyCompatibleLanes: number; resources: {kind: string; presentLanes: number; capabilityMatchingLanes: number}[]}
  limits: string[]
}

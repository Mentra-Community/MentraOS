import {isDeepStrictEqual} from 'node:util'
import {z} from 'zod'
import {laneControlRecordSchema, resourceControlRecordSchema, type LaneControlRecord, type ResourceControlRecord} from '../types/lane-control.types'
import {reconcileControls} from './lane-controls.service'
import {manualWithdrawalNeedsRestoration} from '../types/resource-control-authority'
import {resourceLifecycleCurrentSchema, resourceLifecycleSubjectSchema, type ResourceLifecycleCurrent} from '../types/resource-lifecycle.types'
import type {TestHostState} from './test-host-state.service'
import {hostResourceReservationsSchema, isExclusiveHostReservation} from '../types/resource-reservations.types'

/** Existing host-row authority accompanies a snapshot; it is never supplied by the worker. */
export type ResourceReadinessAuthority = {resourceControlRecords?: unknown; resourceLifecycleCursor?: unknown; authorityReservations?: unknown}
export type ResourceReadinessHost = ResourceReadinessAuthority & {hostId: string; receivedAt: string | Date;
  snapshot: Pick<TestHostState, 'hostId' | 'lanes' | 'resources' | 'laneControls'> & {observedAt?: string; resourceLifecycle?: ResourceLifecycleCurrent}}

export type ResourceReadinessBlocker = {code: 'lane-resource-owned' | 'lane-operator-restriction' | 'resource-owned' |
  'resource-operator-restriction' | 'resource-restoration-required' | 'resource-baseline-unavailable' |
  'resource-idle-proof-unavailable' | 'resource-commissioning-required' | 'resource-not-enrolled' | 'host-report-unavailable'; laneId?: string; resourceId?: string; resourceKind?: string}

/** Authenticated envelope freshness does not depend on resource commissioning. */
export function resourceHostBlocker(host: ResourceReadinessHost, now: number): ResourceReadinessBlocker | undefined {
  const received = host.receivedAt instanceof Date ? host.receivedAt.getTime() : Date.parse(host.receivedAt),
    observed = Date.parse(host.snapshot.observedAt ?? '')
  if (![received, observed].every(at => Number.isFinite(at) && at <= now && now - at <= 120_000) || observed > received)
    return {code: 'host-report-unavailable'}
  return undefined
}

export function resourceLaneBlocker(host: ResourceReadinessAuthority, laneId: string,
  original?: {requestId: string; inputSha256: string; hostId: string}) {
  const records = reconcileControls(z.array(z.union([laneControlRecordSchema, resourceControlRecordSchema])).max(100).parse(host.resourceControlRecords ?? []))
    .filter((row): row is LaneControlRecord => 'laneId' in row.command && row.command.laneId === laneId)
  const mode = records.flatMap(row => row.receipt?.result.status === 'accepted' && row.receipt.result.mode ? [row.receipt.result.mode] : []).at(-1)
  if (!((mode === undefined || mode === 'automatic') && !records.some(row => !row.receipt || row.receipt.result.status === 'accepted' &&
    row.receipt.result.reservation && ['waiting', 'granted', 'returning'].includes(row.receipt.result.reservation.state))))
    return {code: 'lane-operator-restriction' as const, laneId}
  return undefined
}

export function resourceLaneAvailable(host: ResourceReadinessAuthority, laneId: string,
  original?: {requestId: string; inputSha256: string; hostId: string}) {
  return resourceLaneBlocker(host, laneId, original) === undefined
}

/** Baseline admission is independent of executable app/permission qualification. */
export function resourceBlocker(host: ResourceReadinessHost, resourceId: string, now: number, allowUnchecked = false,
  original?: {requestId: string; inputSha256: string; laneId: string}) {
  if (hostResourceReservationsSchema.parse(host.authorityReservations ?? []).some(claim => isExclusiveHostReservation(claim) && claim.resourceId === resourceId &&
    !(original && claim.owner.kind === 'run' && claim.owner.id === original.requestId && claim.origin?.kind === 'fleet' &&
      claim.origin.fleetInputSha256 === original.inputSha256 && claim.inputSha256 === original.inputSha256 &&
      claim.borrowerHostId === host.hostId && claim.laneId === original.laneId && claim.operationId === `run:${original.requestId}`))) return {code: 'resource-owned' as const, resourceId}
  const records = reconcileControls(z.array(z.union([laneControlRecordSchema, resourceControlRecordSchema])).max(100).parse(host.resourceControlRecords ?? []))
  const relevant = records.filter((row): row is ResourceControlRecord => 'subject' in row.command && row.command.subject.resourceId === resourceId)
  if (relevant.some(row => !row.receipt || row.receipt.result.status === 'accepted' &&
    row.receipt.result.reservation && ['waiting', 'granted', 'returning'].includes(row.receipt.result.reservation.state))) return {code: 'resource-operator-restriction' as const, resourceId}
  const raw = host.snapshot.resourceLifecycle?.subjects.find(value => value.subject.id === resourceId)
  const parsed = resourceLifecycleSubjectSchema.safeParse(raw), subject = parsed.success ? parsed.data : undefined
  const previous = host.resourceLifecycleCursor === undefined ? undefined : resourceLifecycleCurrentSchema.parse(host.resourceLifecycleCursor)
    .subjects.find(value => value.subject.id === resourceId)
  const resource = host.snapshot.resources?.find(value => value.id === resourceId) ?? host.snapshot.lanes
    .flatMap(lane => lane.resources).find(value => value.id === resourceId), contract = resource?.idleContract
  const hostBlocker = resourceHostBlocker(host, now)
  if (hostBlocker) return hostBlocker
  if ((host.snapshot.laneControls?.resourceControls !== true || ['network', 'workspace'].includes(resource?.kind ?? '')) &&
    !contract && !raw && !previous && !relevant.length) return undefined
  const received = host.receivedAt instanceof Date ? host.receivedAt.getTime() : Date.parse(host.receivedAt)
  const fresh = true
  if (relevant.some(row => manualWithdrawalNeedsRestoration(row, subject, host.hostId, fresh, now))) return {code: 'resource-restoration-required' as const, resourceId}
  const observed = Date.parse(subject?.observedAt ?? '')
  if (!fresh || !subject?.current || subject.subject.authorityHostId !== host.hostId || subject.owner !== null ||
    subject.repair.state !== 'none' || previous && (previous.subject.authorityHostId !== host.hostId || subject.generation < previous.generation) ||
    !Number.isFinite(observed) || observed > Date.parse(host.snapshot.observedAt ?? '') ||
    Date.parse(host.snapshot.observedAt ?? '') > received) return {code: 'resource-baseline-unavailable' as const, resourceId}
  // Host-only source preparation can tolerate an unknown app; an unassigned
  // phone check and its exact returned positive can tolerate an unknown phone.
  // Ordinary callers must supply that original candidate proof for the phone.
  if (allowUnchecked && !(resource?.kind === 'glasses' && contract?.conditions.includes('glasses-identity')) &&
      subject.status === 'unknown' && ['unknown', 'not-checked'].includes(subject.idle.outcome))
    return undefined
  const checked = Date.parse(subject.idle.checkedAt ?? ''), accepted = Date.parse(subject.idle.acceptedCheck?.acceptedAt ?? '')
  // Passed physical facts remain tied to the current generation, installed
  // contract and unowned custody. The authenticated host report stays fresh.
  if (!(!!contract && subject.status === 'idle' && subject.idle.outcome === 'passed' && subject.idle.acceptedCheck?.subjectGeneration === subject.generation &&
    subject.idle.qualifiedScope.kind !== 'unqualified' && Number.isFinite(checked) && checked <= now &&
    Number.isFinite(accepted) && accepted >= checked && accepted <= observed &&
    subject.idle.contractVersion === contract.version && isDeepStrictEqual(subject.idle.qualifiedScope, contract.qualifiedScope)))
    return {code: 'resource-idle-proof-unavailable' as const, resourceId}
  if (resource?.kind === 'glasses' && contract.conditions.includes('glasses-identity') &&
      subject.idle.report?.conditions.find(condition => condition.id === 'glasses-assigned-phone-ble-owner')?.status !== 'passed')
    return {code: 'resource-commissioning-required' as const, resourceId}
  return undefined
}

/** Candidate eligibility may tolerate an unchecked app; current execution
 * still requires its declared passed baseline and separate job preparation. */
export function resourceCandidateBlocker(host: ResourceReadinessHost, resourceId: string, now: number,
  original?: {requestId: string; inputSha256: string; laneId: string}) {
  return resourceBlocker(host, resourceId, now, true, original)
}

export function resourceAvailable(host: ResourceReadinessHost, resourceId: string, now: number, allowUnchecked = false,
  original?: {requestId: string; inputSha256: string; laneId: string}) {
  return resourceBlocker(host, resourceId, now, allowUnchecked, original) === undefined
}

/** Caller-specific candidate exceptions remain explicit; resource authority and
 * first refusal order are shared by routing and ordinary admission. */
export function requiredResourceBlocker<Requirement extends {kind: string}>(host: ResourceReadinessHost,
  lane: ResourceReadinessHost['snapshot']['lanes'][number], requirements: readonly Requirement[], now: number,
  allowUnchecked: (required: Requirement, resource: typeof lane.resources[number]) => boolean,
  original?: {requestId: string; inputSha256: string}): ResourceReadinessBlocker | undefined {
  const hostBlocker = resourceHostBlocker(host, now)
  if (hostBlocker) return hostBlocker
  for (const required of requirements) {
    const resource = lane.resources.find(value => value.kind === required.kind)
    if (!resource) return {code: 'resource-not-enrolled', laneId: lane.id, resourceKind: required.kind}
    const blocker = resourceBlocker(host, resource.id, now, allowUnchecked(required, resource),
      original && {...original, laneId: lane.id})
    if (blocker) return blocker
  }
  return undefined
}

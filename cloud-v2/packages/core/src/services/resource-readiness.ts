import {isDeepStrictEqual} from 'node:util'
import {z} from 'zod'
import {laneControlRecordSchema, resourceControlRecordSchema, type LaneControlRecord, type ResourceControlRecord} from '../types/lane-control.types'
import {reconcileControls} from './lane-controls.service'
import {manualWithdrawalNeedsRestoration} from '../types/resource-control-authority'
import {resourceLifecycleSchema, resourceLifecycleSubjectSchema} from '../types/resource-lifecycle.types'
import type {TestHostState} from './test-host-state.service'
import {hostResourceReservationsSchema, isExclusiveHostReservation} from '../types/resource-reservations.types'

/** Existing host-row authority accompanies a snapshot; it is never supplied by the worker. */
export type ResourceReadinessAuthority = {resourceControlRecords?: unknown; resourceLifecycleCursor?: unknown; authorityReservations?: unknown}
export type ResourceReadinessHost = ResourceReadinessAuthority & {hostId: string; receivedAt: string | Date;
  snapshot: Pick<TestHostState, 'hostId' | 'lanes' | 'resources' | 'resourceLifecycle' | 'laneControls'> & {observedAt?: string}}

export function resourceLaneAvailable(host: ResourceReadinessAuthority, laneId: string,
  original?: {requestId: string; inputSha256: string; hostId: string}) {
  // Byte claims can precede the worker's local status update. Only this original
  // may continue its same-lane claim; other lanes sharing the disk remain independent.
  if (hostResourceReservationsSchema.parse(host.authorityReservations ?? []).some(claim => !isExclusiveHostReservation(claim) && claim.laneId === laneId &&
    !(original && claim.requestId === original.requestId && claim.fleetInputSha256 === original.inputSha256 && claim.hostId === original.hostId))) return false
  const records = reconcileControls(z.array(z.union([laneControlRecordSchema, resourceControlRecordSchema])).max(100).parse(host.resourceControlRecords ?? []))
    .filter((row): row is LaneControlRecord => 'laneId' in row.command && row.command.laneId === laneId)
  const mode = records.flatMap(row => row.receipt?.result.status === 'accepted' && row.receipt.result.mode ? [row.receipt.result.mode] : []).at(-1)
  return (mode === undefined || mode === 'automatic') && !records.some(row => !row.receipt || row.receipt.result.status === 'accepted' &&
    row.receipt.result.reservation && ['waiting', 'granted', 'returning'].includes(row.receipt.result.reservation.state))
}

/** Baseline admission is independent of executable app/permission qualification. */
export function resourceAvailable(host: ResourceReadinessHost, resourceId: string, now: number, allowUnchecked = false,
  original?: {requestId: string; inputSha256: string; laneId: string}) {
  if (hostResourceReservationsSchema.parse(host.authorityReservations ?? []).some(claim => isExclusiveHostReservation(claim) && claim.resourceId === resourceId &&
    !(original && claim.owner.kind === 'run' && claim.owner.id === original.requestId && claim.origin?.kind === 'fleet' &&
      claim.origin.fleetInputSha256 === original.inputSha256 && claim.inputSha256 === original.inputSha256 &&
      claim.borrowerHostId === host.hostId && claim.laneId === original.laneId && claim.operationId === `run:${original.requestId}`))) return false
  const records = reconcileControls(z.array(z.union([laneControlRecordSchema, resourceControlRecordSchema])).max(100).parse(host.resourceControlRecords ?? []))
  const relevant = records.filter((row): row is ResourceControlRecord => 'subject' in row.command && row.command.subject.resourceId === resourceId)
  if (relevant.some(row => !row.receipt || row.receipt.result.status === 'accepted' &&
    (row.receipt.result.reservation && ['waiting', 'granted', 'returning'].includes(row.receipt.result.reservation.state) ||
      row.receipt.result.check && row.receipt.result.check.state !== 'settled'))) return false
  const raw = host.snapshot.resourceLifecycle?.subjects.find(value => value.subject.id === resourceId)
  const parsed = resourceLifecycleSubjectSchema.safeParse(raw), subject = parsed.success ? parsed.data : undefined
  const previous = host.resourceLifecycleCursor === undefined ? undefined : resourceLifecycleSchema.parse(host.resourceLifecycleCursor)
    .subjects.find(value => value.subject.id === resourceId)
  const resource = host.snapshot.resources?.find(value => value.id === resourceId) ?? host.snapshot.lanes
    .flatMap(lane => lane.resources).find(value => value.id === resourceId), contract = resource?.idleContract
  if (host.snapshot.laneControls?.resourceControls !== true && !contract && !raw && !previous && !relevant.length) return true
  const received = host.receivedAt instanceof Date ? host.receivedAt.getTime() : Date.parse(host.receivedAt)
  const fresh = [received, Date.parse(host.snapshot.observedAt ?? '')].every(at => Number.isFinite(at) && at <= now && now - at <= 120_000)
  if (relevant.some(row => manualWithdrawalNeedsRestoration(row, subject, host.hostId, fresh, now))) return false
  const observed = Date.parse(subject?.observedAt ?? '')
  if (!fresh || !subject?.current || subject.subject.authorityHostId !== host.hostId || subject.owner !== null ||
    subject.repair.state !== 'none' || previous && (previous.subject.authorityHostId !== host.hostId || subject.generation < previous.generation) ||
    !Number.isFinite(observed) || observed > Date.parse(host.snapshot.observedAt ?? '') ||
    Date.parse(host.snapshot.observedAt ?? '') > received || now - observed > 120_000) return false
  // Host-only source preparation can tolerate an unknown app; an unassigned
  // phone check and its exact returned positive can tolerate an unknown phone.
  // Ordinary callers must supply that original candidate proof for the phone.
  if (allowUnchecked && subject.status === 'unknown' && ['unknown', 'not-checked'].includes(subject.idle.outcome)) return true
  const checked = Date.parse(subject.idle.checkedAt ?? ''), accepted = Date.parse(subject.idle.acceptedCheck?.acceptedAt ?? '')
  return !!contract && subject.status === 'idle' && subject.idle.outcome === 'passed' && subject.idle.acceptedCheck?.subjectGeneration === subject.generation &&
    subject.idle.qualifiedScope.kind !== 'unqualified' && Number.isFinite(checked) && checked <= now &&
    now - checked <= (contract?.maximumAgeMs ?? 120_000) && Number.isFinite(accepted) && accepted >= checked && accepted <= observed &&
    subject.idle.contractVersion === contract.version && isDeepStrictEqual(subject.idle.qualifiedScope, contract.qualifiedScope)
}

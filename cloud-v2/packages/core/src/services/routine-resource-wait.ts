import {recorderStorageAvailable, recorderStorageObservationSchema, STORAGE_OBSERVATION_MAX_AGE_MS, type RecorderStorageObservation} from '../types/recorder-storage.types';
import {fleetResourceAdmissionSchema, isExclusiveHostReservation, type ExclusiveResourceDependency} from '../types/resource-reservations.types';
import type {StoredRoutineJob} from '../types/routine-job.types';
import type {RoutingTestHostState} from './test-host-state.service';

export const RESOURCE_ADMISSION_WAIT = 'Awaiting available required resources on a compatible runner';
export const RECORDER_CAPACITY_WAIT = 'Awaiting available recorder disk and evidence staging capacity on a compatible runner';
export const RECORDER_OBSERVATION_WAIT = 'Awaiting a fresh recorder disk and evidence staging observation on a compatible runner';
export const sharedResourceWait = (capability?: string) => capability === 'google-authentication'
  ? 'Waiting for the shared Google test account to be returned by another lane'
  : 'Waiting for a required shared resource to be returned by another lane';

export function recorderWait(observation: RecorderStorageObservation | undefined, minimumAvailableBytes: number, now: number, unobservedOutputBytes = 0) {
  const parsed = recorderStorageObservationSchema.safeParse(observation);
  if (!parsed.success || Date.parse(parsed.data.observedAt) > now || now - Date.parse(parsed.data.observedAt) > STORAGE_OBSERVATION_MAX_AGE_MS)
    return RECORDER_OBSERVATION_WAIT;
  if (!Number.isSafeInteger(unobservedOutputBytes) || unobservedOutputBytes < 0) return RESOURCE_ADMISSION_WAIT;
  return recorderStorageAvailable(parsed.data, {minimumAvailableBytes}, now, unobservedOutputBytes) ? undefined : RECORDER_CAPACITY_WAIT;
}

/** Display only. The staged request and existing authority claims remain the admission source of truth. */
export function sharedResourceWaitingReason(row: StoredRoutineJob, hosts: RoutingTestHostState[]): string | undefined {
  const parsed = fleetResourceAdmissionSchema.safeParse(row.fleetResourceAdmission);
  const admission = parsed.success ? parsed.data : undefined;
  if (!admission || admission.intent.owner.kind !== 'run' || admission.intent.owner.id !== row.requestId ||
      admission.intent.inputSha256 !== row.fleetInputSha256 || row.fleetBinding || row.fleetCancellation || row.state !== 'awaiting-runner') return undefined;
  for (const dependency of admission.dependencies) {
    const authority = hosts.find(host => host.hostId === dependency.authorityHostId);
    const blocked = authority?.authorityReservations?.filter(isExclusiveHostReservation).find(claim =>
      claim.resourceId === dependency.resourceId && claim.authorityHostId === dependency.authorityHostId &&
      !(claim.owner.kind === 'run' && claim.owner.id === row.requestId &&
        claim.borrowerHostId === admission.intent.hostId && claim.laneId === admission.intent.laneId));
    if (blocked) return sharedResourceWait(dependency.capability);
  }
  return undefined;
}

export function dependencyWaitingReason(dependencies: ExclusiveResourceDependency[] | undefined, resourceId: string) {
  return sharedResourceWait(dependencies?.find(dependency => dependency.resourceId === resourceId)?.capability);
}

import {backendConnectivityObservationMatches, BACKEND_CONNECTIVITY_ROUTINE_API_VERSION, type BackendConnectivityContext} from '../types/backend-connectivity.types'
import {recorderStorageAvailable} from '../types/recorder-storage.types'
import {permissionObservationMatches} from '../types/resource-permissions.types'
import type {FrameworkBinding} from '../types/framework-version.types'
import type {PortableRequirements} from '../types/routine-job.types'
import type {RoutingTestHostState} from './test-host-state.service'

export type RoutineLaneEligibilityContext = {now: number; binding: FrameworkBinding; app?: {headSha: string; archiveSha256: string; receiptSha256: string}; backend?: BackendConnectivityContext}
export type RoutineLaneRequirementBlocker = {code: 'lane-shape-incompatible' | 'job-resource-incompatible' | 'job-glasses-incompatible'; resourceKind?: string}

/** Pure exact-job compatibility. Baseline ownership/freshness remains separate,
 * and structural callers explicitly choose the existing backend-health mode. */
export function routineLaneRequirementBlocker(requirements: PortableRequirements, lane: RoutingTestHostState['lanes'][number],
  context?: RoutineLaneEligibilityContext, now = context?.now ?? Date.now(), backendHealth = true): RoutineLaneRequirementBlocker | undefined {
  if (lane.platform !== requirements.platform || (lane.glasses?.length ?? 0) > 1 ||
    new Set(lane.resources.map(resource=>resource.kind)).size!==lane.resources.length) return {code: 'lane-shape-incompatible'};
  for (const required of requirements.resources) {
    if (!lane.resources.some(offered => offered.kind === required.kind &&
      required.capabilities.every(capability => offered.capabilities?.includes(capability)) &&
      (required.kind !== 'phone' || !required.capabilities.includes('backend-connectivity') || Boolean(context &&
        (backendHealth ? backendConnectivityObservationMatches(offered.backendConnectivity, offered.id, context) :
          context.binding.routineApiVersion >= BACKEND_CONNECTIVITY_ROUTINE_API_VERSION))) &&
      (!required.storage || recorderStorageAvailable(offered.storage, required.storage, now)) &&
      (required.permissions ?? []).every(value => Boolean(context && permissionObservationMatches(
        offered.permissionObservations?.find(observation => observation.permission === value.permission), value.permission,
        {...context, recipient: value.recipient}))))) return {code: 'job-resource-incompatible', resourceKind: required.kind};
  }
  if (requirements.glasses && !lane.glasses?.some(offered => requirements.glasses!.models.includes(offered.model) &&
    requirements.glasses!.capabilities.every(capability => offered.capabilities.includes(capability)))) return {code: 'job-glasses-incompatible'};
  return undefined;
}

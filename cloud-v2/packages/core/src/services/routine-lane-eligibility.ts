import {currentBackendConnectivityObservation, BACKEND_CONNECTIVITY_ROUTINE_API_VERSION, type BackendConnectivityContext} from '../types/backend-connectivity.types'
import {recorderStorageAvailable} from '../types/recorder-storage.types'
import {permissionObservationMatches} from '../types/resource-permissions.types'
import type {FrameworkBinding} from '../types/framework-version.types'
import type {PortableRequirements} from '../types/routine-job.types'
import type {RoutingTestHostState} from './test-host-state.service'
import type {MatchCondition} from '../types/test-request-match.types'
import {recorderWait, RECORDER_OBSERVATION_WAIT} from './routine-resource-wait'

export type RoutineLaneEligibilityContext = {now: number; binding: FrameworkBinding; app?: {headSha: string; archiveSha256: string; receiptSha256: string}; backend?: BackendConnectivityContext}
export type RoutineLaneRequirementBlocker = {code: 'lane-shape-incompatible' | 'job-resource-incompatible' | 'job-glasses-incompatible'; resourceKind?: string}

/** Pure exact-job compatibility. Baseline ownership/freshness remains separate,
 * and structural callers explicitly choose the existing backend-health mode. */
export function routineLaneRequirementBlocker(requirements: PortableRequirements, lane: RoutingTestHostState['lanes'][number],
  context?: RoutineLaneEligibilityContext, now = context?.now ?? Date.now(), backendHealth = true): RoutineLaneRequirementBlocker | undefined {
  return evaluateRoutineLaneRequirements(requirements, lane, context, now, backendHealth).blocker
}

/** One evaluator supplies both the original first refusal and the complete display checklist. */
export function evaluateRoutineLaneRequirements(requirements: PortableRequirements, lane: RoutingTestHostState['lanes'][number],
  context?: RoutineLaneEligibilityContext, now = context?.now ?? Date.now(), backendHealth = true): {
    blocker?: RoutineLaneRequirementBlocker; conditions: MatchCondition[]; resources: {kind: string; resourceId?: string; conditions: MatchCondition[]}[]
  } {
  const conditions: MatchCondition[] = [{id: 'platform', label: 'Platform', category: 'placement',
    status: lane.platform === requirements.platform ? 'match' : 'blocked', expected: requirements.platform, observed: lane.platform}]
  const validShape = (lane.glasses?.length ?? 0) <= 1 && new Set(lane.resources.map(resource => resource.kind)).size === lane.resources.length
  conditions.push({id: 'lane-shape', label: 'Unambiguous resource inventory', category: 'placement', status: validShape ? 'match' : 'blocked',
    expected: 'One offered resource per kind and at most one glasses model', observed: `${lane.resources.map(resource => resource.kind).join(', ')}; ${lane.glasses?.length ?? 0} glasses models`})
  if (lane.platform !== requirements.platform || (lane.glasses?.length ?? 0) > 1 ||
    new Set(lane.resources.map(resource=>resource.kind)).size!==lane.resources.length) return {blocker: {code: 'lane-shape-incompatible'}, conditions,
      resources: requirements.resources.map(required => ({kind: required.kind, conditions: [{id: 'lane-shape', label: 'Resource evaluation', category: 'placement',
        status: 'unknown', expected: 'Matching platform with unique resource kinds and one glasses model', observed: 'Not evaluated: lane shape is incompatible'}]}))}
  const resources: ReturnType<typeof evaluateRoutineLaneRequirements>['resources'] = []
  let blocker: RoutineLaneRequirementBlocker | undefined
  for (const required of requirements.resources) {
    const offered = lane.resources.find(value => value.kind === required.kind)
    const checks: MatchCondition[] = [{id: 'provider', label: 'Requested resource', category: 'placement',
      status: offered ? 'match' : 'blocked', expected: required.kind, observed: offered?.id ?? 'No provider reported'}]
    if (!offered) checks.push(...required.capabilities.map(capability => ({id: `capability:${capability}`, label: capability, category: 'capability' as const,
      status: 'unknown' as const, expected: capability, observed: 'Not evaluated: no provider of this requested kind'})),
      ...(required.permissions ?? []).map(value => ({id: `permission:${value.recipient}:${value.permission}`, label: `${value.recipient} ${value.permission}`, category: 'permission' as const,
        status: 'unknown' as const, expected: 'Current permission observation for this exact recipient', observed: 'Not evaluated: no provider; absence is not denial'})),
      ...(required.storage ? [{id: 'storage', label: 'Effective recorder capacity', category: 'storage' as const, status: 'unknown' as const,
        expected: `${required.storage.minimumAvailableBytes} bytes plus current reservations`, observed: 'Not evaluated: no recorder provider'}] : []))
    if (offered) {
      for (const capability of required.capabilities) checks.push({id: `capability:${capability}`, label: capability, category: 'capability',
        status: offered.capabilities?.includes(capability) ? 'match' : 'blocked', expected: capability,
        observed: offered.capabilities?.includes(capability) ? 'Supported by this resource' : 'Capability is absent from the current offer'})
      if (required.kind === 'phone' && required.capabilities.includes('backend-connectivity')) {
        const current = context && backendHealth ? currentBackendConnectivityObservation(offered.backendConnectivity, offered.id, context) : undefined
        const matches = Boolean(context && (backendHealth ? current?.outcome === 'qualified' : context.binding.routineApiVersion >= BACKEND_CONNECTIVITY_ROUTINE_API_VERSION))
        checks.push({id: 'backend-connectivity', label: backendHealth ? 'Exact returned phone connection check' : 'Phone check source compatibility',
          category: backendHealth ? 'physical' : 'source', status: matches ? 'match' : !context || backendHealth && (!current || current.outcome === 'unknown') ? 'unknown' : 'blocked',
          expected: backendHealth ? 'Current qualified observation for this phone, app, controller, source and returned generation' : `Routine API >= ${BACKEND_CONNECTIVITY_ROUTINE_API_VERSION}`,
          observed: backendHealth ? offered.backendConnectivity ? `${offered.backendConnectivity.outcome}; ${current ? 'current exact observation' : 'freshness or exact selected identity is not established'}` :
            'No phone connection observation; this is not a reported failed connection' : context ? `Routine API ${context.binding.routineApiVersion}` : 'Accepted framework source is absent',
          ...(offered.backendConnectivity && backendHealth ? {observedAt: offered.backendConnectivity.observedAt} : {})})
      }
      if (required.storage) {
        const matches = recorderStorageAvailable(offered.storage, required.storage, now)
        checks.push({id: 'storage', label: 'Effective recorder capacity', category: 'storage', status: matches ? 'match' : recorderWait(offered.storage, required.storage.minimumAvailableBytes, now) === RECORDER_OBSERVATION_WAIT ? 'unknown' : 'blocked',
          expected: `${required.storage.minimumAvailableBytes} bytes plus current output reservations; staging must cover pending evidence and output`,
          observed: offered.storage ? `Available ${offered.storage.availableBytes}; staging ${offered.storage.stagingBudgetBytes}; pending evidence ${offered.storage.pendingEvidenceBytes}; reserved output ${offered.storage.reservations.reduce((sum, row) => sum + row.remainingOutputBytes, 0)} bytes` : 'No recorder capacity observation',
          ...(offered.storage ? {observedAt: offered.storage.observedAt} : {})})
      }
      for (const value of required.permissions ?? []) {
        const observation = offered.permissionObservations?.find(row => row.permission === value.permission)
        const deferred = !backendHealth && lane.platform === 'ios-on-mac' && value.recipient === 'app'
        const matches = Boolean(context && permissionObservationMatches(observation, value.permission, {...context, recipient: value.recipient}))
        const current = Boolean(context && observation && permissionObservationMatches({...observation, status: 'granted'}, value.permission, {...context, recipient: value.recipient}))
        checks.push({id: `permission:${value.recipient}:${value.permission}`, label: `${value.recipient} ${value.permission}`, category: 'permission',
          status: deferred ? 'deferred' : matches ? 'match' : current && (observation?.status === 'denied' || observation?.status === 'blocked') ? 'blocked' : 'unknown',
          expected: deferred ? 'Checked after the selected app is installed and owned' : 'Fresh granted observation for the exact recipient and selected source',
          observed: observation ? `${observation.status}; recipient ${observation.recipient.kind}; ${current ? 'current selection' : 'not established for the current selection'}` : 'No observation; absence is not denial',
          ...(observation ? {observedAt: observation.observedAt} : {})})
      }
    }
    if (!blocker && checks.some(value => value.status === 'blocked' || value.status === 'unknown')) blocker = {code: 'job-resource-incompatible', resourceKind: required.kind}
    resources.push({kind: required.kind, ...(offered ? {resourceId: offered.id} : {}), conditions: checks})
  }
  if (requirements.glasses) {
    const matches = Boolean(lane.glasses?.some(offered => requirements.glasses!.models.includes(offered.model) && requirements.glasses!.capabilities.every(capability => offered.capabilities.includes(capability))))
    conditions.push({id: 'glasses', label: 'Glasses model and capabilities', category: 'capability', status: matches ? 'match' : 'blocked',
      expected: `${requirements.glasses.models.join(', ')}; ${requirements.glasses.capabilities.join(', ')}`, observed: (lane.glasses ?? []).map(value => `${value.model}: ${value.capabilities.join(', ')}`).join('; ') || 'No glasses inventory'})
    if (!matches && !blocker) blocker = {code: 'job-glasses-incompatible'}
  }
  return {conditions, resources, ...(blocker ? {blocker} : {})}
}

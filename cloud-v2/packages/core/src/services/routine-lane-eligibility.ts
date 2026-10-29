import {currentBackendConnectivityObservation, BACKEND_CONNECTIVITY_ROUTINE_API_VERSION, type BackendConnectivityContext} from '../types/backend-connectivity.types'
import {recorderStorageAvailable} from '../types/recorder-storage.types'
import {permissionObservationMatches} from '../types/resource-permissions.types'
import type {FrameworkBinding} from '../types/framework-version.types'
import type {PortableRequirements} from '../types/routine-job.types'
import type {RoutingTestHostState} from './test-host-state.service'
import type {MatchCondition} from '../types/test-request-match.types'
import {recorderWait, RECORDER_OBSERVATION_WAIT} from './routine-resource-wait'
import {resourceBlocker, resourceHostBlocker, resourceLaneBlocker, type ResourceReadinessBlocker} from './resource-readiness'

export type RoutineLaneEligibilityContext = {now: number; binding: FrameworkBinding; app?: {headSha: string; archiveSha256: string; receiptSha256: string}; backend?: BackendConnectivityContext}
export type RoutineLaneRequirementBlocker = {code: 'lane-shape-incompatible' | 'job-resource-incompatible' | 'job-glasses-incompatible'; resourceKind?: string}

// Older controllers still require per-request graph and preparing-phone targets.
// This is dispatch protocol compatibility, not a physical readiness condition.
export const CURRENT_READINESS_DISPATCH_API_VERSION = 111

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
        const deferred = !backendHealth && value.recipient === 'app'
        const matches = Boolean(context && permissionObservationMatches(observation, value.permission, {...context, recipient: value.recipient}))
        const current = Boolean(context && observation && permissionObservationMatches({...observation, status: 'granted'}, value.permission, {...context, recipient: value.recipient}))
        checks.push({id: `permission:${value.recipient}:${value.permission}`, label: `${value.recipient} ${value.permission}`, category: 'permission',
          status: deferred ? 'deferred' : matches ? 'match' : current && (observation?.status === 'denied' || observation?.status === 'blocked') ? 'blocked' : 'unknown',
          expected: deferred ? 'Setup checks this permission after the selected app is installed and owned' : 'Fresh granted observation for the exact recipient and selected source',
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

/** The ordinary dispatcher and its report evaluate this same current checklist.
 * Selected-app login/connectivity and app permissions belong to owned setup;
 * current physical baselines, worker permissions and custody are required now. */
export function evaluateRoutineLaneReadiness(requirements: PortableRequirements, host: RoutingTestHostState,
  lane: RoutingTestHostState['lanes'][number], context: RoutineLaneEligibilityContext | undefined, now: number,
  original?: {requestId: string; inputSha256: string; executionInputSha256?: string}, constraints: {
    minimumRoutineApiVersion?: number; minimumFrameworkVersion?: number; target?: {hostId?: string; laneId?: string};
    deadline?: Date; cancelled?: boolean
  } = {}) {
  const evaluatedLane = {...lane, resources: lane.resources.map(resource => resource.storage && original ? {...resource, storage: {...resource.storage,
      reservations: resource.storage.reservations.filter(reservation => reservation.requestId !== original.requestId ||
        reservation.inputSha256 !== (original.executionInputSha256 ?? original.inputSha256))}} : resource)},
    evaluation = evaluateRoutineLaneRequirements(requirements, evaluatedLane, context, now, false),
    authority = {hostId: host.hostId, receivedAt: host.receivedAt, snapshot: host,
      resourceControlRecords: host.resourceControlRecords, resourceLifecycleCursor: host.resourceLifecycleCursor,
      authorityReservations: host.authorityReservations},
    hostBlocker = resourceHostBlocker(authority, now), laneBlocker = resourceLaneBlocker(host, lane.id,
      original && {...original, hostId: host.hostId}), binding = host.frameworkBinding
  const check = (id: string, label: string, category: MatchCondition['category'], passed: boolean, expected: string, observed: string,
    unavailable = false, nextAction?: string): MatchCondition => ({id, label, category,
      status: passed ? 'match' : unavailable ? 'unknown' : 'blocked', expected, observed, ...(nextAction ? {nextAction} : {})})
  evaluation.conditions.push(
    {...check('fresh-report', 'Current accepted host report', 'lifecycle', !hostBlocker, 'Fresh authenticated current host report',
      hostBlocker?.code ?? 'Current accepted report', Boolean(hostBlocker), hostBlocker ? 'Restore the host reporter; read its named connection error.' : undefined), observedAt: host.receivedAt},
    check('automatic', 'Dispatch mode', 'placement', lane.dispatchMode === 'automatic', 'automatic', lane.dispatchMode),
    check('idle', 'Lane availability', 'ownership', !['offline', 'running', 'reserved'].includes(lane.state) && !('activity' in lane && lane.activity), 'Online lane with no active operation', lane.state),
    check('lane-authority', 'Current lane claims and controls', 'ownership', !laneBlocker,
      'No foreign retained claim or restrictive operator action', laneBlocker?.code ?? 'No blocking lane claim/control'),
    check('target', 'Frozen placement', 'placement', (!constraints.target?.hostId || constraints.target.hostId === host.hostId) &&
      (!constraints.target?.laneId || constraints.target.laneId === lane.id), constraints.target ?
      `${constraints.target.hostId ?? 'any host'}/${constraints.target.laneId ?? 'any lane'}` : 'Any enrolled compatible lane', `${host.hostId}/${lane.id}`),
    check('current-readiness-dispatch', 'Current-readiness dispatch support', 'source',
      Boolean(binding && binding.routineApiVersion >= CURRENT_READINESS_DISPATCH_API_VERSION),
      `Routine API >= ${CURRENT_READINESS_DISPATCH_API_VERSION}`,
      binding ? `Routine API ${binding.routineApiVersion}; source ${binding.revision}` : 'No accepted framework binding', !binding,
      `Adopt the normal framework publication supporting Routine API ${CURRENT_READINESS_DISPATCH_API_VERSION}, then accept its current report.`),
    ...(constraints.minimumRoutineApiVersion === undefined ? [] : [!binding && !host.resourceReservations?.resourceReadiness ?
      {id: 'routine-api', label: 'Frozen routine API requirement', category: 'source' as const, status: 'deferred' as const,
        expected: `Routine API >= ${constraints.minimumRoutineApiVersion}`, observed: 'Legacy host admission verifies the frozen API requirement before execution'} : check('routine-api', 'Frozen routine API requirement', 'source',
      Boolean(binding && binding.routineApiVersion >= constraints.minimumRoutineApiVersion), `Routine API >= ${constraints.minimumRoutineApiVersion}`,
      binding ? `Routine API ${binding.routineApiVersion}; source ${binding.revision}` : 'No accepted framework binding', !binding)]),
    ...(constraints.minimumFrameworkVersion === undefined ? [] : [check('framework-floor', 'Explicit framework requirement', 'source',
      Boolean(binding && binding.version >= constraints.minimumFrameworkVersion), `Framework >= ${constraints.minimumFrameworkVersion}`,
      binding ? `Framework ${binding.version}` : 'No accepted framework binding', !binding)]),
    ...(constraints.deadline === undefined ? [] : [check('deadline', 'Original deadline and cancellation', 'lifecycle',
      !constraints.cancelled && Number.isFinite(constraints.deadline.getTime()) && constraints.deadline.getTime() > now,
      'Original request is unexpired and not cancelled', constraints.cancelled ? 'Original request is cancelled' : constraints.deadline.toISOString())]))
  let physicalBlocker: ResourceReadinessBlocker | undefined
  for (const resource of evaluation.resources) {
    const blocker = resource.resourceId ? resourceBlocker(authority, resource.resourceId, now, false, original && {...original, laneId: lane.id}) : undefined,
      subject = host.resourceLifecycle?.subjects.find(value => value.subject.id === resource.resourceId),
      physicalFailure = subject?.idle.outcome === 'failed' || subject?.idle.report?.outcome === 'failed', unavailable = Boolean(blocker && !physicalFailure &&
        !['resource-owned', 'resource-operator-restriction', 'resource-restoration-required'].includes(blocker.code))
    if (blocker && !physicalBlocker) physicalBlocker = blocker
    resource.conditions.push(check('current-baseline', 'Current physical checklist and returned custody', 'physical', Boolean(resource.resourceId && !blocker),
      'Current installed contract passed, resource unowned and no unresolved effect', blocker?.code ?? (resource.resourceId ? 'Current baseline and custody pass' : 'No provider'),
      unavailable, blocker ? `Check ${resource.resourceId}: ${subject?.reason?.message ?? blocker.code}. Repair the named failed condition, then run its existing Check.` : undefined))
    // Current installed dependencies are part of the same checklist. A returned
    // old graph cannot exempt an actual secondary provider from current controls.
    const visited = new Set<string>(), offered = [...host.lanes.flatMap(value => value.resources), ...host.resources ?? []],
      pending = [...offered.find(value => value.id === resource.resourceId)?.idleContract?.dependencies ?? [], ...subject?.resource?.dependencies ?? []]
    while (pending.length) {
      const id = pending.shift()!
      if (visited.has(id)) continue
      visited.add(id)
      const ref = offered.find(value => value.id === id), current = host.resourceLifecycle?.subjects.find(value => value.subject.id === id),
        dependency = ref ? resourceBlocker(authority, id, now, false, original && {...original, laneId: lane.id}) : {code: 'resource-not-enrolled' as const, resourceId: id}
      if (dependency && !physicalBlocker) physicalBlocker = dependency
      resource.conditions.push(check(`dependency:${id}`, `Installed dependency ${id}`, 'physical', Boolean(ref && !dependency),
        'Current declared dependency passed and has no foreign custody/control', dependency?.code ?? 'Current dependency baseline and custody pass',
        Boolean(dependency && !['resource-owned', 'resource-operator-restriction', 'resource-restoration-required'].includes(dependency.code)),
        dependency ? `Check ${id}: ${current?.reason?.message ?? dependency.code}. Restore this declared dependency.` : undefined))
      pending.push(...ref?.idleContract?.dependencies ?? [], ...current?.resource?.dependencies ?? [])
    }
  }
  const all = [...evaluation.conditions, ...evaluation.resources.flatMap(resource => resource.conditions)],
    failed = all.find(condition => condition.status === 'blocked' || condition.status === 'unknown'),
    blocker = evaluation.blocker ?? hostBlocker ?? laneBlocker ?? physicalBlocker ?? (failed ? {code: 'job-resource-incompatible' as const} : undefined)
  return {...evaluation, blocker, ready: !failed}
}

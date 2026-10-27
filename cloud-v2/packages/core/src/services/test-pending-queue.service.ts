import {TestRequestModel} from '../models/test-request.model';
import {routineDispatchIntentSchema} from '../types/routine-dispatch.types';
import {recordedFrameworkRequestInputSchema, frameworkIdentitySchema} from '../types/framework-request.types';
import {portableRoutineSelectionSchema, routineJobPreparationSchema, type StoredRoutineJob} from '../types/routine-job.types';
import type {PendingQueueItem, PendingQueuePage} from '../types/test-pending-queue.types';
import type {StoredRequest} from './test-request.service';
import {requestInputDigest} from './test-request.service';
import {compatibleStructuralRoutineLane, routineJobInputDigest, routinePortableRequirements} from './routine-job.service';
import {TestHostStateService, type RoutingTestHostState} from './test-host-state.service';
import {TestRunError} from './test-result-error';
import {permissionContext} from '../types/resource-permissions.types';
import {pendingRequestFilter} from './test-request-activity';
import {sharedResourceWaitingReason} from './routine-resource-wait';
import {routineLaneRequirementBlocker} from './routine-lane-eligibility';
import {permissionObservationMatches} from '../types/resource-permissions.types';
import {isExclusiveHostReservation} from '../types/resource-reservations.types';

/** Read-only projection; compatible hardware is distinct from current acceptance. */
function projectPendingQueueItem(row: StoredRoutineJob, hosts: RoutingTestHostState[], now: number): PendingQueueItem {
  const base: PendingQueueItem = {requestId: row.requestId, state: row.state, createdAt: row.createdAt?.toISOString(),
    compatibilityKnown: false, compatibleLanes: [], platformCandidates: []};
  if (!row.fleetSelection) {
    const legacy = row as unknown as StoredRequest;
    const input = legacy.input ? recordedFrameworkRequestInputSchema.safeParse(legacy.input) : routineDispatchIntentSchema.safeParse(legacy.dispatchIntent);
    if (!input.success || requestInputDigest(input.data) !== (legacy.input ? legacy.inputSha256 : legacy.dispatchIntentSha256))
      return {...base, reason: 'Stored request identity is unavailable.'};
    return {...base, routineId: input.data.routineId, platform: input.data.platform, build: input.data.build,
      reason: 'Exact portable requirements are unavailable for this legacy request.',
      ...(legacy.hostId ? {assignment: {hostId: legacy.hostId, laneId: input.data.laneId}} : {})};
  }
  const selection = portableRoutineSelectionSchema.safeParse(row.fleetSelection);
  if (!selection.success || row.requestId !== selection.data.requestId || requestInputDigest(selection.data) !== row.fleetSelectionSha256)
    return {...base, reason: 'Stored request identity is unavailable.'};
  const selected = selection.data;
  const item: PendingQueueItem = {...base, routineId: selected.routineId, platform: selected.platform, build: selected.build,
    reason: row.fleetPreparationStatus?.reason ?? row.preparation?.reason ?? row.fleetDispatch?.error ?? sharedResourceWaitingReason(row, hosts),
    ...(row.fleetBinding ? {assignment: {hostId: row.fleetBinding.hostId, laneId: row.fleetBinding.laneId}} : {})};
  if (row.state === 'preparing' && selected.minimumFrameworkVersion !== undefined && row.fleetBinding) {
    const host = hosts.find(value => value.hostId === row.fleetBinding!.hostId), receivedAt = Date.parse(host?.receivedAt ?? '');
    const current = Number.isFinite(receivedAt) && receivedAt <= now && now - receivedAt <= 120_000 ? host?.frameworkBinding : undefined;
    if (!current || current.version < selected.minimumFrameworkVersion)
      item.reason = `Waiting for framework ${selected.minimumFrameworkVersion}; assigned host ${row.fleetBinding.hostId} ${current ? `reports framework ${current.version}` : 'has no fresh accepted framework observation'}.`;
  }
  let requirements;
  if (row.fleetPreparation) {
    const prepared = routineJobPreparationSchema.safeParse(row.fleetPreparation);
    if (!prepared.success || row.fleetInputSha256 !== routineJobInputDigest(row) ||
      requestInputDigest(prepared.data.definition) !== prepared.data.definitionSha256)
      return {...item, reason: 'Stored routine requirements are unavailable.'};
    try {
      requirements = routinePortableRequirements({routineId: selected.routineId, platform: selected.platform,
        definition: prepared.data.definition} as Parameters<typeof routinePortableRequirements>[0]);
      if (requestInputDigest(requirements) !== requestInputDigest(prepared.data.requirements))
        return {...item, reason: 'Stored routine requirements differ from the exact definition.'};
    } catch {return {...item, reason: 'Exact routine resource requirements are unavailable.'};}
  }
  const lanes = hosts.filter(host => !row.fleetTarget?.hostId || row.fleetTarget.hostId === host.hostId).flatMap(host =>
    host.lanes.filter(lane => (!row.fleetTarget?.laneId || row.fleetTarget.laneId === lane.id) && lane.platform === selected.platform)
      .map(lane => ({host, lane, label: {hostId: host.hostId, laneId: lane.id, platform: lane.platform,
        glassesModels: (lane.glasses ?? []).map(value => value.model), state: lane.state, dispatchMode: lane.dispatchMode,
        fresh: Number.isFinite(Date.parse(host.receivedAt)) && now - Date.parse(host.receivedAt) <= 120_000}})));
  return {...item, compatibilityKnown: !!requirements,
    compatibleLanes: requirements ? lanes.filter(({host, lane}) => compatibleStructuralRoutineLane(requirements, lane, permissionContext(host.frameworkBinding, selected.build, now))).map(value => value.label) : [],
    platformCandidates: requirements ? [] : lanes.map(value => value.label)};
}
/** Bad persisted rows cannot hide valid neighbors, including malformed timestamps. */
export function pendingQueueItem(row: StoredRoutineJob, hosts: RoutingTestHostState[], now: number): PendingQueueItem {
  try {return diagnosePendingQueueItem(projectPendingQueueItem(row, hosts, now), row, hosts, now);}
  catch {return {requestId: row.requestId, state: row.state, compatibilityKnown: false,
    compatibleLanes: [], platformCandidates: [], reason: 'Stored request metadata is unavailable.',
    diagnosis: {stage: 'Unknown metadata', nextAction: 'Inspect this original request’s stored metadata and source validation result.',
      conditions: [{label: 'Stored original identity', status: 'unknown', expected: 'Valid original request and requirements', observed: 'Stored request metadata could not be projected'}]}};}
}
/** Current display facts only. This never calls matching, admission, or return authorities. */
function diagnosePendingQueueItem(item: PendingQueueItem, row: StoredRoutineJob, hosts: RoutingTestHostState[], now: number): PendingQueueItem {
  type Condition = NonNullable<PendingQueueItem['diagnosis']>['conditions'][number];
  const currentResourceWait = sharedResourceWaitingReason(row, hosts);
  const finish = (stage: string, reason: string, nextAction: string, conditions: Condition[]) => {
    const currentReason = stage === 'Source preparation' ? item.reason ?? reason : currentResourceWait ??
      (stage === 'Bound execution' && item.reason?.startsWith('Waiting for framework ') ? item.reason : reason);
    return {...item, reason: currentReason, diagnosis: {stage, nextAction, conditions: [...conditions,
      ...(item.reason && item.reason !== currentReason ? [{label: 'Last recorded diagnostic', status: 'unknown' as const,
        expected: 'Current refusal evidence for this stage', observed: item.reason.slice(0, 2000)}] : [])]}};
  };
  const pending = row.fleetCandidatePreparation, admission = row.fleetResourceAdmission;
  const selected = row.fleetBinding ?? pending ?? admission?.intent ?? row.fleetResourceReservation ?? row.fleetCandidateSelection ?? item.assignment;
  const host = selected && hosts.find(value => value.hostId === selected.hostId);
  const lane = host?.lanes.find(value => value.id === selected?.laneId);
  const location = selected ? {hostId: selected.hostId, laneId: selected.laneId} : {};
  const current: Condition[] = selected ? [{label: 'Selected lane observation', status: lane ? 'passed' : 'unknown', ...location,
    expected: 'Latest recorded report for the selected original lane', observed: lane ? `${lane.state}; ${lane.dispatchMode}; report ${host!.receivedAt}` : 'Selected host or lane is absent from the current report'}] : [];
  const claims = selected ? hosts.flatMap(authority => (authority.authorityReservations ?? []).filter(claim =>
    isExclusiveHostReservation(claim) ? claim.borrowerHostId === selected.hostId && claim.laneId === selected.laneId ||
      Boolean(currentResourceWait && admission?.dependencies.some(dependency =>
        dependency.resourceId === claim.resourceId && dependency.authorityHostId === claim.authorityHostId && authority.hostId === claim.authorityHostId)) :
      claim.hostId === selected.hostId && claim.laneId === selected.laneId).map(claim => ({authority, claim}))) : [];
  for (const {authority, claim} of claims) current.push({label: 'Current authority claim', status: 'waiting',
    ...(isExclusiveHostReservation(claim) ? {hostId: claim.borrowerHostId, laneId: claim.laneId} : {hostId: claim.hostId, laneId: claim.laneId}),
    resourceId: isExclusiveHostReservation(claim) ? claim.resourceId : claim.poolId,
    owner: isExclusiveHostReservation(claim) ? `${claim.owner.kind}:${claim.owner.id}` : `run:${claim.requestId}`,
    expected: 'Existing original claim must be respected until authenticated completion or return',
    observed: `${claim.id}; authority ${authority.hostId}`});
  if (row.state === 'terminal') return finish('Terminal original result', `This original is terminal (${row.terminalStatus ?? 'outcome unavailable'}); it is not pending delivery.`,
    'Inspect the preserved original result and any outstanding authenticated returns; do not dispatch it again.', [...current,
      {label: 'Original result', status: 'passed', expected: 'A terminal result preserved independently of outstanding custody', observed: row.terminalStatus ?? 'Terminal state recorded; detailed outcome unavailable'}]);
  if (row.fleetCancellation) return finish('Cancellation and return', 'Cancellation is recorded; original completion and custody return still need settlement.',
    'Inspect the original cancellation and authenticated return reports; preserve outstanding claims.', [...current,
      {label: 'Original cancellation', status: 'waiting', expected: 'Acknowledged cancellation and complete original return', observed: row.fleetCancellation.reason}]);
  if (row.fleetDeadline && row.fleetDeadline.getTime() <= now) return finish('Original deadline reached', 'The original deadline has passed; this pending record still needs its supported terminal settlement.',
    'Inspect the original completion/cancellation and return authorities; do not extend the deadline or dispatch duplicate work.', [...current,
      {label: 'Original deadline', status: 'failed', expected: 'Run within the unchanged original deadline', observed: row.fleetDeadline.toISOString()}]);
  if (!row.fleetSelection && item.assignment && item.routineId) return finish(row.state === 'preparing' ? 'Worker setup' : 'Worker delivery',
    row.preparation?.reason ?? 'The selected original worker is waiting for setup or its delivery acknowledgement.',
    'Inspect this original worker’s preparation and delivery reports; preserve its assignment and custody.', [...current,
      {label: 'Selected worker preparation', status: 'waiting', expected: 'The exact assigned worker prepares and acknowledges the original input',
        observed: row.preparation?.reason ?? `${row.state}; no specific preparation refusal is recorded`}]);
  if (!item.compatibilityKnown) return finish('Source preparation', 'Waiting for verified exact routine requirements.',
    'Inspect this original preparation workflow and its source validation result.', [{label: 'Exact routine requirements', status: 'unknown',
      expected: 'Verified immutable definition and resource requirements', observed: item.reason ?? 'No verified prepared requirements are recorded'}]);
  if (row.fleetBinding) return finish(row.state === 'preparing' && row.preparation ? 'Bound worker setup' : 'Bound execution',
    'This original is bound; waiting for its worker preparation, execution or final completion report.',
    'Inspect the original device workflow and its completion/publication result; do not dispatch a duplicate.', [...current,
      ...(row.preparation ? [{label: 'Last worker preparation report', status: 'waiting' as const, ...location,
        expected: 'The exact bound worker completes its setup', observed: `${row.preparation.reason}; reported ${row.preparation.observedAt}`}]: []),
      {label: 'Original execution completion', status: row.dispatchCompletion ? 'passed' : 'waiting', ...location,
        expected: 'Completion from the exact bound original worker', observed: row.dispatchCompletion ? `Completion recorded at ${row.dispatchCompletion.completedAt}` :
          `Bound Actions run ${row.fleetBinding.actionsRunId}, job ${row.fleetBinding.actionsJobId}; no completion recorded`}]);
  if (pending) return finish('Candidate check and return', 'The selected original candidate check has not finished its complete return.',
    'Inspect the selected lane’s original check and return report; repair that machine if the report names a failed condition.', [...current,
      {label: 'Original candidate settlement', status: 'waiting', ...location,
        expected: 'Check result and authenticated complete return for this exact original attempt',
        observed: `${pending.candidate.attemptId}; requested ${pending.candidate.requestedAt}; ${pending.resourceReturns?.length ?? 0} graph returns recorded${pending.returnReceipt ? '; return receipt recorded' : ''}`}]);
  if (admission || row.fleetResourceReservation) return finish('Resource admission', 'The original resource admission has not reached a bound worker.',
    'Inspect this original admission and its current authority claims; complete the existing reservation or authenticated return.', [...current,
      {label: 'Atomic reservation and binding', status: 'waiting', ...location,
        expected: 'Exact original admission and reservation accepted by the existing bind authority',
        observed: `${admission?.intent.operationId ?? 'No admission intent'}; ${admission?.dependencies.length ?? 0} exclusive dependencies; ${row.fleetResourceReservation ? `byte reservation ${row.fleetResourceReservation.id}` : 'no byte reservation recorded'}`}]);
  if (row.fleetCandidateSelection) return finish('Selected candidate', 'An original candidate is recorded, but no reservation or bound worker is recorded; the exact blocking condition is not recorded.',
    'Inspect the selected original candidate and existing admission stage logs; preserve its identity and any outstanding claims.', [...current,
      {label: 'Selected candidate admission', status: 'unknown', ...location,
        expected: 'The existing authority records a reservation or an explicit refusal for this original selection',
        observed: `Selected target ${row.fleetCandidateSelection.targetInputSha256}; no reservation or specific refusal is recorded`}]);
  if (!item.compatibleLanes.length && row.fleetPreparation) {
    const conditions: Condition[] = [];
    for (const candidate of hosts) for (const offered of candidate.lanes) {
      if (offered.platform !== item.platform || row.fleetTarget?.hostId && row.fleetTarget.hostId !== candidate.hostId || row.fleetTarget?.laneId && row.fleetTarget.laneId !== offered.id) continue;
      const context = permissionContext(candidate.frameworkBinding, row.fleetSelection.build, now);
      const blocker = routineLaneRequirementBlocker(row.fleetPreparation.requirements, offered, context, now, false);
      if (!blocker) continue;
      const required = row.fleetPreparation.requirements.resources.find(value => value.kind === blocker.resourceKind);
      const resource = offered.resources.find(value => value.kind === blocker.resourceKind);
      const fields = {hostId: candidate.hostId, laneId: offered.id, ...(resource ? {resourceId: resource.id} : {})};
      let explained = false;
      for (const permission of resource && required?.capabilities.every(value => resource.capabilities?.includes(value)) ? required.permissions ?? [] : []) {
        if (offered.platform === 'ios-on-mac' && permission.recipient === 'app') continue;
        const observation = resource?.permissionObservations?.find(value => value.permission === permission.permission);
        if (context && permissionObservationMatches(observation, permission.permission, {...context, recipient: permission.recipient})) continue;
        explained = true;
        const currentObservation = Boolean(context && observation && permissionObservationMatches({...observation, status: 'granted'},
          permission.permission, {...context, recipient: permission.recipient}));
        conditions.push({label: `${permission.recipient} permission: ${permission.permission}`, status: observation?.status === 'denied' && currentObservation ? 'failed' : observation ? 'waiting' : 'unknown',
          ...fields, expected: 'Fresh granted observation for the exact selected recipient and source',
          observed: observation ? `${observation.status}; recipient ${observation.recipient.kind}; observed ${observation.observedAt}; grant does not match the current selection` : 'No observation reported; this is not a denied permission'});
      }
      if (!explained) conditions.push({label: 'Exact routine compatibility', status: 'waiting', ...fields,
        expected: required ? `${required.kind}: ${required.capabilities.join(', ') || 'required provider'}${required.storage ? '; required recorder capacity' : ''}` : 'Matching lane and glasses inventory',
        observed: `${blocker.code}${blocker.resourceKind ? ` (${blocker.resourceKind})` : ''}; ${resource ? `offered capabilities: ${resource.capabilities?.join(', ') || 'none'}` : 'required provider not reported'}`});
    }
    const reason = conditions.some(value => value.observed.startsWith('No observation')) ? 'No compatible lane: required observations are missing, not reported as denied.' :
      'No lane currently matches the exact routine requirements.';
    return finish('Lane compatibility', reason, 'Inspect the listed requirement and the owning lane’s current resource checklist; provide the missing observation or repair the reported condition.', conditions.length ? conditions :
      [{label: 'Platform inventory', status: 'unknown', expected: `A reported ${item.platform} lane matching this original target`, observed: 'No matching platform/target lane is reported'}]);
  }
  return finish('Awaiting matching decision', 'Compatible lanes are reported, but this original has no selected candidate or bound reservation; the exact blocking condition is not recorded.',
    'Inspect existing preparation stage logs for this original request and the compatible lanes’ resource checklists.',
    [{label: 'Current matching decision', status: 'unknown', expected: 'A recorded candidate, reservation, or explicit refusal from the existing matcher',
      observed: `${item.compatibleLanes.length} structurally compatible lanes; no selected candidate or reservation recorded`}]);
}
export class TestPendingQueueService {
  constructor(private readonly hosts = new TestHostStateService(), private readonly now = Date.now) {}
  async list(cursor?: string): Promise<PendingQueuePage> {
    if (cursor && !frameworkIdentitySchema.safeParse(cursor).success) throw new TestRunError(400, 'Invalid pending queue cursor');
    const filter = pendingRequestFilter;
    const [rows, total, hosts] = await Promise.all([
      TestRequestModel.find({...filter, ...(cursor ? {requestId: {$gt: cursor}} : {})}).sort({requestId: 1}).limit(51)
        .read('primary').readConcern('majority').lean(),
      TestRequestModel.countDocuments(filter).read('primary').readConcern('majority'), this.hosts.list(),
    ]);
    const now = this.now(), page = rows.slice(0, 50);
    return {items: page.map(row => pendingQueueItem(row as unknown as StoredRoutineJob, hosts, now)), total,
      ...(rows.length > 50 ? {nextCursor: page.at(-1)!.requestId} : {}), observedAt: new Date(now).toISOString()};
  }
}

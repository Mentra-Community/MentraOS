import {TestRequestModel} from '../models/test-request.model';
import {routineDispatchIntentSchema} from '../types/routine-dispatch.types';
import {recordedFrameworkRequestInputSchema, frameworkIdentitySchema} from '../types/framework-request.types';
import {portableRoutineSelectionSchema, routineJobPreparationSchema, type StoredRoutineJob} from '../types/routine-job.types';
import type {PendingQueueItem, PendingQueuePage} from '../types/test-pending-queue.types';
import type {StoredRequest} from './test-request.service';
import {requestInputDigest} from './test-request.service';
import {compatibleRoutineLane, routineJobInputDigest, routinePortableRequirements} from './routine-job.service';
import {TestHostStateService, type ReceivedTestHostState} from './test-host-state.service';
import {TestRunError} from './test-result-error';
import {pendingRequestFilter, cancelledRequestFilter, hostCancellationDeliveryFilter, requestActivity} from './test-request-activity';

const freshHost = (host: ReceivedTestHostState, now: number) => Number.isFinite(Date.parse(host.receivedAt)) &&
  now >= Date.parse(host.receivedAt) && now - Date.parse(host.receivedAt) <= 120_000;
/** Only the reporting controller can associate current custody with a request. */
export function currentRequestCustody(requestId: string, hosts: ReceivedTestHostState[], now: number) {
  return hosts.filter(host => freshHost(host, now)).flatMap(host => host.lanes.flatMap(lane => {
    const owner = lane.activity?.owner;
    if (!owner || ['idle', 'offline'].includes(lane.state)) return [];
    const matches = owner.kind === 'run' && owner.id === requestId && owner.requestId === requestId ||
      owner.kind === 'fixer' && host.restoration?.attempts.some(attempt => attempt.current && attempt.requestId === requestId &&
        attempt.laneId === lane.id && attempt.executionId === owner.id);
    return matches ? [{hostId: host.hostId, laneId: lane.id, ownerId: owner.id, ownerKind: owner.kind}] : [];
  }));
}

/** Read-only projection; compatible hardware is distinct from current acceptance. */
function projectPendingQueueItem(row: StoredRoutineJob, hosts: ReceivedTestHostState[], now: number): PendingQueueItem {
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
    reason: row.fleetCancellation?.reason ?? row.preparation?.reason ?? row.fleetDispatch?.error,
    ...(row.fleetBinding ? {assignment: {hostId: row.fleetBinding.hostId, laneId: row.fleetBinding.laneId}} : {})};
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
    compatibleLanes: requirements ? lanes.filter(({lane}) => compatibleRoutineLane(requirements, lane)).map(value => value.label) : [],
    platformCandidates: requirements ? [] : lanes.map(value => value.label)};
}
/** Bad persisted rows cannot hide valid neighbors, including malformed timestamps. */
export function pendingQueueItem(row: StoredRoutineJob, hosts: ReceivedTestHostState[], now: number): PendingQueueItem {
  try {return projectPendingQueueItem(row, hosts, now);}
  catch {return {requestId: row.requestId, state: row.state, compatibilityKnown: false,
    compatibleLanes: [], platformCandidates: [], reason: 'Stored request metadata is unavailable.'};}
}
export function cancellationQueueItem(row: StoredRoutineJob & {cancellationAcknowledged?: boolean}, hosts: ReceivedTestHostState[], now: number) {
  const item = pendingQueueItem(row, hosts, now), custody = currentRequestCustody(row.requestId, hosts, now);
  return {...item, reason: row.fleetCancellation?.reason ?? row.hostCancellation?.reason ?? row.preparationCancellation?.reason ?? item.reason,
    cancellation: {acknowledged: row.cancellationAcknowledged === true,
    cleanupPending: !!row.fleetBinding && !row.dispatchCompletion || custody.length > 0, custody}};
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
    const currentIds = [...new Set(hosts.filter(host => freshHost(host, now)).flatMap(host => [
      ...host.lanes.flatMap(lane => lane.activity?.owner.kind === 'run' ? [lane.activity.owner.requestId!] : []),
      ...(host.restoration?.attempts.filter(attempt => attempt.current && attempt.requestId).map(attempt => attempt.requestId!) ?? []),
    ]))].filter(requestId => currentRequestCustody(requestId, hosts, now).length > 0);
    // Acknowledged historical rows stay in history. Keep outstanding delivery, missing
    // fleet cleanup receipts and exact current controller custody visible separately.
    const [owned, outstanding] = await Promise.all([
      currentIds.length ? TestRequestModel.find({state: {$ne: 'terminal'}, ...cancelledRequestFilter, requestId: {$in: currentIds}})
        .sort({requestId: 1}).limit(51).read('primary').readConcern('majority').lean() : [],
      TestRequestModel.find({state: {$ne: 'terminal'}, ...(currentIds.length ? {requestId: {$nin: currentIds}} : {}),
        $or: [hostCancellationDeliveryFilter(),
          {fleetCancellation: {$exists: true}, fleetBinding: {$exists: true}, dispatchCompletion: {$exists: false}}]})
        .sort({requestId: 1}).limit(51).read('primary').readConcern('majority').lean(),
    ]);
    // Prioritize current custody before delivery-only cancellations. A concurrent
    // acknowledgement cannot bury the currently held request behind old receipts.
    const cancellationRows = [...owned, ...outstanding];
    return {items: page.map(row => pendingQueueItem(row as unknown as StoredRoutineJob, hosts, now)), total,
      cancellations: cancellationRows.slice(0, 50).filter(row => requestActivity(row) === 'cancellation')
        .map(row => cancellationQueueItem(row as unknown as StoredRoutineJob, hosts, now)), cancellationsTruncated: cancellationRows.length > 50,
      ...(rows.length > 50 ? {nextCursor: page.at(-1)!.requestId} : {}), observedAt: new Date(now).toISOString()};
  }
}

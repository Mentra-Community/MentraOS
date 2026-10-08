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
export class TestPendingQueueService {
  constructor(private readonly hosts = new TestHostStateService()) {}
  async list(cursor?: string): Promise<PendingQueuePage> {
    if (cursor && !frameworkIdentitySchema.safeParse(cursor).success) throw new TestRunError(400, 'Invalid pending queue cursor');
    const filter = {state: {$ne: 'terminal'}};
    const [rows, total, hosts] = await Promise.all([
      TestRequestModel.find({...filter, ...(cursor ? {requestId: {$gt: cursor}} : {})}).sort({requestId: 1}).limit(51)
        .read('primary').readConcern('majority').lean(),
      TestRequestModel.countDocuments(filter).read('primary').readConcern('majority'), this.hosts.list(),
    ]);
    const now = Date.now(), page = rows.slice(0, 50);
    return {items: page.map(row => pendingQueueItem(row as unknown as StoredRoutineJob, hosts, now)), total,
      ...(rows.length > 50 ? {nextCursor: page.at(-1)!.requestId} : {}), observedAt: new Date(now).toISOString()};
  }
}

import {z} from 'zod';
import {TestRequestModel} from '../models/test-request.model';
import {testWriteConcern} from '../models/test-write-concern';
import {frameworkIdentitySchema} from '../types/framework-request.types';
import {routineEnrollmentSchema, routineGlassesCapabilities, type RoutineEnrollment} from '../types/routine-definition.types';
import {routineDispatchIntentSchema} from '../types/routine-dispatch.types';
import {completeRoutineJobPreparationSchema, portableRequirementsSchema, portableRoutineSelectionSchema, routineJobBindInputSchema,
  routineJobPreparationSchema, routineJobSubmissionSchema, routineJobCompletionSchema, routineJobActionsSchema, routineJobTargetSchema, type RoutineJobCompletion, type PortableRequirements, type PortableRoutineSelection,
  type RoutineJobBinding, type RoutineJobPreparation, type StoredRoutineJob} from '../types/routine-job.types';
import {requestInputDigest, TestRequestConflict, TestRequestService} from './test-request.service';
import {GithubTestBuildGateway, type TestBuildGateway} from './test-builds.service';
import {selectedBuildInput} from '../types/test-build.types';
import {GithubRoutineSourceGateway} from './routine-source-selection.service';
import {RoutineDefinitionService} from './routine-definition.service';
import {TestHostStateService, type ReceivedTestHostState} from './test-host-state.service';
import {FrameworkResultService} from './framework-result.service';
import {GithubRoutineJobActions, routineActionsRetry, cancelRoutineActions, type RoutineActionsCancellation, type RoutineJobActions} from './routine-job-actions.service';
import {TestRunError} from './test-result-error';

/** These are fields on the existing test_requests record, never a separate scheduling queue. */
export interface RoutineJobRepository {
  get(jobId: string): Promise<StoredRoutineJob | null>;
  insert(row: StoredRoutineJob): Promise<void>;
  prepare(jobId: string, selectionSha256: string, prepared: RoutineJobPreparation, inputSha256: string, now: Date): Promise<StoredRoutineJob | null>;
  bind(jobId: string, inputSha256: string, binding: RoutineJobBinding, intent: unknown, now: Date): Promise<StoredRoutineJob | null>;
  pending?(limit: number, now: Date): Promise<StoredRoutineJob[]>;
  dispatch?(jobId: string, previous: StoredRoutineJob['fleetDispatch'], value: NonNullable<StoredRoutineJob['fleetDispatch']>): Promise<StoredRoutineJob | null>;
  actions?(jobId: string, inputSha256: string, value: {actionsRunId: string; recordedAt: string}): Promise<StoredRoutineJob | null>;
  complete?(jobId: string, hostId: string, inputSha256: string, value: RoutineJobCompletion): Promise<StoredRoutineJob | null>;
  cancellationProgress?(jobId:string,value:RoutineActionsCancellation,completedRunIds?:string[]):Promise<void>;
  cancel(jobId: string, inputSha256: string, value: NonNullable<StoredRoutineJob['fleetCancellation']>): Promise<StoredRoutineJob | null>;
}
export const routineJobRepository: RoutineJobRepository = {
  async get(requestId) {return await TestRequestModel.findOne({requestId, fleetSelection: {$exists: true}})
    .read('primary').readConcern('majority').lean() as unknown as StoredRoutineJob | null;},
  async insert(row) {await TestRequestModel.create([row], {writeConcern: testWriteConcern});},
  async prepare(requestId, fleetSelectionSha256, fleetPreparation, fleetInputSha256, now) {
    return await TestRequestModel.collection.findOneAndUpdate({requestId, fleetSelectionSha256, state: 'awaiting-source',
      fleetPreparation: {$exists: false}, fleetCancellation: {$exists: false}, fleetDeadline: {$gt: now}},
      {$set: {fleetPreparation, fleetInputSha256, state: 'awaiting-runner', updatedAt: now}},
      {returnDocument: 'after', writeConcern: testWriteConcern}) as unknown as StoredRoutineJob | null;
  },
  async bind(requestId, fleetInputSha256, fleetBinding, dispatchIntent, now) {
    return await TestRequestModel.collection.findOneAndUpdate({requestId, fleetInputSha256, state: 'awaiting-runner',
      fleetBinding: {$exists: false}, hostId: {$exists: false}, fleetCancellation: {$exists: false}, fleetDeadline: {$gt: now}},
      {$set: {hostId: fleetBinding.hostId, fleetBinding, dispatchIntent, dispatchIntentSha256: requestInputDigest(dispatchIntent),
        state: 'preparing', updatedAt: now}}, {returnDocument: 'after', writeConcern: testWriteConcern}) as unknown as StoredRoutineJob | null;
  },
  async pending(limit, now) {
    return await TestRequestModel.find({fleetSelection: {$exists: true},
      $or:[{fleetCancellation:{$exists:true},'fleetActionsCancellation.settled':{$ne:true},$or:[{'fleetActionsCancellation.checkedAt':{$exists:false}},{'fleetActionsCancellation.checkedAt':{$lte:new Date(now.getTime()-30_000).toISOString()}}]},
        {fleetCancellation:{$exists:false},$or: [{fleetDeadline: {$lte: now}, $or: [{state: {$ne: 'terminal'}}, {fleetBinding: {$exists: true}, dispatchCompletion: {$exists: false}, hostRejection: {$exists: false},
          preparationCancellation: {$exists: false}, preparationRejection: {$exists: false}}]},
        {state: {$ne: 'terminal'}, fleetBinding: {$exists: false},
          $or: [{fleetDispatch: {$exists: false}}, {'fleetDispatch.attempts': {$lt: 20}, 'fleetDispatch.lastAttemptAt': {$lte: new Date(now.getTime() - 30_000).toISOString()},
            $or:[{'fleetDispatch.checkedAt':{$exists:false}},{'fleetDispatch.checkedAt':{$lte:new Date(now.getTime()-30_000).toISOString()}}]}]}]}]})
      .sort({createdAt: 1, requestId: 1}).limit(limit).read('primary').readConcern('majority').lean() as unknown as StoredRoutineJob[];
  },
  async dispatch(requestId, previous, fleetDispatch) {
    return await TestRequestModel.findOneAndUpdate({requestId, fleetDispatch: previous ?? {$exists: false},
      fleetCancellation: {$exists: false}, fleetBinding: {$exists: false}, fleetDeadline: {$gt: new Date()}}, {$set: {fleetDispatch}},
      {new: true, writeConcern: testWriteConcern}).lean() as unknown as StoredRoutineJob | null;
  },
  async actions(requestId, inputSha256, value) {
    return await TestRequestModel.findOneAndUpdate({requestId, $or:[{fleetInputSha256:inputSha256},{fleetSelectionSha256:inputSha256}], 'fleetActions.actionsRunId': {$ne: value.actionsRunId},
      $expr: {$lt: [{$size: {$ifNull: ['$fleetActions', []]}}, 20]}}, {$push: {fleetActions: value}},
      {new: true, writeConcern: testWriteConcern}).lean() as unknown as StoredRoutineJob | null;
  },
  async complete(requestId, hostId, inputSha256, dispatchCompletion) {
    return await TestRequestModel.collection.findOneAndUpdate({requestId, hostId, inputSha256, fleetBinding: {$exists: true},
      dispatchCompletion: {$exists: false}}, [{$set: {dispatchCompletion: {$literal: dispatchCompletion}, updatedAt: new Date(),
        state: {$cond: [{$and: [{$ne: [{$type: '$fleetCancellation'}, 'missing']}, {$ne: ['$state', 'terminal']}]}, 'terminal', '$state']},
        terminalStatus: {$cond: [{$and: [{$ne: [{$type: '$fleetCancellation'}, 'missing']}, {$ne: ['$state', 'terminal']}]}, 'cancelled', '$terminalStatus']}}}],
      {returnDocument: 'after', writeConcern: testWriteConcern}) as unknown as StoredRoutineJob | null;
  },
  async cancellationProgress(requestId,fleetActionsCancellation,completedRunIds=[]) {
    await TestRequestModel.updateOne({requestId,fleetCancellation:{$exists:true},...(fleetActionsCancellation.settled ? {
      $expr:{$setIsSubset:[{$ifNull:['$fleetActions.actionsRunId',[]]},{$literal:completedRunIds}]}} : {})},
      {$set:{fleetActionsCancellation}},{writeConcern:testWriteConcern});
  },
  async cancel(requestId, fleetSelectionSha256, fleetCancellation) {
    const identity = {requestId, fleetSelectionSha256, fleetCancellation: {$exists: false}};
    const unbound = await TestRequestModel.collection.findOneAndUpdate({...identity, fleetBinding: {$exists: false}},
      {$set: {fleetCancellation, state: 'terminal', terminalStatus: 'not-run', updatedAt: new Date()}},
      {returnDocument: 'after', writeConcern: testWriteConcern});
    if (unbound) return unbound as unknown as StoredRoutineJob;
    return await TestRequestModel.collection.findOneAndUpdate(identity, [{$set: {fleetCancellation: {$literal: fleetCancellation}, updatedAt: new Date(),
      state: {$cond: [{$and: [{$ne: [{$type: '$dispatchCompletion'}, 'missing']}, {$ne: ['$state', 'terminal']}]}, 'terminal', '$state']},
      terminalStatus: {$cond: [{$and: [{$ne: [{$type: '$dispatchCompletion'}, 'missing']}, {$ne: ['$state', 'terminal']}]}, 'cancelled', '$terminalStatus']}}}],
      {returnDocument: 'after', writeConcern: testWriteConcern}) as unknown as StoredRoutineJob | null;
  },
};

/** Derive routing only from the exact serialized definition. */
export function routinePortableRequirements(definition: RoutineEnrollment): PortableRequirements {
  const body = definition.definition, execution = body.execution;
  if (!execution) throw new TestRequestConflict('The routine has no execution resource metadata');
  return portableRequirementsSchema.parse({platform: definition.platform,
    ...(body.glasses ? {glasses: {models: body.glasses.models, capabilities: routineGlassesCapabilities(body.requires)}} : {}),
    resources: execution.resourceKinds.map(kind => ({kind,
      capabilities: body.resourceRequirements?.find(requirement => requirement.kind === kind)?.capabilities ?? []}))});
}
export function routineLaneDescriptorRevision(lane: ReceivedTestHostState['lanes'][number]): string {
  return requestInputDigest({id: lane.id, platform: lane.platform,
    resources: lane.resources.map(resource => ({...resource, capabilities: [...resource.capabilities ?? []].sort()})).sort((a, b) => a.id.localeCompare(b.id)),
    glasses: (lane.glasses ?? []).map(glasses => ({...glasses, capabilities: [...glasses.capabilities].sort()})).sort((a, b) => a.resourceId.localeCompare(b.resourceId))});
}
export function compatibleRoutineLane(requirements: PortableRequirements, lane: ReceivedTestHostState['lanes'][number]) {
  if (lane.platform !== requirements.platform || (lane.glasses?.length ?? 0) > 1 ||
    new Set(lane.resources.map(resource=>resource.kind)).size!==lane.resources.length) return false;
  if (!requirements.resources.every(required => lane.resources.some(offered => offered.kind === required.kind &&
    required.capabilities.every(capability => offered.capabilities?.includes(capability))))) return false;
  if (requirements.glasses && !lane.glasses?.some(offered => requirements.glasses!.models.includes(offered.model) &&
    requirements.glasses!.capabilities.every(capability => offered.capabilities.includes(capability)))) return false;
  return true;
}
/** Kept identical to Harness contracts/dispatch.ts: opaque identities use canonical JSON hashes. */
export function routineRequirementLabels(requirements: PortableRequirements, model?: string, target?: StoredRoutineJob['fleetTarget']): string[] {
  const token = (value: string) => requestInputDigest(value).slice(0, 24);
  if (requirements.glasses && (!model || !requirements.glasses.models.includes(model)))
    throw new TestRequestConflict('Queue labels require one acceptable glasses model');
  return [...new Set([`mentra-platform-${requirements.platform}`,
    ...requirements.resources.flatMap(resource => [`mentra-resource-${resource.kind}`,
      ...resource.capabilities.map(capability => `mentra-cap-${token(`${resource.kind}:${capability}`)}`)]),
    ...(model ? [`mentra-glasses-${token(model)}`, ...requirements.glasses!.capabilities.map(capability => `mentra-glasses-cap-${token(`${model}:${capability}`)}`)] : []),
    ...(target?.hostId ? [`mentra-host-${token(target.hostId)}`] : []),
    ...(target?.laneId ? [`mentra-lane-${token(`${target.hostId}:${target.laneId}`)}`] : [])])].sort();
}
export const routineJobInputDigest = (row: Pick<StoredRoutineJob, 'fleetSelection' | 'fleetPreparation' | 'fleetDeadline' | 'fleetTarget'>) =>
  requestInputDigest({selection: row.fleetSelection, prepared: row.fleetPreparation, deadline: row.fleetDeadline.toISOString(), target: row.fleetTarget ?? null});

export class RoutineJobService {
  constructor(private readonly rows: RoutineJobRepository = routineJobRepository,
    private readonly builds: Pick<TestBuildGateway, 'resolve'> = new GithubTestBuildGateway(),
    private readonly sources: Pick<GithubRoutineSourceGateway, 'resolve' | 'inventory' | 'blob'> = new GithubRoutineSourceGateway(),
    private readonly definitions: Pick<RoutineDefinitionService, 'getExact'> = new RoutineDefinitionService(),
    private readonly hosts: Pick<TestHostStateService, 'get'> & Partial<Pick<TestHostStateService, 'list'>> = new TestHostStateService(),
    private readonly requests: Pick<TestRequestService, 'cancel'> = new TestRequestService(),
    private readonly results: Pick<FrameworkResultService, 'detail'> = new FrameworkResultService(),
    private readonly now: () => number = Date.now,
    private readonly actionsTransport: RoutineJobActions | null = rows === routineJobRepository ? new GithubRoutineJobActions() : null) {}
  private async job(jobId: string) {
    if (!frameworkIdentitySchema.safeParse(jobId).success) throw new TestRunError(400, 'Invalid job identity');
    const row = await this.rows.get(jobId);
    if (!row) throw new TestRunError(404, 'Routine job was not found');
    if (requestInputDigest(row.fleetSelection) !== row.fleetSelectionSha256 || row.fleetPreparation &&
      (row.fleetInputSha256 !== routineJobInputDigest(row) || requestInputDigest(row.fleetPreparation.definition) !== row.fleetPreparation.definitionSha256))
      throw new TestRunError(503, 'Stored routine job exact inputs are unavailable');
    return row;
  }
  private retry(row: StoredRoutineJob, selected: z.infer<typeof routineJobSubmissionSchema>) {
    const original = row.fleetSelection;
    if (selected.routineId !== original.routineId || selected.platform !== original.platform ||
      selected.minimumFrameworkVersion !== original.minimumFrameworkVersion || requestInputDigest(selected.source) !== requestInputDigest(original.source) ||
      selected.routineRevision && selected.routineRevision !== original.routineRevision ||
      selected.routineSource && requestInputDigest(selected.routineSource) !== requestInputDigest(original.routineSource ?? row.fleetPreparation?.routineSource ?? null) ||
      requestInputDigest(selected.target ?? null) !== requestInputDigest(row.fleetTarget ?? null) ||
      selected.deadline && Date.parse(selected.deadline) !== row.fleetDeadline.getTime())
      throw new TestRequestConflict('Routine job retry changed its frozen source, requirements, target or deadline');
    return row;
  }
  async submit(value: unknown) {
    const selected = routineJobSubmissionSchema.parse(value), existing = await this.rows.get(selected.requestId);
    if (existing) return this.deliver(this.retry(await this.job(selected.requestId), selected));
    const deadline = new Date(selected.deadline ?? this.now() + 3 * 3600_000);
    if (deadline.getTime() <= this.now() || deadline.getTime() > this.now() + 3 * 3600_000)
      throw new TestRunError(400, 'Routine job deadline must be within three hours');
    const frozen = await this.freezeSelection(selected);
    const {target} = selected;
    const candidate = await this.definitions.getExact(frozen.routineId, frozen.platform, frozen.routineRevision, true);
    if (!candidate && await this.definitions.getExact(frozen.routineId, frozen.platform, frozen.routineRevision, false))
      throw new TestRunError(422, 'Candidate-only source requires its accepted authoring job and review authorization');
    const row: StoredRoutineJob = {requestId: selected.requestId, state: 'awaiting-source', fleetSelection: frozen,
      fleetSelectionSha256: requestInputDigest(frozen), fleetDeadline: deadline, ...(target ? {fleetTarget: target} : {})};
    try {await this.rows.insert(row);}
    catch (error) {if ((error as {code?: number}).code !== 11000) throw error;
      return this.deliver(this.retry(await this.job(row.requestId), selected));}
    if (candidate) await this.prepared(row.requestId, {inputSha256: row.fleetSelectionSha256,
      routineSource: candidate.routineSource, definitionSha256: candidate.definitionSha256, definition: candidate.definition});
    return this.deliver(await this.job(row.requestId));
  }
  async freezeSelection(value: unknown, inheritedBuild?: PortableRoutineSelection['build']): Promise<PortableRoutineSelection> {
    const selected = routineJobSubmissionSchema.parse(value);
    const routineRevision = selected.routineRevision ?? selected.routineSource?.commit ?? await this.sources.resolve();
    const build = inheritedBuild ? null : await this.builds.resolve(selected.source, selected.platform);
    if (build && (build.availability !== 'available' || !build.archive || !build.receipt))
      throw new TestRunError(409, build.reason ?? 'Exact app publication is unavailable');
    const {target: _, deadline: __, ...selection} = selected;
    return portableRoutineSelectionSchema.parse(JSON.parse(JSON.stringify({...selection, routineRevision,
      build: inheritedBuild ?? {...selectedBuildInput(build!, selected.platform),
        ...(build!.manifest ? {manifest: build!.manifest, manifestSha256: build!.manifestSha256} : {})}})));
  }
  async submitFrozen(selection: PortableRoutineSelection, deadline: string, target?: StoredRoutineJob['fleetTarget']) {
    const frozen = portableRoutineSelectionSchema.parse(selection), date = z.string().datetime({offset: true}).parse(deadline);
    if (Date.parse(date) > this.now() + 3 * 3600_000) throw new TestRunError(400, 'Routine job deadline must be within three hours');
    const validatedTarget = target ? routineJobTargetSchema.parse(target) : undefined;
    const row: StoredRoutineJob = {requestId: frozen.requestId, state: 'awaiting-source', fleetSelection: frozen,
      fleetSelectionSha256: requestInputDigest(frozen), fleetDeadline: new Date(date), ...(validatedTarget ? {fleetTarget: validatedTarget} : {})};
    try {await this.rows.insert(row);}
    catch (error) {if ((error as {code?: number}).code !== 11000) throw error;}
    const retained = await this.job(row.requestId);
    if (retained.fleetSelectionSha256 !== row.fleetSelectionSha256 || retained.fleetDeadline.getTime() !== row.fleetDeadline.getTime() ||
      requestInputDigest(retained.fleetTarget ?? null) !== requestInputDigest(row.fleetTarget ?? null))
      throw new TestRequestConflict('Routine job identity already has different exact inputs');
    if (retained.fleetDeadline.getTime() <= this.now() && !retained.fleetCancellation)
      await this.cancel(retained.requestId, {reason: 'Routine job reached its three-hour deadline'});
    return this.deliver(await this.job(row.requestId));
  }
  /** A cancelled absent member first becomes visible with its fence; it is never admitted for cancellation. */
  async cancelFrozen(selection: PortableRoutineSelection, deadline: string, value: {reason: string}, target?: StoredRoutineJob['fleetTarget']) {
    const frozen = portableRoutineSelectionSchema.parse(selection), date = z.string().datetime({offset: true}).parse(deadline);
    if (Date.parse(date) > this.now() + 3 * 3600_000) throw new TestRunError(400, 'Routine job deadline must be within three hours');
    const cancellation = z.object({reason: z.string().min(1).max(2000)}).strict().parse(value);
    const validatedTarget = target ? routineJobTargetSchema.parse(target) : undefined;
    const row: StoredRoutineJob = {requestId: frozen.requestId, state: 'terminal', terminalStatus: 'not-run', fleetSelection: frozen,
      fleetSelectionSha256: requestInputDigest(frozen), fleetDeadline: new Date(date),
      fleetCancellation: {requestedAt: new Date(this.now()).toISOString(), reason: cancellation.reason},
      ...(validatedTarget ? {fleetTarget: validatedTarget} : {})};
    try {await this.rows.insert(row);}
    catch (error) {if ((error as {code?: number}).code !== 11000) throw error;}
    const retained = await this.job(row.requestId);
    if (retained.fleetSelectionSha256 !== row.fleetSelectionSha256 || retained.fleetDeadline.getTime() !== row.fleetDeadline.getTime() ||
      requestInputDigest(retained.fleetTarget ?? null) !== requestInputDigest(row.fleetTarget ?? null))
      throw new TestRequestConflict('Routine job identity already has different exact inputs');
    return this.cancel(row.requestId, cancellation);
  }
  private async discover(row: StoredRoutineJob) {
    if (!this.actionsTransport?.runs || !row.fleetDispatch) return [];
    const runs = await this.actionsTransport.runs(row.requestId, row.fleetDispatch.firstAttemptAt ?? row.createdAt?.toISOString() ?? row.fleetDispatch.lastAttemptAt);
    for (const run of runs) if (!row.fleetActions?.some(value => value.actionsRunId === run.actionsRunId)) {
      const saved = await this.rows.actions?.(row.requestId, row.fleetInputSha256 ?? row.fleetSelectionSha256,
        {actionsRunId:run.actionsRunId,recordedAt:new Date(this.now()).toISOString()});
      row = saved ?? await this.job(row.requestId);
      if(!row.fleetActions?.some(value=>value.actionsRunId===run.actionsRunId))throw new TestRunError(503,'Actions delivery history exceeds its bound');
    }
    return runs;
  }
  private async deliver(row: StoredRoutineJob): Promise<StoredRoutineJob> {
    if (!this.actionsTransport || row.fleetBinding || row.fleetCancellation || row.state === 'terminal' || this.now() >= row.fleetDeadline.getTime()) return row;
    const previous = row.fleetDispatch;
    if(previous && this.now()-Date.parse(previous.checkedAt ?? previous.lastAttemptAt)<30_000)return row;
    let runs;
    try {runs=await this.discover(row);} catch(error) {
      if(previous)await this.rows.dispatch?.(row.requestId,previous,{...previous,checkedAt:new Date(this.now()).toISOString(),error:error instanceof TestRunError?error.message:'Actions run discovery is unavailable'});
      return this.job(row.requestId);
    }
    if (!routineActionsRetry(previous,runs,this.now())) {
      if(previous)await this.rows.dispatch?.(row.requestId,previous,{...previous,checkedAt:new Date(this.now()).toISOString()});
      return this.job(row.requestId);
    }
    if (!this.rows.dispatch) throw new TestRunError(503, 'Actions dispatch receipt storage is unavailable');
    const value = {attempts:(previous?.attempts??0)+1,firstAttemptAt:previous?.firstAttemptAt??new Date(this.now()).toISOString(),lastAttemptAt:new Date(this.now()).toISOString(),checkedAt:new Date(this.now()).toISOString()};
    const retained=await this.rows.dispatch(row.requestId,previous,value);
    if(!retained)return this.job(row.requestId);
    try {
      await this.actionsTransport.dispatch(row.requestId);
      return await this.rows.dispatch(row.requestId,value,{...value,acknowledgedAt:new Date(this.now()).toISOString()})??await this.job(row.requestId);
    } catch(error) {
      await this.rows.dispatch(row.requestId,value,{...value,error:error instanceof TestRunError?error.message:'GitHub routine delivery is unavailable; retry the retained job'});
      return this.job(row.requestId);
    }
  }
  async reconcilePending() {
    const pending = await this.rows.pending?.(20, new Date(this.now())) ?? [];
    await Promise.allSettled(pending.map(row => row.fleetCancellation ? this.cancel(row.requestId,{reason:row.fleetCancellation.reason}) : this.observation(row.requestId)));
  }
  async preparation(jobId: string) {
    const row = await this.job(jobId);
    const routing = row.fleetPreparation ? await this.routing(row) : {};
    return {jobId, kind: 'run' as const, inputSha256: row.fleetInputSha256 ?? row.fleetSelectionSha256, deadline: row.fleetDeadline.toISOString(),
      state: row.state, ...routing, selection: row.fleetSelection, ...(row.fleetTarget ? {target: row.fleetTarget} : {}), ...(row.fleetPreparation ? {prepared: row.fleetPreparation} : {})};
  }
  private async routing(row: StoredRoutineJob) {
    const requirements = row.fleetPreparation!.requirements;
    const hosts = await this.hosts.list?.() ?? [];
    const compatible = hosts.filter(host => Number.isFinite(Date.parse(host.receivedAt)) && this.now() - Date.parse(host.receivedAt) <= 120_000 &&
      (!row.fleetTarget?.hostId || row.fleetTarget.hostId === host.hostId)).flatMap(host => host.lanes.filter(lane =>
        (!row.fleetTarget?.laneId || row.fleetTarget.laneId === lane.id) && compatibleRoutineLane(requirements, lane)));
    const model = requirements.glasses ? [...new Set(compatible.flatMap(lane => (lane.glasses ?? []).filter(glasses =>
      requirements.glasses!.models.includes(glasses.model) && requirements.glasses!.capabilities.every(value => glasses.capabilities.includes(value))).map(glasses => glasses.model)))].sort()[0]
      ?? [...requirements.glasses.models].sort()[0] : undefined;
    return {routingLabels: routineRequirementLabels(requirements, model, row.fleetTarget), ...(model ? {chosenModel: model} : {}),
      ...(!compatible.length ? {waitingReason: 'Awaiting a compatible enrolled runner'} : {})};
  }
  async inventory(jobId: string) {const row = await this.job(jobId); return this.sources.inventory(row.fleetSelection.routineRevision);}
  async blob(jobId: string, sha: string) {
    const file = (await this.inventory(jobId)).files.find(file => file.gitBlobSha1 === sha);
    if (!file) throw new TestRequestConflict('Requested blob is not part of the exact job source');
    return this.sources.blob(file);
  }
  async prepared(jobId: string, value: unknown) {
    const input = completeRoutineJobPreparationSchema.parse(value), row = await this.job(jobId), selected = row.fleetSelection;
    if (input.inputSha256 !== row.fleetSelectionSha256) throw new TestRequestConflict('Preparation changed the exact source selection');
    const ordinary = await this.definitions.getExact(selected.routineId, selected.platform, selected.routineRevision, true);
    if (!ordinary && await this.definitions.getExact(selected.routineId, selected.platform, selected.routineRevision, false))
      throw new TestRunError(422, 'Candidate-only source requires its accepted authoring job and review authorization');
    const definition = routineEnrollmentSchema.parse({routineId: selected.routineId, platform: selected.platform, definitionRevision: selected.routineRevision,
      routineSource: input.routineSource, definitionSha256: input.definitionSha256, definition: input.definition});
    if (requestInputDigest(input.definition) !== input.definitionSha256 || selected.routineSource &&
      requestInputDigest(selected.routineSource) !== requestInputDigest(input.routineSource))
      throw new TestRequestConflict('Offline preparation differs from the selected exact source');
    const {inputSha256: _, ...preparedInput} = input;
    const prepared = routineJobPreparationSchema.parse({...preparedInput, requirements: routinePortableRequirements(definition)});
    const digest = routineJobInputDigest({...row, fleetPreparation: prepared});
    if (row.fleetPreparation) {
      if (digest !== row.fleetInputSha256) throw new TestRequestConflict('Prepared routine requirements changed after their first commit');
      return row;
    }
    if (row.fleetCancellation || this.now() >= row.fleetDeadline.getTime()) return row;
    const saved = await this.rows.prepare(jobId, row.fleetSelectionSha256, prepared, digest, new Date(this.now()));
    const winner = saved ?? await this.job(jobId);
    if (winner.fleetPreparation && winner.fleetInputSha256 !== digest) throw new TestRequestConflict('Prepared routine requirements changed after their first commit');
    return winner;
  }
  async bind(jobId: string, hostId: string, value: unknown) {
    const input = routineJobBindInputSchema.parse(value), row = await this.job(jobId);
    if (row.fleetInputSha256 !== input.inputSha256 || !row.fleetPreparation)
      throw new TestRequestConflict('Binding changed its prepared exact inputs');
    if (row.fleetBinding) return this.bindingProjection(row, hostId, input);
    if (row.fleetCancellation || this.now() >= row.fleetDeadline.getTime())
      throw new TestRequestConflict('Cancelled or expired routine job cannot bind');
    const host = await this.hosts.get(hostId), lane = host?.lanes.find(lane => lane.id === input.laneId);
    if (!host || host.hostId !== hostId || !Number.isFinite(Date.parse(host.receivedAt)) || this.now() - Date.parse(host.receivedAt) > 120_000 ||
      !lane || lane.dispatchMode !== 'automatic' || lane.state !== 'idle' ||
      row.fleetTarget?.hostId && row.fleetTarget.hostId !== hostId || row.fleetTarget?.laneId && row.fleetTarget.laneId !== input.laneId ||
      lane.descriptorRevision !== input.descriptorRevision || routineLaneDescriptorRevision(lane) !== input.descriptorRevision ||
      !compatibleRoutineLane(row.fleetPreparation.requirements, lane))
      throw new TestRequestConflict('Selected host has no current accepting compatible lane descriptor');
    const binding: RoutineJobBinding = {jobId, requestId: jobId, hostId, laneId: input.laneId,
      descriptorRevision: input.descriptorRevision, actionsJobId: input.actionsJobId, actionsRunId: input.actionsRunId, boundAt: new Date(this.now()).toISOString()};
    const intent = routineDispatchIntentSchema.parse({...row.fleetSelection, routineSource: row.fleetPreparation.routineSource, laneId: input.laneId});
    const saved = await this.rows.bind(jobId, input.inputSha256, binding, intent, new Date(this.now()));
    const winner = saved ?? await this.job(jobId);
    if (!winner.fleetBinding) throw new TestRequestConflict('Routine job was cancelled or expired before binding');
    return this.bindingProjection(winner, hostId, input);
  }
  private async bindingProjection(row: StoredRoutineJob, hostId: string, input: z.infer<typeof routineJobBindInputSchema>) {
    const binding = row.fleetBinding!;
    return {binding, execute: !row.fleetCancellation && !row.dispatchCompletion && this.now() < row.fleetDeadline.getTime() && row.state !== 'terminal' &&
      binding.hostId === hostId && binding.laneId === input.laneId && binding.actionsJobId === input.actionsJobId && binding.actionsRunId === input.actionsRunId,
      observation: await this.observation(row.requestId)};
  }
  async cancel(jobId: string, value: unknown) {
    const input = z.object({reason: z.string().min(1).max(2000)}).strict().parse(value), row = await this.job(jobId);
    const cancellation = row.fleetCancellation ?? {requestedAt: new Date(this.now()).toISOString(), reason: input.reason};
    const saved = row.fleetCancellation ? row : await this.rows.cancel(jobId, row.fleetSelectionSha256, cancellation) ?? await this.job(jobId);
    if (saved.fleetBinding) await this.requests.cancel(jobId, cancellation.requestedAt, cancellation.reason);
    const {completedRunIds,...progress}=await cancelRoutineActions({transport:this.actionsTransport,jobId,dispatch:saved.fleetDispatch,now:this.now(),
      known:[...(saved.fleetActions?.map(value=>value.actionsRunId)??[]),...(saved.fleetBinding?[saved.fleetBinding.actionsRunId]:[])],
      retain:async run=>{if(!saved.fleetActions?.some(value=>value.actionsRunId===run.actionsRunId)) {
        const retained=await this.rows.actions?.(jobId,saved.fleetInputSha256??saved.fleetSelectionSha256,{actionsRunId:run.actionsRunId,recordedAt:new Date(this.now()).toISOString()})??await this.job(jobId);
        if(!retained.fleetActions?.some(value=>value.actionsRunId===run.actionsRunId))throw new TestRunError(503,'Actions delivery history exceeds its bound');
      }}});
    await this.rows.cancellationProgress?.(jobId,progress,completedRunIds);
    return this.observation(jobId);
  }
  async actions(jobId: string, value: unknown) {
    const input = routineJobActionsSchema.parse(value); let row = await this.job(jobId);
    if (input.inputSha256 !== row.fleetInputSha256) throw new TestRequestConflict('Actions delivery changed its exact prepared input');
    if (!row.fleetActions?.some(value => value.actionsRunId === input.actionsRunId)) {
      if (!this.rows.actions) throw new TestRunError(503, 'Actions delivery storage is unavailable');
      const saved = await this.rows.actions(jobId, input.inputSha256, {actionsRunId: input.actionsRunId, recordedAt: new Date(this.now()).toISOString()}) ?? await this.job(jobId);
      row = saved;
      if (!saved.fleetActions?.some(value => value.actionsRunId === input.actionsRunId))
        throw new TestRequestConflict('Actions delivery history exceeds its retry bound');
    }
    if (row.fleetCancellation || (await this.job(jobId)).fleetCancellation) {
      await this.rows.cancellationProgress?.(jobId,{checkedAt:new Date(this.now()-30_001).toISOString(),settled:false});
      await Promise.allSettled([this.actionsTransport?.cancel(input.actionsRunId)]);
    }
    return this.observation(jobId);
  }
  async complete(jobId: string, hostId: string, value: unknown) {
    const input = routineJobCompletionSchema.parse(value), row = await this.job(jobId);
    const executable = row as StoredRoutineJob & {inputSha256?: string};
    if (!row.fleetBinding || row.hostId !== hostId || executable.inputSha256 !== input.inputSha256)
      throw new TestRequestConflict('Dispatch completion differs from its accepted host and exact executable input');
    if (row.dispatchCompletion) {
      if (requestInputDigest(row.dispatchCompletion) !== requestInputDigest(input))
        throw new TestRequestConflict('Dispatch completion changed its original custody disposition');
      return row.dispatchCompletion;
    }
    if (!this.rows.complete) throw new TestRunError(503, 'Dispatch completion storage is unavailable');
    const saved = await this.rows.complete(jobId, hostId, input.inputSha256, input) ?? await this.job(jobId);
    if (requestInputDigest(saved.dispatchCompletion) !== requestInputDigest(input))
      throw new TestRequestConflict('Dispatch completion changed its original custody disposition');
    return saved.dispatchCompletion;
  }
  async observation(jobId: string) {
    let row = await this.deliver(await this.job(jobId));
    if (!row.fleetCancellation && this.now() >= row.fleetDeadline.getTime() && (row.state !== 'terminal' ||
      !!row.fleetBinding && !row.dispatchCompletion && !row.hostRejection && !row.preparationCancellation && !row.preparationRejection)) {
      await this.cancel(jobId, {reason: 'Routine job reached its three-hour deadline'});
      row = await this.job(jobId);
    }
    let result: unknown;
    if (row.fleetBinding) try {result = await this.results.detail(jobId);}
    catch (error) {if (!(error instanceof TestRunError) || error.status !== 404) throw error;}
    const reason = row.fleetCancellation?.reason ?? row.fleetDispatch?.error ?? row.hostCancellation?.reason ?? row.preparationCancellation?.reason ??
      row.hostRejection?.reason ?? row.preparationRejection?.reason ?? row.preparation?.reason;
    return {jobId, kind: 'run' as const, inputSha256: row.fleetInputSha256 ?? row.fleetSelectionSha256,
      deadline: row.fleetDeadline.toISOString(), state: row.fleetCancellation && !row.fleetBinding ? 'terminal' : row.state,
      ...(row.fleetBinding ? {binding: row.fleetBinding} : {}), actionsRuns: row.fleetActions ?? [], ...(row.fleetActionsCancellation ? {actionsCancellation:row.fleetActionsCancellation} : {}), ...(reason ? {waitingReason: reason} : {}),
      terminal: !row.fleetBinding ? row.state === 'terminal' || !!row.fleetCancellation
        : !!row.hostRejection || !!row.preparationCancellation || !!row.preparationRejection || !!row.dispatchCompletion && row.state === 'terminal',
      ...(row.dispatchCompletion ? {cleanupDisposition: row.dispatchCompletion.disposition, dispatchCompletion: row.dispatchCompletion} : {}),
      ...(row.terminalStatus ? {terminalStatus: row.terminalStatus} : row.fleetCancellation && !row.fleetBinding ? {terminalStatus: 'not-run'} : {}),
      ...(result ? {result} : {})};
  }
}

import {TestHostStateModel} from '../models/test-host-state.model';
import {recorderCapacityRequirement, recorderStorageAvailable, recorderHostReservationSchema, recorderHostReservationsSchema, STORAGE_MARGIN_BYTES, type RecorderHostReservation, type RecorderStorageObservation} from '../types/recorder-storage.types';
import {createHash, randomUUID} from 'node:crypto';
import {z} from 'zod';
import {TestRequestModel} from '../models/test-request.model';
import {TestRunModel} from '../models/test-run.model';
import {testWriteConcern} from '../models/test-write-concern';
import {frameworkIdentitySchema, frameworkRequestInputSchema} from '../types/framework-request.types';
import {routineEnrollmentSchema, type RoutineEnrollment} from '../types/routine-definition.types';
import {preparationRejectionSchema, routineDispatchIntentSchema} from '../types/routine-dispatch.types';
import {routinePreparationStatusSchema, type RoutinePreparationStatus, completeRoutineJobPreparationSchema, portableRequirementsSchema, portableRoutineSelectionSchema, routineJobBindInputSchema,
  routineJobPreparationSchema, routineJobSubmissionSchema, routineJobCompletionReportSchema, routineJobActionsSchema, routineJobTargetSchema, type RoutineJobCompletion, type PortableRequirements, type PortableRoutineSelection,
  routineQualificationTargetSchema, routineJobBindingSchema, type RoutineQualificationTarget, type RoutineJobBinding, type RoutineJobPreparation, type RoutinePublicationFailure, type StoredRoutineJob} from '../types/routine-job.types';
import {requestInputDigest, TestRequestConflict, TestRequestService} from './test-request.service';
import {GithubTestBuildGateway, type TestBuildGateway} from './test-builds.service';
import {selectedBuildInput} from '../types/test-build.types';
import {permissionObservationMatches, permissionContext} from '../types/resource-permissions.types';
import type {FrameworkBinding} from '../types/framework-version.types';
import {GithubRoutineSourceGateway} from './routine-source-selection.service';
import {RoutineDefinitionService} from './routine-definition.service';
import {hostStateSchema, TestHostStateService, type RoutingTestHostState} from './test-host-state.service';
import {FrameworkResultService} from './framework-result.service';
import {GithubRoutineJobActions, routineActionsRetry, cancelRoutineActions, type RoutineActionsCancellation, type RoutineJobActions} from './routine-job-actions.service';
import {TestRunError} from './test-result-error';
type ObservationPhase = (value: 'request' | 'delivery' | 'cancellation' | 'result' | 'projection') => void;

/** These are fields on the existing test_requests record, never a separate scheduling queue. */
export interface RoutineJobRepository {
  get(jobId: string): Promise<StoredRoutineJob | null>;
  completionRequest?(jobId: string): Promise<StoredRoutineJob | null>;
  insert(row: StoredRoutineJob): Promise<void>;
  prepare(jobId: string, selectionSha256: string, prepared: RoutineJobPreparation, inputSha256: string, now: Date): Promise<StoredRoutineJob | null>;
  exhaustPreparation?(jobId: string, completedRunIds: string[], now: Date): Promise<StoredRoutineJob | null>;
  preparationStatus?(jobId: string, value: RoutinePreparationStatus, now: Date): Promise<StoredRoutineJob | null>;
  reserveResources?(jobId: string, inputSha256: string, hostId: string, laneId: string, now: Date): Promise<StoredRoutineJob | null>;
  bind(jobId: string, inputSha256: string, binding: RoutineJobBinding, intent: unknown, now: Date): Promise<StoredRoutineJob | null>;
  pending?(limit: number, now: Date): Promise<StoredRoutineJob[]>;
  qualificationCandidates?(hostId: string, laneId: string, limit: number, now: Date, timeoutMS: number, includeQueued: boolean): AsyncIterable<StoredRoutineJob>;
  supersessionCandidates?(limit: number, now: Date): Promise<StoredRoutineJob[]>;
  supersessionChecked?(jobId: string, now: Date): Promise<void>;
  dispatch?(jobId: string, previous: StoredRoutineJob['fleetDispatch'], value: NonNullable<StoredRoutineJob['fleetDispatch']>): Promise<StoredRoutineJob | null>;
  actions?(jobId: string, inputSha256: string, value: {actionsRunId: string; recordedAt: string}): Promise<StoredRoutineJob | null>;
  complete?(jobId: string, hostId: string, inputSha256: string, value: RoutineJobCompletion): Promise<StoredRoutineJob | null>;
  publicationFailed?(jobId: string, hostId: string, completion: RoutineJobCompletion, failure: RoutinePublicationFailure): Promise<StoredRoutineJob | null>;
  hasResult?(jobId: string): Promise<boolean>;
  cancellationProgress?(jobId:string,value:RoutineActionsCancellation,completedRunIds?:string[]):Promise<void>;
  cancel(jobId: string, inputSha256: string, value: NonNullable<StoredRoutineJob['fleetCancellation']>): Promise<StoredRoutineJob | null>;
}
export const routineJobRepository: RoutineJobRepository = {
  async get(requestId) {return await TestRequestModel.findOne({requestId, fleetSelection: {$exists: true}})
    .read('primary').readConcern('majority').lean() as unknown as StoredRoutineJob | null;},
  async completionRequest(requestId) {return await TestRequestModel.findOne({requestId})
    .read('primary').readConcern('majority').lean() as unknown as StoredRoutineJob | null;},
  async insert(row) {await TestRequestModel.create([row], {writeConcern: testWriteConcern});},
  async prepare(requestId, fleetSelectionSha256, fleetPreparation, fleetInputSha256, now) {
    return await TestRequestModel.collection.findOneAndUpdate({requestId, fleetSelectionSha256, state: 'awaiting-source',
      fleetPreparation: {$exists: false}, fleetCancellation: {$exists: false}, fleetDeadline: {$gt: now}},
      {$set: {fleetPreparation, fleetInputSha256, state: 'awaiting-runner', updatedAt: now}, $unset: {fleetPreparationStatus: ''}},
      {returnDocument: 'after', writeConcern: testWriteConcern}) as unknown as StoredRoutineJob | null;
  },
  async preparationStatus(requestId, value, now) {
    return await TestRequestModel.collection.findOneAndUpdate({requestId, fleetSelectionSha256: value.inputSha256,
      state: 'awaiting-source', fleetPreparation: {$exists: false}, fleetBinding: {$exists: false},
      fleetCancellation: {$exists: false}, fleetDeadline: {$gt: now},
      'fleetActions.actionsRunId': value.actionsRunId,
      $expr: {$eq: [{$max: {$map: {input: '$fleetActions', as: 'action', in: {$toDecimal: '$$action.actionsRunId'}}}}, {$toDecimal: {$literal: value.actionsRunId}}]}},
      {$set: {fleetPreparationStatus: value, updatedAt: now,
        ...(!value.retryable ? {state: 'terminal', terminalStatus: value.code === 'not-applicable' ? 'not-applicable' : 'not-run',
          fleetCancellation:{requestedAt:now.toISOString(),reason:value.reason}} : {})}},
      {returnDocument: 'after', writeConcern: testWriteConcern}) as unknown as StoredRoutineJob | null;
  },
  async exhaustPreparation(requestId, completedRunIds, now) {
    return await TestRequestModel.collection.findOneAndUpdate({requestId, state:'awaiting-source',
      fleetPreparation:{$exists:false}, fleetBinding:{$exists:false}, fleetCancellation:{$exists:false},
      fleetDeadline:{$gt:now}, 'fleetDispatch.attempts':20,
      $expr:{$setIsSubset:[{$ifNull:['$fleetActions.actionsRunId',[]]},{$literal:completedRunIds}]}},
      {$set:{state:'terminal',terminalStatus:'not-run',updatedAt:now,fleetCancellation:{requestedAt:now.toISOString(),
        reason:'Routine preparation exhausted 20 delivery attempts; inspect preparation diagnostics and submit corrected work.'}}},
      {returnDocument:'after',writeConcern:testWriteConcern}) as unknown as StoredRoutineJob | null;
  },
  async reserveResources(requestId, fleetInputSha256, hostId, laneId, now) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const row = await TestRequestModel.collection.findOne({requestId, fleetInputSha256, state: 'awaiting-runner',
        fleetBinding: {$exists: false}, fleetCancellation: {$exists: false}, fleetDeadline: {$gt: now}},
        {readPreference: 'primary', readConcern: {level: 'majority'}, timeoutMS: 10_000}) as unknown as StoredRoutineJob | null;
      if (!row?.fleetPreparation) return null;
      const selected = row.fleetResourceReservation;
      if (selected && (selected.hostId !== hostId || selected.laneId !== laneId)) return null;
      const hostRow = await TestHostStateModel.collection.findOne({hostId},
        {readPreference: 'primary', readConcern: {level: 'majority'}, timeoutMS: 10_000});
      if (!hostRow) return null;
      const host = {...hostStateSchema.parse(hostRow.snapshot), receivedAt: hostRow.receivedAt.toISOString()};
      const requirements = recorderCapacityRequirements(row.fleetPreparation), lane = host.lanes.find(value => value.id === laneId),
        required = requirements.resources.find(value => value.kind === 'recorder')?.storage;
      const sourceOffer = lane?.resources.find(value => value.kind === 'recorder')?.storage;
      const offered = sourceOffer && {...sourceOffer, reservations: sourceOffer.reservations.filter(value =>
        value.requestId !== requestId || value.inputSha256 !== row.inputSha256)};
      if (host.hostId !== hostId || !lane || !required || !offered || lane.state !== 'idle' || lane.dispatchMode !== 'automatic' ||
        now.getTime() - hostRow.receivedAt.getTime() > 120_000 || hostRow.receivedAt > now ||
        !compatibleRoutineLane(requirements, {...lane, resources: lane.resources.map(value => value.kind === 'recorder' ? {...value, storage: offered} : value)}, permissionContext(host.frameworkBinding, row.fleetSelection.build, now.getTime()), now.getTime())) return null;
      const claims = recorderHostReservationsSchema.parse(hostRow.resourceReservations ?? []);
      const requests = claims.length ? await TestRequestModel.collection.find({requestId: {$in: claims.map(value => value.requestId)}},
        {projection: {requestId: 1, inputSha256: 1, fleetInputSha256: 1, fleetResourceReservation: 1, fleetBinding: 1, fleetCancellation: 1,
          dispatchCompletion: 1, input: 1, hostId: 1, state: 1, dispatchIntent: 1, dispatchIntentSha256: 1,
          preparationCancellation: 1, preparationRejection: 1}, readPreference: 'primary', readConcern: {level: 'majority'}, timeoutMS: 10_000}).limit(1001).toArray() as unknown as StoredRoutineJob[] : [];
      const retained = reconcileRecorderHostReservations(claims, requests, offered);
      const own = retained.find(value => value.requestId === requestId && value.fleetInputSha256 === fleetInputSha256);
      if (retained.some(value => value.requestId === requestId && value.fleetInputSha256 !== fleetInputSha256) ||
        selected && own?.id !== selected.id || own && own.poolId !== offered.poolId || !own && retained.length >= 1000) return null;
      const unobserved = unobservedRecorderHostReservations(retained.filter(value => value !== own), requests, offered);
      if (!recorderStorageAvailable(offered, required, now.getTime(), unobserved)) return null;
      const chosenModel = row.fleetPreparation.requirements.glasses ? lane.glasses!.find(value =>
        row.fleetPreparation!.requirements.glasses!.models.includes(value.model))!.model : undefined;
      const claim = own ?? {id: randomUUID(), requestId, fleetInputSha256, hostId, laneId, poolId: offered.poolId,
        minimumAvailableBytes: required.minimumAvailableBytes, reservedAt: now.toISOString(), ...(chosenModel ? {chosenModel} : {})};
      // This existing host resource record is the sole byte-claim authority. Snapshot and claim CAS fences race both reports and other lanes.
      const savedHost = await TestHostStateModel.collection.findOneAndUpdate({hostId, incarnation: hostRow.incarnation,
        incarnationGeneration: hostRow.incarnationGeneration, sequence: hostRow.sequence,
        resourceReservationVersion: hostRow.resourceReservationVersion ?? {$exists: false}},
        {$set: {resourceReservations: own ? retained : [...retained, claim]}, $inc: {resourceReservationVersion: 1}},
        {returnDocument: 'after', writeConcern: testWriteConcern, timeoutMS: 10_000});
      if (!savedHost) continue;
      if (selected) return row;
      // The request retains only the winning target/receipt. A lost race leaves a conservative host claim for normal reconciliation.
      const selectedRow = await TestRequestModel.collection.findOneAndUpdate({requestId, fleetInputSha256, state: 'awaiting-runner',
        fleetResourceReservation: {$exists: false}, fleetBinding: {$exists: false}, fleetCancellation: {$exists: false}, fleetDeadline: {$gt: now}},
        {$set: {fleetResourceReservation: claim}}, {returnDocument: 'after', writeConcern: testWriteConcern, timeoutMS: 10_000}) as unknown as StoredRoutineJob | null;
      if (selectedRow) return selectedRow;
      const winner = await this.get(requestId);
      return winner?.fleetResourceReservation?.id === claim.id ? winner : null;
    }
    return null;
  },
  async bind(requestId, fleetInputSha256, fleetBinding, dispatchIntent, now) {
    return await TestRequestModel.collection.findOneAndUpdate({requestId, fleetInputSha256, state: 'awaiting-runner',
      fleetBinding: {$exists: false}, hostId: {$exists: false}, 'fleetResourceReservation.hostId': fleetBinding.hostId, 'fleetResourceReservation.laneId': fleetBinding.laneId, fleetCancellation: {$exists: false}, fleetDeadline: {$gt: now}},
      {$set: {hostId: fleetBinding.hostId, fleetBinding, dispatchIntent, dispatchIntentSha256: requestInputDigest(dispatchIntent),
        state: 'preparing', updatedAt: now}}, {returnDocument: 'after', writeConcern: testWriteConcern}) as unknown as StoredRoutineJob | null;
  },
  async pending(limit, now) {
    return await TestRequestModel.find({fleetSelection: {$exists: true},
      $or:[{fleetCancellation:{$exists:true},'fleetActionsCancellation.settled':{$ne:true},$or:[{'fleetActionsCancellation.checkedAt':{$exists:false}},{'fleetActionsCancellation.checkedAt':{$lte:new Date(now.getTime()-30_000).toISOString()}}]},
        {fleetCancellation:{$exists:false},$or: [{fleetDeadline: {$lte: now}, $or: [{state: {$ne: 'terminal'}}, {fleetBinding: {$exists: true}, dispatchCompletion: {$exists: false}, hostRejection: {$exists: false},
          preparationCancellation: {$exists: false}, preparationRejection: {$exists: false}}]},
        {state: {$ne: 'terminal'}, fleetBinding: {$exists: false},
          $or: [{fleetDispatch: {$exists: false}}, {'fleetDispatch.attempts': {$lte: 20}, 'fleetDispatch.lastAttemptAt': {$lte: new Date(now.getTime() - 30_000).toISOString()},
            $or:[{'fleetDispatch.checkedAt':{$exists:false}},{'fleetDispatch.checkedAt':{$lte:new Date(now.getTime()-30_000).toISOString()}}]}]}]}]})
      .sort({createdAt: 1, requestId: 1}).limit(limit).read('primary').readConcern('majority').lean() as unknown as StoredRoutineJob[];
  },
  async *qualificationCandidates(hostId, laneId, limit, now, timeoutMS, includeQueued) {
    const unbound = {state: 'awaiting-runner', hostId: {$exists: false}, fleetBinding: {$exists: false}};
    const cursor = TestRequestModel.find({...includeQueued ? {$or: [unbound,
      {state: 'queued', hostId, 'fleetBinding.hostId': hostId, 'fleetBinding.laneId': laneId,
        'input.laneId': laneId, inputSha256: {$exists: true}}]} : unbound,
      hostReceipt: {$exists: false}, runId: {$exists: false}, dispatchCompletion: {$exists: false},
      hostCancellation: {$exists: false}, hostRejection: {$exists: false},
      preparationCancellation: {$exists: false}, preparationRejection: {$exists: false},
      fleetCancellation: {$exists: false}, fleetDeadline: {$gt: now}, 'fleetSelection.platform': 'ios-on-mac',
      fleetPreparation: {$exists: true}, 'fleetPreparation.requirements.resources': {$elemMatch: {permissions: {$elemMatch: {recipient: 'app'}}}},
      $and: [{$or: [{'fleetTarget.hostId': {$exists: false}}, {'fleetTarget.hostId': hostId}]},
        {$or: [{'fleetTarget.laneId': {$exists: false}}, {'fleetTarget.laneId': laneId}]}]})
      .sort(includeQueued ? {state: -1, createdAt: 1, requestId: 1} : {createdAt: 1, requestId: 1}).limit(limit).read('primary').readConcern('majority')
      .setOptions({timeoutMS, maxTimeMS: timeoutMS}).lean().cursor({batchSize: 20});
    try {for await (const row of cursor) yield row as unknown as StoredRoutineJob;}
    finally {await cursor.close();}
  },
  async supersessionCandidates(limit, now) {
    return await TestRequestModel.find({state: {$ne: 'terminal'}, fleetCancellation: {$exists: false},
      'fleetSelection.source.channel': 'pr', $or: [{fleetSupersessionCheckedAt: {$exists: false}},
        {fleetSupersessionCheckedAt: {$lte: new Date(now.getTime() - 30_000)}}]})
      .sort({fleetSupersessionCheckedAt: 1, createdAt: 1, requestId: 1}).limit(limit)
      .read('primary').readConcern('majority').lean() as unknown as StoredRoutineJob[];
  },
  async supersessionChecked(requestId, now) {
    await TestRequestModel.updateOne({requestId}, {$set: {fleetSupersessionCheckedAt: now}}, {writeConcern: testWriteConcern});
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
    return await TestRequestModel.collection.findOneAndUpdate({requestId, hostId, inputSha256, $or: [{fleetBinding: {$exists: true}}, {hostReceipt: {$exists: true}}],
      dispatchCompletion: {$exists: false}}, [{$set: {dispatchCompletion: {$literal: dispatchCompletion}, updatedAt: new Date(),
        state: {$cond: [{$and: [{$ne: [{$type: '$fleetCancellation'}, 'missing']}, {$ne: ['$state', 'terminal']}]}, 'terminal', '$state']},
        terminalStatus: {$cond: [{$and: [{$ne: [{$type: '$fleetCancellation'}, 'missing']}, {$ne: ['$state', 'terminal']}]}, 'cancelled', '$terminalStatus']}}}],
      {returnDocument: 'after', writeConcern: testWriteConcern}) as unknown as StoredRoutineJob | null;
  },
  async hasResult(requestId) {
    return !!await TestRunModel.exists({requestId, resultSchemaVersion: 1}).read('primary').readConcern('majority');
  },
  async publicationFailed(requestId, hostId, completion, publicationFailure) {
    return await TestRequestModel.collection.findOneAndUpdate({requestId, hostId, inputSha256: completion.inputSha256,
      'hostReceipt.requestId': requestId, 'hostReceipt.hostId': hostId, 'hostReceipt.inputSha256': completion.inputSha256,
      runId: {$exists: false}, publicationFailure: {$exists: false},
      'dispatchCompletion.inputSha256': completion.inputSha256, 'dispatchCompletion.disposition': completion.disposition,
      'dispatchCompletion.completedAt': completion.completedAt},
      {$set: {publicationFailure, state: 'terminal', terminalStatus: 'incomplete', updatedAt: new Date()}},
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


/** A durable cancellation prevents binding; delivered work requires actual cleanup and a later measurement. */
export function reconcileRecorderHostReservations(claims: RecorderHostReservation[], rows: StoredRoutineJob[], offer: RecorderStorageObservation) {
  return claims.filter(claim => {
    const row = rows.find(value => value.requestId === claim.requestId);
    if (!row || row.fleetInputSha256 !== claim.fleetInputSha256) return true;
    if (offer.reservations.some(value => value.requestId === claim.requestId)) return true;
    // A different immutable winning receipt cannot ever bind this orphan claim, even after the winner binds or refuses preparation.
    const selected = recorderHostReservationSchema.safeParse(row.fleetResourceReservation);
    if (selected.success && selected.data.requestId === claim.requestId && selected.data.fleetInputSha256 === claim.fleetInputSha256 &&
      selected.data.id !== claim.id && (!row.fleetBinding || row.fleetBinding.hostId === selected.data.hostId && row.fleetBinding.laneId === selected.data.laneId)) return false;
    if (!row.fleetBinding && row.fleetCancellation) return false;
    // Host-source refusals cannot create executable input or its completion receipt. Their exact terminal fence plus a later empty offer settles the byte claim.
    if (row.fleetBinding?.hostId === claim.hostId && row.fleetBinding.laneId === claim.laneId && row.hostId === claim.hostId &&
      row.state === 'terminal' && row.inputSha256 === undefined && (row as StoredRoutineJob & {input?: unknown}).input === undefined && row.dispatchIntent &&
      requestInputDigest(row.dispatchIntent) === row.dispatchIntentSha256) {
      const intent = row.dispatchIntent as {requestId?: unknown; laneId?: unknown};
      const rejection = preparationRejectionSchema.safeParse(row.preparationRejection);
      const cancellation = z.object({requestedAt: z.string().datetime({offset: true}), reason: z.string().min(1).max(2000)}).strict().safeParse(row.preparationCancellation);
      const at = rejection.success && rejection.data.dispatchIntentSha256 === row.dispatchIntentSha256 ? rejection.data.rejectedAt
        : cancellation.success ? cancellation.data.requestedAt : undefined;
      if (intent.requestId === claim.requestId && intent.laneId === claim.laneId && at && Date.parse(at) <= Date.parse(offer.observedAt)) return false;
    }
    return !row.dispatchCompletion || Date.parse(row.dispatchCompletion.completedAt) > Date.parse(offer.observedAt);
  });
}
/** Exact local accepted input reservations already represent their remaining output in the measured offer. */
export function unobservedRecorderHostReservations(claims: RecorderHostReservation[], rows: StoredRoutineJob[], offer: RecorderStorageObservation): number {
  return claims.reduce((total, claim) => {
    const row = rows.find(value => value.requestId === claim.requestId);
    if (row?.fleetInputSha256 === claim.fleetInputSha256 && offer.reservations.some(value =>
      value.requestId === claim.requestId && value.inputSha256 === row.inputSha256)) return total;
    if (claim.poolId !== offer.poolId) return Number.POSITIVE_INFINITY;
    return total + Math.max(0, claim.minimumAvailableBytes - STORAGE_MARGIN_BYTES);
  }, 0);
}

/** Derive the same recorder prerequisite from the frozen policy, without rewriting prepared source identities. */
export function recorderCapacityRequirements(preparation: Pick<RoutineJobPreparation, 'requirements' | 'definition'>): PortableRequirements {
  const estimate = preparation.definition.execution?.policy?.estimatedOutputBytes;
  return portableRequirementsSchema.parse({...preparation.requirements, resources: preparation.requirements.resources.map(resource => {
    if (resource.kind !== 'recorder') return resource;
    const storage = recorderCapacityRequirement(estimate, resource.storage);
    if (!storage)
      throw new TestRequestConflict('Recording work requires a finite estimatedOutputBytes reservation');
    return {...resource, storage};
  })});
}
/** Derive routing only from the exact serialized definition. */
export function routinePortableRequirements(definition: RoutineEnrollment): PortableRequirements {
  const body = definition.definition;
  if (!body.execution) throw new TestRequestConflict('The routine has no execution resource metadata');
  const requirements = portableRequirementsSchema.parse({platform: definition.platform,
    ...(body.glasses ? {glasses: {models: body.glasses.models, capabilities: [...body.resourceRequirements.find(value => value.kind === "glasses")!.capabilities]}} : {}),
    resources: body.resourceRequirements});
  return recorderCapacityRequirements({definition: body, requirements});
}
export function routineLaneDescriptorRevision(lane: RoutingTestHostState['lanes'][number]): string {
  return requestInputDigest({id: lane.id, platform: lane.platform,
    resources: lane.resources.map(({permissionObservations: _, storage: _storage, ...resource}) => ({...resource, capabilities: [...resource.capabilities ?? []].sort()})).sort((a, b) => a.id.localeCompare(b.id)),
    glasses: (lane.glasses ?? []).map(glasses => ({...glasses, capabilities: [...glasses.capabilities].sort()})).sort((a, b) => a.resourceId.localeCompare(b.resourceId))});
}
export function compatibleRoutineLane(requirements: PortableRequirements, lane: RoutingTestHostState['lanes'][number],
  context?: {now: number; binding: FrameworkBinding; app?: {headSha: string; archiveSha256: string; receiptSha256: string}}, now = context?.now ?? Date.now()) {
  if (lane.platform !== requirements.platform || (lane.glasses?.length ?? 0) > 1 ||
    new Set(lane.resources.map(resource=>resource.kind)).size!==lane.resources.length) return false;
  if (!requirements.resources.every(required => lane.resources.some(offered => offered.kind === required.kind &&
    required.capabilities.every(capability => offered.capabilities?.includes(capability)) &&
    (!required.storage || recorderStorageAvailable(offered.storage, required.storage, now)) &&
    (required.permissions ?? []).every(value => Boolean(context && permissionObservationMatches(
      offered.permissionObservations?.find(observation => observation.permission === value.permission), value.permission,
      {...context, recipient: value.recipient})))))) return false;
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
      ...resource.capabilities.map(capability => `mentra-cap-${token(`${resource.kind}:${capability}`)}`),
      ...resource.permissions?.map(value => `mentra-permission-${token(`${resource.kind}:${value.recipient}:${value.permission}`)}`) ?? []]),
    ...(model ? [`mentra-glasses-${token(model)}`, ...requirements.glasses!.capabilities.map(capability => `mentra-glasses-cap-${token(`${model}:${capability}`)}`)] : []),
    ...(target?.hostId ? [`mentra-host-${token(target.hostId)}`] : []),
    ...(target?.laneId ? [`mentra-lane-${token(`${target.hostId}:${target.laneId}`)}`] : [])])].sort();
}
/** Queue model choice follows current accepting lanes; the portable alternatives stay immutable. */
export function routineJobRouting(requirements: PortableRequirements, hosts: RoutingTestHostState[], now: number, target?: StoredRoutineJob['fleetTarget'],
  build?: {headSha: string; archive?: {sha256: string}; receipt?: {sha256: string}}) {
  const compatible = hosts.filter(host => Number.isFinite(Date.parse(host.receivedAt)) && Date.parse(host.receivedAt) <= now && now - Date.parse(host.receivedAt) <= 120_000 &&
    (!target?.hostId || target.hostId === host.hostId)).flatMap(host => host.lanes.filter(lane =>
      (!target?.laneId || target.laneId === lane.id) && lane.dispatchMode === 'automatic' && lane.state !== 'offline' && lane.state !== 'out-of-service' && compatibleRoutineLane(requirements, lane, build ? permissionContext(host.frameworkBinding, build, now) : undefined, now)));
  const accepting = compatible.filter(lane => lane.state === 'idle');
  const chosenModel = requirements.glasses ? [...new Set(accepting.flatMap(lane => (lane.glasses ?? []).filter(glasses =>
    requirements.glasses!.models.includes(glasses.model) && requirements.glasses!.capabilities.every(value => glasses.capabilities.includes(value))).map(glasses => glasses.model)))].sort()[0]
    ?? [...requirements.glasses.models].sort()[0] : undefined;
  return {routingLabels: routineRequirementLabels(requirements, chosenModel, target), ...(chosenModel ? {chosenModel} : {}),
    ...(!accepting.length ? {waitingReason: compatible.length ? 'Awaiting an idle compatible enrolled runner' : 'Awaiting a compatible enrolled runner'} : {})};
}
export const routineJobInputDigest = (row: Pick<StoredRoutineJob, 'fleetSelection' | 'fleetPreparation' | 'fleetDeadline' | 'fleetTarget'>) =>
  requestInputDigest({selection: row.fleetSelection, prepared: row.fleetPreparation, deadline: row.fleetDeadline.toISOString(), target: row.fleetTarget ?? null});

// Canonical Harness main fda9fd5034e3255d9c7b6165fb86adc30963628e (#1034)
// publishes first-parent version 999 with original target/cancellation fencing.
const QUEUED_APP_QUALIFICATION_FRAMEWORK_VERSION = 999;

/** A queued handoff may refresh evidence only for its original, unaccepted executable identity. */
function queuedQualificationMatches(row: StoredRoutineJob, hostId: string, lane: RoutingTestHostState['lanes'][number]) {
  const input = frameworkRequestInputSchema.safeParse((row as StoredRoutineJob & {input?: unknown}).input),
    binding = routineJobBindingSchema.safeParse(row.fleetBinding), intent = routineDispatchIntentSchema.safeParse(row.dispatchIntent),
    prepared = row.fleetPreparation;
  if (!prepared || !input.success || !binding.success || !intent.success || row.hostId !== hostId ||
    binding.data.jobId !== row.requestId || binding.data.requestId !== row.requestId || binding.data.hostId !== hostId || binding.data.laneId !== lane.id ||
    binding.data.descriptorRevision !== routineLaneDescriptorRevision(lane) ||
    requestInputDigest(input.data) !== row.inputSha256 || requestInputDigest(intent.data) !== row.dispatchIntentSha256 ||
    requestInputDigest(intent.data) !== requestInputDigest({...row.fleetSelection, routineSource: prepared.routineSource, laneId: lane.id})) return false;
  const value = input.data, definition = prepared.definition, selected = row.fleetSelection;
  return row.requestId === selected.requestId && value.routineId === selected.routineId && value.platform === selected.platform && value.laneId === lane.id &&
    value.definitionRevision === selected.routineRevision && definition.id === selected.routineId &&
    definition.source.revision === selected.routineRevision && definition.minimumRoutineApiVersion === prepared.routineSource.minimumRoutineApiVersion &&
    value.minimumFrameworkVersion === selected.minimumFrameworkVersion && requestInputDigest(value.build) === requestInputDigest(selected.build) &&
    requestInputDigest(value.routineSource) === requestInputDigest(prepared.routineSource) &&
    requestInputDigest(value.policy ?? null) === requestInputDigest(definition.execution?.policy ?? null) &&
    value.resources.length === prepared.requirements.resources.length && new Set(value.resources.map(resource => resource.id)).size === value.resources.length &&
    prepared.requirements.resources.every(required => value.resources.filter(resource => resource.kind === required.kind &&
      (!resource.laneId || resource.laneId === lane.id) && lane.resources.some(offered => offered.id === resource.id && offered.kind === resource.kind)).length === 1);
}

/** Match Actions' automatic occurrence identity; manual requests and reruns retain their exact build. */
export function isAutomaticPrRoutineJob(row: StoredRoutineJob): boolean {
  const {source, routineId, platform} = row.fleetSelection;
  if (source.channel !== 'pr') return false;
  const exact = {channel: source.channel, buildRunId: source.buildRunId,
    publicationAttempt: source.publicationAttempt, prNumber: source.prNumber};
  const digest = createHash('sha256').update(JSON.stringify([
    `source-${source.channel}-${source.buildRunId}-${source.publicationAttempt}`, routineId, platform, exact, null])).digest('hex');
  return row.requestId === `routine-${digest}`;
}

export class RoutineJobService {
  constructor(private readonly rows: RoutineJobRepository = routineJobRepository,
    private readonly builds: Pick<TestBuildGateway, 'resolve' | 'isPrSuperseded'> = new GithubTestBuildGateway(),
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
    this.assertExactInputs(row);
    return row;
  }
  private assertExactInputs(row: StoredRoutineJob) {
    if (requestInputDigest(row.fleetSelection) !== row.fleetSelectionSha256 || row.fleetPreparation &&
      (row.fleetInputSha256 !== routineJobInputDigest(row) || requestInputDigest(row.fleetPreparation.definition) !== row.fleetPreparation.definitionSha256))
      throw new TestRunError(503, 'Stored routine job exact inputs are unavailable');
  }
  /** Passive target discovery precedes permission matching; only local reservation can acquire resources. */
  async qualificationTargets(hostId: string): Promise<RoutineQualificationTarget[]> {
    const now = this.now(), host = await this.hosts.get(hostId), binding = host?.frameworkBinding;
    if (!host || host.hostId !== hostId || !binding || binding.routineApiVersion < 38 ||
      !Number.isFinite(Date.parse(host.receivedAt)) || Date.parse(host.receivedAt) > now || now - Date.parse(host.receivedAt) > 120_000) return [];
    const targets: RoutineQualificationTarget[] = [], queryDeadline = now + 5_000;
    for (const lane of host.lanes) {
      if (lane.platform !== 'ios-on-mac' || lane.state !== 'idle' || lane.activity || lane.dispatchMode !== 'automatic' ||
        (lane.glasses?.length ?? 0) > 1 || new Set(lane.resources.map(resource => resource.kind)).size !== lane.resources.length) continue;
      if (!this.rows.qualificationCandidates || this.now() >= queryDeadline) break;
      // Finite ordered scan, shared five-second query budget; current 26-member suites fit without a mutable cursor.
      let scanned = 0;
      for await (const row of this.rows.qualificationCandidates(hostId, lane.id, 100, new Date(now), queryDeadline - this.now(),
        binding.version >= QUEUED_APP_QUALIFICATION_FRAMEWORK_VERSION)) {
        if (++scanned > 100 || this.now() >= queryDeadline) break;
        const queued = row.state === 'queued';
        if ((!queued && (row.state !== 'awaiting-runner' || row.hostId || row.fleetBinding)) ||
          queued && (binding.version < QUEUED_APP_QUALIFICATION_FRAMEWORK_VERSION || !queuedQualificationMatches(row, hostId, lane)) ||
          row.hostReceipt || row.runId || row.dispatchCompletion ||
          row.hostCancellation || row.hostRejection || row.preparationCancellation || row.preparationRejection ||
          row.fleetCancellation || !row.fleetPreparation ||
          row.fleetDeadline.getTime() <= now || row.fleetSelection.platform !== 'ios-on-mac' ||
          row.fleetTarget?.hostId && row.fleetTarget.hostId !== hostId || row.fleetTarget?.laneId && row.fleetTarget.laneId !== lane.id) continue;
        this.assertExactInputs(row);
        const requirements = row.fleetPreparation.requirements, context = permissionContext(binding, row.fleetSelection.build, now);
        if (!requirements.resources.some(resource => resource.permissions?.some(value => value.recipient === 'app')) ||
          row.fleetSelection.minimumFrameworkVersion && row.fleetSelection.minimumFrameworkVersion > binding.version ||
          row.fleetPreparation.routineSource.minimumRoutineApiVersion > binding.routineApiVersion) continue;
        // Structural suitability is only a probe candidate. The local provider still checks worker grants under reservation.
        const structural = {...requirements, resources: requirements.resources.map(({permissions: _, ...resource}) => resource)};
        const appGranted = requirements.resources.every(required => (required.permissions ?? []).filter(value => value.recipient === 'app')
          .every(value => Boolean(context && permissionObservationMatches(lane.resources.find(resource => resource.kind === required.kind)
            ?.permissionObservations?.find(observation => observation.permission === value.permission), value.permission,
          {...context, recipient: 'app'}))));
        if (!compatibleRoutineLane(structural, lane) || appGranted) continue;
        const target = {jobId: row.requestId, hostId, laneId: lane.id, deadline: row.fleetDeadline.toISOString(),
          selection: row.fleetSelection, requirements, ...(queued ? {target: {hostId, laneId: lane.id}} : row.fleetTarget ? {target: row.fleetTarget} : {})};
        targets.push(routineQualificationTargetSchema.parse({...target, inputSha256: requestInputDigest(target)}));
        break;
      }
    }
    return targets;
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
    await this.assertKnownPlatform(frozen);
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
    if (!await this.rows.get(frozen.requestId)) await this.assertKnownPlatform(frozen);
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
  private async supersession(row: StoredRoutineJob): Promise<StoredRoutineJob> {
    if (row.state === 'terminal' || row.fleetCancellation || this.now() >= row.fleetDeadline.getTime() || !isAutomaticPrRoutineJob(row) || !this.builds.isPrSuperseded) return row;
    const source = row.fleetSelection.source;
    if (source.channel === 'pr' && await this.builds.isPrSuperseded(source.prNumber, row.fleetSelection.build.headSha)) {
      await this.cancel(row.requestId, {reason: `Superseded by a newer commit on PR #${source.prNumber}`});
      return this.job(row.requestId);
    }
    return row;
  }
  private async deliver(row: StoredRoutineJob): Promise<StoredRoutineJob> {
    row = await this.supersession(row);
    if (!this.actionsTransport || row.fleetBinding || row.fleetCancellation || row.state === 'terminal' || this.now() >= row.fleetDeadline.getTime()) return row;
    const previous = row.fleetDispatch;
    if(previous && this.now()-Date.parse(previous.checkedAt ?? previous.lastAttemptAt)<30_000)return row;
    let runs;
    try {runs=await this.discover(row);} catch(error) {
      if(previous)await this.rows.dispatch?.(row.requestId,previous,{...previous,checkedAt:new Date(this.now()).toISOString(),error:error instanceof TestRunError?error.message:'Actions run discovery is unavailable'});
      return this.job(row.requestId);
    }
    if (!row.fleetPreparation && (previous?.attempts ?? 0) >= 20 && runs.every(run => run.status === 'completed') &&
      this.now() - Date.parse(previous!.lastAttemptAt) >= 120_000) {
      await this.rows.exhaustPreparation?.(row.requestId, runs.map(run => run.actionsRunId), new Date(this.now()));
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
    const candidates = await this.rows.supersessionCandidates?.(20, new Date(this.now())) ?? [];
    await Promise.allSettled(candidates.map(async candidate => {
      await this.rows.supersessionChecked?.(candidate.requestId, new Date(this.now()));
      await this.supersession(await this.job(candidate.requestId));
    }));
    const pending = await this.rows.pending?.(20, new Date(this.now())) ?? [];
    await Promise.allSettled(pending.map(row => row.fleetCancellation ? this.cancel(row.requestId,{reason:row.fleetCancellation.reason}) : this.observation(row.requestId)));
  }
  async preparation(jobId: string) {
    const row = await this.supersession(await this.job(jobId));
    const routing: Partial<ReturnType<typeof routineJobRouting>> = row.fleetPreparation ? await this.routing(row) : {};
    return {jobId, kind: 'run' as const, inputSha256: row.fleetInputSha256 ?? row.fleetSelectionSha256, deadline: row.fleetDeadline.toISOString(),
      state: row.state, ...routing, selection: row.fleetSelection, ...(row.fleetTarget ? {target: row.fleetTarget} : {}), ...(row.fleetPreparation ? {prepared: row.fleetPreparation} : {})};
  }
  private async routing(row: StoredRoutineJob) {
    const hosts = await this.hosts.list?.() ?? [], requirements = recorderCapacityRequirements(row.fleetPreparation!);
    const routed = routineJobRouting(requirements, hosts, this.now(), row.fleetTarget, row.fleetSelection.build);
    const inventoryRequirements = {...requirements, resources: requirements.resources.map(({storage: _, ...resource}) => resource)};
    const inventory = routineJobRouting(inventoryRequirements, hosts, this.now(), row.fleetTarget, row.fleetSelection.build);
    const retained = row.fleetResourceReservation;
    if (retained) {
      const checked = await this.rows.reserveResources?.(row.requestId, row.fleetInputSha256!, retained.hostId, retained.laneId, new Date(this.now()));
      if (!checked) {
        const targetInventory = routineJobRouting(inventoryRequirements, hosts, this.now(), retained, row.fleetSelection.build);
        return {...routed, chosenModel: retained.chosenModel, resourceTarget: {hostId: retained.hostId, laneId: retained.laneId},
          routingLabels: routineRequirementLabels(requirements, retained.chosenModel, retained),
          waitingReason: targetInventory.waitingReason ?? 'Awaiting fresh available recorder capacity on the reserved runner'};
      }
      return {...routed, chosenModel: retained.chosenModel, waitingReason: undefined, resourceTarget: {hostId: retained.hostId, laneId: retained.laneId},
        routingLabels: routineRequirementLabels(requirements, retained.chosenModel, retained)};
    }
    if (inventory.waitingReason) return inventory;
    if (routed.waitingReason) return {...routed, waitingReason: 'Awaiting fresh recorder disk and evidence staging capacity on an idle compatible runner'};
    for (const host of hosts) for (const lane of host.lanes) {
      if (row.fleetTarget?.hostId && row.fleetTarget.hostId !== host.hostId || row.fleetTarget?.laneId && row.fleetTarget.laneId !== lane.id ||
        lane.state !== 'idle' || lane.dispatchMode !== 'automatic' || !compatibleRoutineLane(requirements, lane, permissionContext(host.frameworkBinding, row.fleetSelection.build, this.now()), this.now())) continue;
      const saved = await this.rows.reserveResources?.(row.requestId, row.fleetInputSha256!, host.hostId, lane.id, new Date(this.now()));
      if (saved?.fleetResourceReservation) return {...routed, chosenModel: saved.fleetResourceReservation.chosenModel, resourceTarget: {hostId: saved.fleetResourceReservation.hostId, laneId: saved.fleetResourceReservation.laneId},
        routingLabels: routineRequirementLabels(requirements, saved.fleetResourceReservation.chosenModel, saved.fleetResourceReservation)};
    }
    return {...routed, waitingReason: 'Awaiting unreserved recorder disk capacity on a compatible runner'};
  }
  async preparationStatus(jobId: string, value: unknown) {
    const input = routinePreparationStatusSchema.parse(value), row = await this.job(jobId);
    if (input.inputSha256 !== row.fleetSelectionSha256 || !row.fleetActions?.some(run => run.actionsRunId === input.actionsRunId))
      throw new TestRequestConflict('Preparation status differs from its recorded exact workflow');
    if (row.fleetPreparation || row.fleetBinding || row.fleetCancellation || row.state === 'terminal') return row;
    if (row.fleetActions.some(run => BigInt(run.actionsRunId) > BigInt(input.actionsRunId))) return row;
    if (!this.rows.preparationStatus) throw new TestRunError(503, 'Preparation status storage is unavailable');
    const reason = input.code === 'not-applicable' ? `Routine ${row.fleetSelection.routineId} does not support ${row.fleetSelection.platform}.`
      : input.retryable ? `Routine source preparation failed during ${input.phase}; retrying the same request.`
      : `Routine source preparation failed during ${input.phase}; source validation requires correction.`;
    return await this.rows.preparationStatus(jobId, {...input, reason, observedAt: new Date(this.now()).toISOString()}, new Date(this.now())) ?? this.job(jobId);
  }
  private async assertKnownPlatform(selection: PortableRoutineSelection) {
    // An exact enrolled declaration is source evidence; absence alone cannot reject new source.
    const alternate = selection.platform === 'android' ? 'ios-on-mac' : 'android';
    const known = await this.definitions.getExact(selection.routineId, alternate, selection.routineRevision, true);
    if (known && !known.definition.platforms.includes(selection.platform))
      throw new TestRunError(422, `Routine ${selection.routineId} does not support ${selection.platform} at the selected source revision.`);
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
    const digest = routineJobInputDigest({...row, fleetPreparation: row.fleetPreparation ? {...prepared, requirements: row.fleetPreparation.requirements} : prepared});
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
    const input = routineJobBindInputSchema.parse(value);
    let row = await this.supersession(await this.job(jobId));
    if (row.fleetInputSha256 !== input.inputSha256 || !row.fleetPreparation)
      throw new TestRequestConflict('Binding changed its prepared exact inputs');
    if (row.fleetBinding) return this.bindingProjection(row, hostId, input);
    if (row.fleetCancellation || this.now() >= row.fleetDeadline.getTime())
      throw new TestRequestConflict('Cancelled or expired routine job cannot bind');
    if (row.fleetResourceReservation && (row.fleetResourceReservation.hostId !== hostId || row.fleetResourceReservation.laneId !== input.laneId))
      throw new TestRequestConflict('Device runner differs from its reserved recorder capacity');
    const requirements = recorderCapacityRequirements(row.fleetPreparation);
    const accepting = (host: Awaited<ReturnType<TestHostStateService['get']>>) => {
      const lane = host?.lanes.find(lane => lane.id === input.laneId);
      return host?.hostId === hostId && Number.isFinite(Date.parse(host.receivedAt)) && Date.parse(host.receivedAt) <= this.now() &&
        this.now() - Date.parse(host.receivedAt) <= 120_000 && lane?.dispatchMode === 'automatic' && lane.state === 'idle' &&
        (!row.fleetTarget?.hostId || row.fleetTarget.hostId === hostId) && (!row.fleetTarget?.laneId || row.fleetTarget.laneId === input.laneId) &&
        lane.descriptorRevision === input.descriptorRevision && routineLaneDescriptorRevision(lane) === input.descriptorRevision &&
        compatibleRoutineLane(requirements, {...lane, resources: lane.resources.map(resource => resource.storage ? {...resource,
          storage: {...resource.storage, reservations: resource.storage.reservations.filter(value =>
            value.requestId !== jobId || value.inputSha256 !== row.inputSha256)}} : resource)},
        permissionContext(host.frameworkBinding, row.fleetSelection.build, this.now()), this.now());
    };
    if (!accepting(await this.hosts.get(hostId)))
      throw new TestRequestConflict('Selected host has no current accepting compatible lane descriptor');
    const reserved = await this.rows.reserveResources?.(jobId, input.inputSha256, hostId, input.laneId, new Date(this.now()));
    if (!reserved)
      throw new TestRequestConflict('Reserved recorder disk capacity is no longer available');
    row = reserved;
    if (!accepting(await this.hosts.get(hostId)))
      throw new TestRequestConflict('Selected host has no current accepting compatible lane descriptor');
    const binding: RoutineJobBinding = {jobId, requestId: jobId, hostId, laneId: input.laneId,
      descriptorRevision: input.descriptorRevision, actionsJobId: input.actionsJobId, actionsRunId: input.actionsRunId, boundAt: new Date(this.now()).toISOString()};
    const intent = routineDispatchIntentSchema.parse({...row.fleetSelection, routineSource: row.fleetPreparation!.routineSource, laneId: input.laneId});
    const saved = await this.rows.bind(jobId, input.inputSha256, binding, intent, new Date(this.now()));
    const winner = saved ?? await this.job(jobId);
    if (!winner.fleetBinding) throw new TestRequestConflict('Routine job was cancelled or expired before binding');
    return this.bindingProjection(winner, hostId, input);
  }
  private async bindingProjection(row: StoredRoutineJob, hostId: string, input: z.infer<typeof routineJobBindInputSchema>) {
    const observation = await this.observation(row.requestId);
    row = await this.job(row.requestId);
    const binding = row.fleetBinding!;
    return {binding, execute: !row.fleetCancellation && !row.dispatchCompletion && this.now() < row.fleetDeadline.getTime() && row.state !== 'terminal' &&
      binding.hostId === hostId && binding.laneId === input.laneId && binding.actionsJobId === input.actionsJobId && binding.actionsRunId === input.actionsRunId,
      observation};
  }
  async cancel(jobId: string, value: unknown, phase?: ObservationPhase) {
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
    return this.observation(jobId, phase);
  }
  async actions(jobId: string, value: unknown) {
    const input = routineJobActionsSchema.parse(value); let row = await this.job(jobId);
    if (input.inputSha256 !== (row.fleetInputSha256 ?? row.fleetSelectionSha256)) throw new TestRequestConflict('Actions delivery changed its exact prepared input');
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
    const {publicationFailure, ...input} = routineJobCompletionReportSchema.parse(value);
    const lookup = async () => {
      if (!publicationFailure || !this.rows.completionRequest) return this.job(jobId);
      if (!frameworkIdentitySchema.safeParse(jobId).success) throw new TestRunError(400, 'Invalid job identity');
      const request = await this.rows.completionRequest(jobId);
      if (!request) throw new TestRunError(404, 'Routine request was not found');
      return request;
    };
    const row = await lookup();
    const executable = row as StoredRoutineJob & {inputSha256?: string};
    const accepted = publicationFailure ? row.hostReceipt?.requestId === jobId &&
      row.hostReceipt.hostId === hostId && row.hostReceipt.inputSha256 === input.inputSha256 : !!row.fleetBinding;
    if (!accepted || row.hostId !== hostId || executable.inputSha256 !== input.inputSha256)
      throw new TestRequestConflict('Dispatch completion differs from its accepted host and exact executable input');
    if (publicationFailure && publicationFailure.entityId !== jobId)
      throw new TestRequestConflict('Publication failure differs from its accepted request');
    let saved = row;
    if (row.dispatchCompletion) {
      if (requestInputDigest(row.dispatchCompletion) !== requestInputDigest(input))
        throw new TestRequestConflict('Dispatch completion changed its original custody disposition');
    } else {
      if (!this.rows.complete) throw new TestRunError(503, 'Dispatch completion storage is unavailable');
      saved = await this.rows.complete(jobId, hostId, input.inputSha256, input) ?? await lookup();
    }
    if (requestInputDigest(saved.dispatchCompletion) !== requestInputDigest(input))
      throw new TestRequestConflict('Dispatch completion changed its original custody disposition');
    if (!publicationFailure) return saved.dispatchCompletion;
    if (saved.publicationFailure && requestInputDigest(saved.publicationFailure) !== requestInputDigest(publicationFailure))
      throw new TestRequestConflict('Publication failure changed its original frozen receipt');
    // An inserted authenticated result may precede its request projection. Never
    // replace that result with an unpublished outcome; a later result projection
    // also wins the atomic runId guard below.
    if (!this.rows.hasResult) throw new TestRunError(503, 'Publication result lookup is unavailable');
    if (saved.runId || await this.rows.hasResult(jobId)) return {...saved.dispatchCompletion!, resultFound: true as const};
    if (!saved.publicationFailure) {
      if (!this.rows.publicationFailed) throw new TestRunError(503, 'Publication failure storage is unavailable');
      saved = await this.rows.publicationFailed(jobId, hostId, input, publicationFailure) ?? await lookup();
    }
    if (saved.runId || await this.rows.hasResult(jobId)) return {...saved.dispatchCompletion!, resultFound: true as const};
    if (!saved.publicationFailure || requestInputDigest(saved.publicationFailure) !== requestInputDigest(publicationFailure))
      throw new TestRequestConflict('Publication failure changed its original frozen receipt');
    return {...saved.dispatchCompletion!, publicationFailure: saved.publicationFailure};
  }
  async observation(jobId: string, phase: ObservationPhase = () => {}) {
    phase('request'); const saved = await this.job(jobId);
    phase('delivery'); let row = await this.deliver(saved);
    if (!row.fleetCancellation && this.now() >= row.fleetDeadline.getTime() && (row.state !== 'terminal' ||
      !!row.fleetBinding && !row.dispatchCompletion && !row.hostRejection && !row.preparationCancellation && !row.preparationRejection)) {
      phase('cancellation'); await this.cancel(jobId, {reason: 'Routine job reached its three-hour deadline'}, phase);
      phase('request'); row = await this.job(jobId);
    }
    phase('result'); let result: unknown;
    if (row.fleetBinding) try {result = await this.results.detail(jobId);}
    catch (error) {if (!(error instanceof TestRunError) || error.status !== 404) throw error;}
    phase('projection'); const reason = (!row.runId && row.publicationFailure ? `Publication failed: ${row.publicationFailure.message}` : undefined) ?? row.fleetCancellation?.reason ?? row.fleetPreparationStatus?.reason ?? row.fleetDispatch?.error ?? row.hostCancellation?.reason ?? row.preparationCancellation?.reason ??
      row.hostRejection?.reason ?? row.preparationRejection?.reason ?? row.preparation?.reason;
    return {jobId, kind: 'run' as const, inputSha256: row.fleetInputSha256 ?? row.fleetSelectionSha256,
      deadline: row.fleetDeadline.toISOString(), state: row.fleetCancellation && !row.fleetBinding ? 'terminal' : row.state,
      ...(row.fleetBinding ? {binding: row.fleetBinding, ...(row.inputSha256 ? {boundInputSha256: row.inputSha256} : {})} : {}),
      actionsRuns: row.fleetActions ?? [], ...(row.fleetActionsCancellation ? {actionsCancellation:row.fleetActionsCancellation} : {}), ...(reason ? {waitingReason: reason} : {}),
      terminal: !row.fleetBinding ? row.state === 'terminal' || !!row.fleetCancellation
        : !!row.hostRejection || !!row.preparationCancellation || !!row.preparationRejection || !!row.dispatchCompletion && row.state === 'terminal',
      ...(row.dispatchCompletion ? {cleanupDisposition: row.dispatchCompletion.disposition, dispatchCompletion: row.dispatchCompletion} : {}),
      ...(row.terminalStatus ? {terminalStatus: row.terminalStatus} : row.fleetCancellation && !row.fleetBinding ? {terminalStatus: 'not-run'} : {}),
      ...(result ? {result} : {})};
  }
}

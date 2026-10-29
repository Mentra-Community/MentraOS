import {createLogger} from '@mentra/cloud-shared/logger';
import {TestHostStateModel} from '../models/test-host-state.model';
import {unclaimedRoutineQualificationSchema, type UnclaimedRoutineQualification} from '../types/routine-job.types';
import {hostResourceReservationsSchema, isExclusiveHostReservation, fleetResourceAdmissionSchema} from '../types/resource-reservations.types';
import {recorderCapacityRequirement, recorderStorageAvailable, recorderHostReservationSchema, STORAGE_MARGIN_BYTES, type RecorderHostReservation, type RecorderStorageObservation} from '../types/recorder-storage.types';
import {createHash, randomUUID} from 'node:crypto';
import {z} from 'zod';
import {TestRequestModel} from '../models/test-request.model';
import {TestRunModel} from '../models/test-run.model';
import {testWriteConcern} from '../models/test-write-concern';
import {frameworkExecutableBuild, frameworkIdentitySchema, frameworkRequestInputSchema} from '../types/framework-request.types';
import {routineEnrollmentSchema, type RoutineEnrollment} from '../types/routine-definition.types';
import {preparationRejectionSchema, routineDispatchIntentSchema} from '../types/routine-dispatch.types';
import {routinePreparationStatusSchema, type RoutinePreparationStatus, completeRoutineJobPreparationSchema, portableRequirementsSchema, portableRoutineSelectionSchema, routineJobBindInputSchema,
  routineJobPreparationSchema, routineJobSubmissionSchema, routineJobCompletionReportSchema, routineJobActionsSchema, routineJobTargetSchema, type RoutineJobCompletion, type PortableRequirements, type PortableRoutineSelection,
  routineQualificationTargetSchema, routineJobCompletionSchema, fleetCandidatePreparationSchema, MAX_FLEET_CANDIDATE_PREPARATIONS, type FleetCandidatePreparation, routineJobBindingSchema, type RoutineQualificationTarget, ownedRoutineQualificationSchema, type OwnedRoutineQualification, type RoutineJobBinding, type RoutineJobPreparation, type RoutinePublicationFailure, type StoredRoutineJob} from '../types/routine-job.types';
import {acknowledgedTerminalCancellation, assertEnrolledRequest, requestInputDigest, TestRequestConflict, TestRequestService} from './test-request.service';
import {GithubTestBuildGateway, type TestBuildGateway} from './test-builds.service';
import {routineAdmissionInput} from './routine-admission.service';
import {selectedBuildInput} from '../types/test-build.types';
import {permissionObservationMatches, permissionContext} from '../types/resource-permissions.types';
import {BACKEND_CONNECTIVITY_ROUTINE_API_VERSION,
  resourceReadinessPurposeSchema, resourceReadinessMemberSchema, type ResourceReadinessPurpose} from '../types/backend-connectivity.types';
import {GithubRoutineSourceGateway, ROUTINE_SOURCE_DOWNLOAD_UNAVAILABLE} from './routine-source-selection.service';
import {configuredTestingTarget, retainedTestingTarget, routineSourceRepository, testingTarget} from '../types/testing-source.types';
import {RoutineDefinitionService} from './routine-definition.service';
import {hostStateSchema, TestHostStateService, type RoutingTestHostState, type ReceivedTestHostState} from './test-host-state.service';
import {FrameworkResultService} from './framework-result.service';
import {GithubRoutineJobActions, routineActionsRetry, cancelRoutineActions, type RoutineActionsCancellation, type RoutineJobActions} from './routine-job-actions.service';
import {TestRunError} from './test-result-error';
import {CandidateVerificationService, type CandidateAuthorization} from './candidate-verification.service';
import {backendRecorderClaimMatches, resourceIntentDependencies, requiresBackendConnectivity, requiresSerializedAndroidPreparation, resourceReservationRepository, routineResourceBlocker, routineResourcesAvailable, replaceableMacRecorderQuota, ResourceReservationsService, type ResourceReservationHost} from './resource-reservations.service';
import {resourceLaneBlocker, resourceCandidateBlocker, requiredResourceBlocker} from './resource-readiness';
import {evaluateRoutineLaneReadiness, routineLaneRequirementBlocker, type RoutineLaneEligibilityContext} from './routine-lane-eligibility';
import {dependencyWaitingReason, recorderWait, RESOURCE_ADMISSION_WAIT, sharedResourceWaitingReason, RECORDER_CAPACITY_WAIT, RECORDER_OBSERVATION_WAIT} from './routine-resource-wait';
import {candidateRequestCurrent, candidateSettlement, qualifiedGraphCandidate, candidateRenewal, candidateReturnMatches, graphCandidateHistoricalSettlement, obsoleteUnboundGraphCandidate} from './backend-candidate-preparation';
const exclusiveResources = new ResourceReservationsService();
const isDeepIdentity = (left: unknown, right: unknown) => requestInputDigest(left ?? null) === requestInputDigest(right ?? null);
export type SelectedRoutineLane = {requestId: string; hostId: string; laneId: string};
export type RoutinePreparationPhase = (phase: string, counts?: {hostCount?: number; hostIndex?: number; claimCount?: number; attempt?: number}) => void;
type ObservationPhase = (value: 'request' | 'delivery' | 'cancellation' | 'result' | 'projection') => void;
type LaneAcceptanceCondition = {id: string; status: 'passed' | 'failed' | 'not-evaluated'; expected: string;
  observed?: string | number | boolean | null | {code: string; resourceId?: string; laneId?: string; resourceKind?: string}};
export class RoutineLaneAcceptanceConflict extends TestRequestConflict {
  constructor(readonly diagnostics: {stage: 'before-reservation' | 'after-reservation'; hostId: string; laneId: string;
    conditions: LaneAcceptanceCondition[]}) {
    const failed = diagnostics.conditions.find(condition => condition.status === 'failed');
    // The installed worker accepts only the existing error/message envelope.
    // Keep the human checklist there; structured conditions use its current logger.
    super(`Selected host has no current accepting compatible lane descriptor. ${diagnostics.stage}: ${failed?.id}; ` +
      `expected ${failed?.expected}; observed ${JSON.stringify(failed?.observed)}. Checks: ` +
      diagnostics.conditions.map(condition => `${condition.id}=${condition.status}`).join(', '));
  }
}

const recorderReturnLogger = createLogger('core').child({service: 'recorder-return'});

/** These are fields on the existing test_requests record, never a separate scheduling queue. */
export interface RoutineJobRepository {
  get(jobId: string, timeoutMS?: number): Promise<StoredRoutineJob | null>;
  completionRequest?(jobId: string): Promise<StoredRoutineJob | null>;
  insert(row: StoredRoutineJob): Promise<void>;
  prepare(jobId: string, selectionSha256: string, prepared: RoutineJobPreparation, inputSha256: string, now: Date): Promise<StoredRoutineJob | null>;
  preparationStatus?(jobId: string, value: RoutinePreparationStatus, now: Date): Promise<StoredRoutineJob | null>;
  selectedLanes?(hostIds: string[]): Promise<SelectedRoutineLane[]>;
  recorderClaims?(jobId: string): Promise<RecorderHostReservation[]>;
  reconcileRecorderHost?(hostId: string, now: Date, onPhase?: RoutinePreparationPhase, onReturned?: () => void, acceptedHost?: ResourceReservationHost, requestId?: string): Promise<boolean>;
  checkpointBackendRecorder?(row: StoredRoutineJob, claim: RecorderHostReservation, now: Date): Promise<StoredRoutineJob | null>;
  reconcileBackendRecorderCancellation?(jobId: string, now: Date): Promise<void>;
  reserveResources?(jobId: string, inputSha256: string, hostId: string, laneId: string, now: Date,
    onWaiting?: (reason: string, exclusiveBlocker?: boolean) => void): Promise<StoredRoutineJob | null>;
  bind(jobId: string, inputSha256: string, binding: RoutineJobBinding, intent: unknown, now: Date): Promise<StoredRoutineJob | null>;
  candidatePreparation?(row: StoredRoutineJob, value: FleetCandidatePreparation, now: Date): Promise<StoredRoutineJob | null>;
  releaseCandidateProvisional?(row: StoredRoutineJob, now: Date): Promise<StoredRoutineJob | null>;
  settleCandidatePreparation?(row: StoredRoutineJob, value: FleetCandidatePreparation, now: Date): Promise<StoredRoutineJob | null>;
  supersedeCandidatePreparation?(row: StoredRoutineJob, now: Date): Promise<StoredRoutineJob | null>;
  pending?(limit: number, now: Date): Promise<StoredRoutineJob[]>;
  qualificationCandidates?(hostId: string, laneId: string, limit: number, now: Date, timeoutMS: number, includeQueued: boolean, includeAccepted?: boolean, includePreparing?: boolean, platform?: 'android' | 'ios-on-mac', graphOnly?: boolean): AsyncIterable<StoredRoutineJob>;
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
  async get(requestId, timeoutMS) {return await TestRequestModel.findOne({requestId, fleetSelection: {$exists: true}})
    .read('primary').readConcern('majority').setOptions(timeoutMS === undefined ? {} : {timeoutMS, maxTimeMS: timeoutMS}).lean() as unknown as StoredRoutineJob | null;},
  async completionRequest(requestId) {return await TestRequestModel.findOne({requestId})
    .read('primary').readConcern('majority').lean() as unknown as StoredRoutineJob | null;},
  async recorderClaims(requestId) {return resourceReservationRepository.recorderClaims!(requestId);},
  async reconcileRecorderHost(hostId, now, onPhase, onReturned, acceptedHost, requestId) {
    // Return reconciliation precedes readiness routing. Raw claims remain custody
    // until the original request and a later fresh same-pool offer prove return.
    for (let attempt = 0; attempt < 3; attempt++) {
      onPhase?.('recorder-host-read', {attempt});
      const host = attempt === 0 && acceptedHost?.hostId === hostId ? acceptedHost : await resourceReservationRepository.get(hostId, {recorderReturn: true}), checkedAt = Date.now();
      if (!host || host.hostId !== hostId || !freshRoutineHost(host.receivedAt, checkedAt) ||
        !freshRoutineHost(host.snapshot.observedAt, checkedAt) || Date.parse(host.snapshot.observedAt) > host.receivedAt.getTime()) return false;
      const all = hostResourceReservationsSchema.parse(host.resourceReservations ?? []),
        claims = all.filter((claim): claim is RecorderHostReservation => !isExclusiveHostReservation(claim) && (!requestId || claim.requestId === requestId));
      if (!claims.length) return true;
      onPhase?.('recorder-original-request-read', {attempt, claimCount: claims.length});
      const requests = await TestRequestModel.collection.find({requestId: {$in: claims.map(claim => claim.requestId)}},
        {projection: {requestId: 1, inputSha256: 1, fleetInputSha256: 1, fleetResourceReservation: 1, fleetBinding: 1, fleetCancellation: 1,
          dispatchCompletion: 1, input: 1, hostId: 1, state: 1, dispatchIntent: 1, dispatchIntentSha256: 1,
          preparationCancellation: 1, preparationRejection: 1, fleetCandidatePreparation: 1}, readPreference: 'primary', readConcern: {level: 'majority'}, timeoutMS: 5000})
        .limit(1001).toArray() as unknown as StoredRoutineJob[];
      if (requests.length > 1000) return false;
      const returned = claims.filter(claim => {
        const lane = host.snapshot.lanes.find(value => value.id === claim.laneId),
          offer = lane?.resources.find(value => value.kind === 'recorder')?.storage,
          observed = Date.parse(offer?.observedAt ?? ''), request = requests.find(value => value.requestId === claim.requestId),
          completion = routineJobCompletionSchema.safeParse(request?.dispatchCompletion),
          cancellationAt = request?.fleetCancellation && !request.fleetBinding ? Date.parse(request.fleetCancellation.requestedAt) : undefined;
        if (request?.fleetCandidatePreparation || request?.dispatchCompletion && !completion.success ||
          completion.success && (completion.data.inputSha256 !== request?.inputSha256 || Date.parse(completion.data.completedAt) < Date.parse(claim.reservedAt) || Date.parse(completion.data.completedAt) > observed) ||
          cancellationAt !== undefined && (!Number.isFinite(cancellationAt) || cancellationAt < Date.parse(claim.reservedAt) || cancellationAt > observed)) return false;
        return claim.hostId === hostId && offer?.poolId === claim.poolId &&
          Number.isFinite(observed) && observed >= Date.parse(claim.reservedAt) && observed <= Date.parse(host.snapshot.observedAt) &&
          freshRoutineHost(offer.observedAt, Date.now()) &&
          reconcileRecorderHostReservations([claim], requests, offer).length === 0;
      });
      if (!returned.length) return true;
      if (!freshRoutineHost(host.receivedAt, Date.now()) || !freshRoutineHost(host.snapshot.observedAt, Date.now())) return false;
      onPhase?.('recorder-return-CAS', {attempt, claimCount: claims.length});
      if (await resourceReservationRepository.replace(host, all.filter(claim => !returned.includes(claim as RecorderHostReservation)))) {
        onReturned?.(); return true;
      }
    }
    return false;
  },
  async checkpointBackendRecorder(row, value, now) {
    const parsed=recorderHostReservationSchema.safeParse(value),claim=parsed.success?parsed.data:undefined,
      previous=claim&&candidateRenewal(row,claim.hostId,claim.laneId);
    if (!claim || !previous || !candidateReturnMatches(previous,previous.returnReceipt) ||
      !candidateRequestCurrent({...row,fleetCandidateSelection:undefined,fleetCandidatePreparation:previous},previous,now.getTime()) ||
      !requiresBackendConnectivity(row) ||
      row.state!=='awaiting-runner' || row.fleetCancellation || row.fleetDeadline<=now || row.fleetCandidatePreparation ||
      row.fleetResourceReservation || row.fleetResourceAdmission || row.fleetExclusiveReservation || row.fleetBinding || row.hostId ||
      row.inputSha256 || row.dispatchIntent || row.hostReceipt || row.runId || row.dispatchCompletion || row.fleetExclusiveExecutionBinding || !row.fleetPreparation ||
      claim.requestId!==row.requestId || claim.fleetInputSha256!==row.fleetInputSha256 || routineJobInputDigest(row)!==row.fleetInputSha256 ||
      requestInputDigest(row.fleetSelection)!==row.fleetSelectionSha256 || Date.parse(claim.reservedAt)<Date.parse((previous.returnReceipt as {release:{releasedAt:string}}).release.releasedAt) ||
      Date.parse(claim.reservedAt)>now.getTime()) return null;
    const originals=await this.recorderClaims!(row.requestId),host=await resourceReservationRepository.get(claim.hostId),
      lane=host?.snapshot.lanes.find(value=>value.id===claim.laneId),phone=host?.snapshot.resourceLifecycle?.subjects.find(value=>value.subject.id===previous.target.purpose?.resourceId),
      offer=lane?.resources.find(value=>value.kind==='recorder')?.storage,
      required=recorderCapacityRequirements(row.fleetPreparation).resources.find(value=>value.kind==='recorder')?.storage;
    if (originals.length!==1 || requestInputDigest(originals[0])!==requestInputDigest(claim) || !host ||
      [host.receivedAt.getTime(),Date.parse(host.snapshot.observedAt)].some(at=>!Number.isFinite(at)||at>now.getTime()||now.getTime()-at>120_000) ||
      host.incarnation!==previous.candidate.controller.incarnation || host.incarnationGeneration!==previous.candidate.controller.generation ||
      requestInputDigest(host.snapshot.frameworkBinding)!==requestInputDigest(previous.target.acceptedBinding) ||
      lane?.state!=='idle' || lane.dispatchMode!=='automatic' || lane.activity || !phone?.current || phone.owner!==null ||
      phone.subject.authorityHostId!==host.hostId || !offer || !required || offer.poolId!==claim.poolId ||
      required.minimumAvailableBytes!==claim.minimumAvailableBytes || !Number.isFinite(Date.parse(offer.observedAt)) ||
      Date.parse(offer.observedAt)>now.getTime() || now.getTime()-Date.parse(offer.observedAt)>120_000 ||
      offer.reservations.some(value=>value.requestId===row.requestId) ||
      host.snapshot.resourceReservations?.claims.some(value=>value.owner.id===row.requestId)) return null;
    const authority=hostResourceReservationsSchema.parse(host.resourceReservations??[]);
    if (!authority.some(value=>requestInputDigest(value)===requestInputDigest(claim)) || authority.some(value=>isExclusiveHostReservation(value)
      ? value.borrowerHostId===claim.hostId&&value.laneId===claim.laneId : value.hostId===claim.hostId&&value.laneId===claim.laneId&&value.id!==claim.id)) return null;
    // This receipt preserves a host-CAS winner as cleanup custody. It grants no run admission and needs no fresh phone health.
    return await TestRequestModel.collection.findOneAndUpdate({requestId:row.requestId,fleetInputSha256:row.fleetInputSha256,
      fleetSelectionSha256:row.fleetSelectionSha256,fleetCandidatePreparations:row.fleetCandidatePreparations,
      fleetCandidateSelection:row.fleetCandidateSelection,state:'awaiting-runner',fleetDeadline:{$gt:now},fleetCancellation:{$exists:false},
      fleetCandidatePreparation:{$exists:false},fleetResourceReservation:{$exists:false},fleetResourceAdmission:{$exists:false},
      fleetExclusiveReservation:{$exists:false},fleetBinding:{$exists:false},hostId:{$exists:false},input:{$exists:false},inputSha256:{$exists:false},
      dispatchIntent:{$exists:false},hostReceipt:{$exists:false},runId:{$exists:false},dispatchCompletion:{$exists:false},fleetExclusiveExecutionBinding:{$exists:false}},
      {$set:{fleetResourceReservation:claim}},{returnDocument:'after',writeConcern:testWriteConcern,timeoutMS:5000}) as unknown as StoredRoutineJob|null;
  },
  async reconcileBackendRecorderCancellation(requestId, now) {
    const original = await this.get(requestId);
    if (!original || original.fleetSelection?.platform !== 'android' || !original.fleetCancellation || original.state !== 'terminal' ||
      original.fleetBinding || original.hostId || original.inputSha256 || (original as StoredRoutineJob & {input?: unknown}).input) return;
    const claims = await this.recorderClaims!(requestId);
    for (const hostId of new Set(claims.map(claim => claim.hostId))) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const host = await resourceReservationRepository.get(hostId);
        if (!host || host.hostId !== hostId || host.receivedAt > now || now.getTime() - host.receivedAt.getTime() > 120_000 ||
          Date.parse(host.snapshot.observedAt) > now.getTime() || now.getTime() - Date.parse(host.snapshot.observedAt) > 120_000) break;
        const current = await this.get(requestId);
        if (!current || current.fleetInputSha256 !== original.fleetInputSha256 || current.fleetSelectionSha256 !== original.fleetSelectionSha256 ||
          !current.fleetPreparation || routineJobInputDigest(current) !== original.fleetInputSha256 ||
          requestInputDigest(current.fleetSelection) !== original.fleetSelectionSha256 ||
          current.state !== 'terminal' || current.fleetBinding || current.hostId || current.inputSha256 ||
          (current as StoredRoutineJob & {input?: unknown}).input ||
          requestInputDigest(current.fleetCancellation) !== requestInputDigest(original.fleetCancellation)) break;
        const all = hostResourceReservationsSchema.parse(host.resourceReservations ?? []), retained = all.filter(claim => {
          if (isExclusiveHostReservation(claim) || claim.requestId !== requestId || claim.fleetInputSha256 !== original.fleetInputSha256) return true;
          const offer = host.snapshot.lanes.find(lane => lane.id === claim.laneId)?.resources.find(resource =>
            resource.kind === 'recorder')?.storage;
          return !offer || offer.poolId !== claim.poolId || Date.parse(offer.observedAt) < Date.parse(original.fleetCancellation!.requestedAt) ||
            Date.parse(offer.observedAt) > now.getTime() || now.getTime() - Date.parse(offer.observedAt) > 120_000 ||
            reconcileRecorderHostReservations([claim], [current], offer).length !== 0;
        });
        if (retained.length === all.length || await resourceReservationRepository.replace(host, retained)) break;
      }
    }
  },
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
  async candidatePreparation(row, value, now) {
    const previous = candidateRenewal(row, value.hostId, value.laneId), renewal = value.candidate.previousAttemptId;
    if (renewal ? !previous || previous.candidate.attemptId !== renewal : Boolean(row.fleetCandidateSelection)) return null;
    if (previous?.coordinatorSupersession && (value.candidate.controller.generation < previous.coordinatorSupersession.controller.generation ||
      value.candidate.controller.incarnation === previous.candidate.controller.incarnation)) return null;
    const provisional = value.provisionalReturn;
    if (provisional && (!renewal || requestInputDigest(provisional.recorder) !== requestInputDigest(row.fleetResourceReservation) ||
      requestInputDigest(provisional.admission ?? null) !== requestInputDigest(row.fleetResourceAdmission ?? null) ||
      requestInputDigest(provisional.exclusive ?? null) !== requestInputDigest(row.fleetExclusiveReservation ?? null) || provisional.releasedAt)) return null;
    if (!candidateRequestCurrent({...row, fleetCandidatePreparation: value, fleetCandidateSelection: undefined}, value, now.getTime(), Boolean(provisional)) ||
      (row.fleetCandidatePreparations?.length ?? 0) >= MAX_FLEET_CANDIDATE_PREPARATIONS ||
      !renewal && row.fleetCandidatePreparations?.some(old => old.hostId === value.hostId && old.laneId === value.laneId)) return null;
    return await TestRequestModel.collection.findOneAndUpdate({requestId: row.requestId, fleetInputSha256: row.fleetInputSha256,
      state: 'awaiting-runner', fleetCandidatePreparation: {$exists: false}, fleetCandidateSelection: row.fleetCandidateSelection ?? {$exists: false},
      fleetCandidatePreparations: row.fleetCandidatePreparations ?? {$exists: false},
      fleetBinding: {$exists: false}, fleetResourceAdmission: row.fleetResourceAdmission ?? {$exists: false}, fleetResourceReservation: row.fleetResourceReservation ?? {$exists: false},
      fleetExclusiveReservation: row.fleetExclusiveReservation ?? {$exists: false}, hostId: {$exists: false}, inputSha256: {$exists: false}, input: {$exists: false},
      fleetCancellation: {$exists: false}, fleetDeadline: {$gt: now}}, {$set: {fleetCandidatePreparation: value, updatedAt: now},
        ...(renewal ? {$unset: {fleetCandidateSelection: ''}} : {})},
      {returnDocument: 'after', writeConcern: testWriteConcern, timeoutMS: 5000}) as unknown as StoredRoutineJob | null;
  },
  async releaseCandidateProvisional(row, now) {
    return releaseCandidateProvisional(row, now);
  },
  async settleCandidatePreparation(row, value, now) {
    const original = row.fleetCandidatePreparation;
    if (!original || !value.settlement) return null;
    if (requestInputDigest((({settlement: _, ...v}) => v)(value)) !== requestInputDigest(original)) return null;
    // Settlement can finish after cancellation/deadline; it releases only this pending probe, never starts another one.
    const filter = {requestId: row.requestId, fleetInputSha256: row.fleetInputSha256,
      fleetCandidatePreparation: row.fleetCandidatePreparation, fleetCandidatePreparations: row.fleetCandidatePreparations ?? {$exists: false},
      fleetBinding: {$exists: false}, fleetResourceAdmission: {$exists: false}, hostId: {$exists: false}},
      update = {$unset: {fleetCandidatePreparation: ''}, $set: {fleetCandidatePreparations: [...row.fleetCandidatePreparations ?? [], value], updatedAt: now}},
      options = {returnDocument: 'after' as const, writeConcern: testWriteConcern, timeoutMS: 5000};
    if (value.settlement!.outcome !== 'qualified') return await TestRequestModel.collection.findOneAndUpdate(filter, update, options) as unknown as StoredRoutineJob | null;
    // Current request state, not a prior read, decides whether this positive may select a phone.
    const selected = await TestRequestModel.collection.findOneAndUpdate({...filter, state: 'awaiting-runner',
      fleetCancellation: {$exists: false}, hostCancellation: {$exists: false}, preparationCancellation: {$exists: false}, fleetDeadline: {$gt: now}},
      {...update, $set: {...update.$set, fleetCandidateSelection: {hostId: value.hostId, laneId: value.laneId, targetInputSha256: value.targetInputSha256}}}, options);
    if (selected) return selected as unknown as StoredRoutineJob;
    return await TestRequestModel.collection.findOneAndUpdate({...filter, $or: [{state: {$ne: 'awaiting-runner'}},
      {fleetCancellation: {$exists: true}}, {hostCancellation: {$exists: true}}, {preparationCancellation: {$exists: true}}, {fleetDeadline: {$lte: now}}]},
      update, options) as unknown as StoredRoutineJob | null;
  },
  async supersedeCandidatePreparation(row, now) {
    const pending = row.fleetCandidatePreparation, host = pending && await new TestHostStateService().get(pending.hostId),
      preserved = host && obsoleteUnboundGraphCandidate(row, host, now.getTime())
    if (!preserved) return null
    return await TestRequestModel.collection.findOneAndUpdate({requestId: row.requestId, fleetInputSha256: row.fleetInputSha256,
      state: 'awaiting-runner', fleetCandidatePreparation: pending, fleetCandidatePreparations: row.fleetCandidatePreparations ?? {$exists: false},
      fleetCandidateSelection: {$exists: false}, fleetBinding: {$exists: false}, fleetResourceAdmission: {$exists: false},
      fleetResourceReservation: {$exists: false}, fleetExclusiveReservation: {$exists: false}, fleetExclusiveExecutionBinding: {$exists: false},
      hostId: {$exists: false}, inputSha256: {$exists: false}, hostReceipt: {$exists: false}, runId: {$exists: false}, dispatchIntent: {$exists: false},
      dispatchCompletion: {$exists: false}, fleetCancellation: {$exists: false}, hostCancellation: {$exists: false},
      preparationCancellation: {$exists: false}, fleetDeadline: {$gt: now}},
      {$unset: {fleetCandidatePreparation: ''}, $set: {fleetCandidatePreparations: [...row.fleetCandidatePreparations ?? [], preserved], updatedAt: now}},
      {returnDocument: 'after', writeConcern: testWriteConcern, timeoutMS: 5000}) as unknown as StoredRoutineJob | null
  },
  async selectedLanes(hostIds) {
    // Staged candidates can exist before the byte claim is acknowledged. Read only
    // those existing selections; completed history is not scheduling evidence.
    const rows = await TestRequestModel.find({'fleetResourceAdmission.intent.hostId': {$in: hostIds},
      fleetResourceReservation: {$exists: false}, dispatchCompletion: {$exists: false}, fleetCancellation: {$exists: false},
      state: {$in: ['awaiting-runner', 'preparing', 'queued', 'accepted']}})
      .select({requestId: 1, fleetResourceAdmission: 1, _id: 0}).limit(1001)
      .read('primary').readConcern('majority').setOptions({timeoutMS: 5000}).lean();
    if (rows.length > 1000) throw new TestRunError(503, 'Selected lane inventory exceeds its bounded routing read');
    return rows.map(row => {
      const requestId = frameworkIdentitySchema.parse(row.requestId), admission = fleetResourceAdmissionSchema.parse(row.fleetResourceAdmission);
      if (admission.intent.owner.kind !== 'run' || admission.intent.owner.id !== requestId || !admission.intent.laneId)
        throw new TestRunError(503, 'Selected lane inventory has inconsistent request identity');
      return {requestId, hostId: admission.intent.hostId, laneId: admission.intent.laneId};
    });
  },
  async reserveResources(requestId, fleetInputSha256, hostId, laneId, now, onWaiting) {
    if (!await this.reconcileRecorderHost!(hostId, now)) {onWaiting?.(RESOURCE_ADMISSION_WAIT); return null;}
    for (let attempt = 0; attempt < 3; attempt++) {
      let row = await TestRequestModel.collection.findOne({requestId, fleetInputSha256, state: 'awaiting-runner',
        fleetBinding: {$exists: false}, fleetCancellation: {$exists: false}, fleetDeadline: {$gt: now}},
        {readPreference: 'primary', readConcern: {level: 'majority'}, timeoutMS: 10_000}) as unknown as StoredRoutineJob | null;
      if (!row?.fleetPreparation || row.fleetCandidatePreparation) return null;
      if (row.fleetResourceAdmission && (row.fleetResourceAdmission.intent.operationId !== `run:${requestId}` ||
        row.fleetResourceAdmission.intent.owner.kind !== 'run' || row.fleetResourceAdmission.intent.owner.id !== requestId ||
        row.fleetResourceAdmission.intent.inputSha256 !== fleetInputSha256)) return null;
      const originals = await resourceReservationRepository.recorderClaims!(requestId), quota = row.fleetResourceReservation,
        quotaAdmission = row.fleetResourceAdmission,
        replacingQuota = Boolean(quota && (quota.hostId !== hostId || quota.laneId !== laneId) &&
          replaceableMacRecorderQuota(row, await resourceReservationRepository.get(quota.hostId), originals, now.getTime()));
      const selected = replacingQuota ? undefined : quota;
      if (selected && (selected.hostId !== hostId || selected.laneId !== laneId)) return null;
      if (row.fleetExclusiveReservation && (row.fleetExclusiveReservation.intent.hostId !== hostId ||
        row.fleetExclusiveReservation.intent.laneId !== laneId)) return null;
      const hostRow = await TestHostStateModel.collection.findOne({hostId},
        {readPreference: 'primary', readConcern: {level: 'majority'}, timeoutMS: 10_000});
      if (!hostRow) return null;
      const host = {...hostStateSchema.parse(hostRow.snapshot), receivedAt: hostRow.receivedAt.toISOString(),
        resourceControlRecords: hostRow.laneControls, resourceLifecycleCursor: hostRow.resourceLifecycleCursor};
      const requirements = recorderCapacityRequirements(row.fleetPreparation), lane = host.lanes.find(value => value.id === laneId),
        required = requirements.resources.find(value => value.kind === 'recorder')?.storage;
      const sourceOffer = lane?.resources.find(value => value.kind === 'recorder')?.storage;
      const executionDigest = row.inputSha256;
      const offered = sourceOffer && {...sourceOffer, reservations: sourceOffer.reservations.filter(value =>
        value.requestId !== requestId || value.inputSha256 !== executionDigest)};
      if (host.hostId !== hostId || !lane || !required || !offered || lane.activity || lane.dispatchMode !== 'automatic' ||
        now.getTime() - hostRow.receivedAt.getTime() > 120_000 || hostRow.receivedAt > now ||
        !compatibleStructuralRoutineLane(requirements, {...lane, resources: lane.resources.map(value => value.kind === 'recorder' ? {...value, storage: offered} : value)}, routineLaneContext(host, row.fleetSelection.build, now.getTime()), now.getTime())) {
        if (lane && required && !lane.activity && lane.dispatchMode === 'automatic' && hostRow.receivedAt <= now &&
            now.getTime() - hostRow.receivedAt.getTime() <= 120_000 && compatibleStructuralRoutineLane({...requirements,
              resources: requirements.resources.map(({storage: _, ...resource}) => resource)}, lane,
              routineLaneContext(host, row.fleetSelection.build, now.getTime()), now.getTime()))
          onWaiting?.(recorderWait(offered, required.minimumAvailableBytes, now.getTime()) ?? RESOURCE_ADMISSION_WAIT);
        return null;
      }
      const serializedPreparation = requiresSerializedAndroidPreparation(lane);
      if (!replacingQuota && originals.some(claim => claim.fleetInputSha256 !== fleetInputSha256 || claim.hostId !== hostId || claim.laneId !== laneId) || originals.length > 1) {
        onWaiting?.(RESOURCE_ADMISSION_WAIT, true); return null;
      }
      // Keep the current owned phone diagnosis when refusing a new selection.
      // Existing custody still reconciles through its original admission path.
      if (!routineResourcesAvailable({hostId: host.hostId, incarnation: host.incarnation, incarnationGeneration: host.incarnationGeneration,
        sequence: host.sequence, receivedAt: hostRow.receivedAt, snapshot: host, laneControls: hostRow.laneControls, resourceReservations: hostRow.resourceReservations,
        resourceLifecycleCursor: hostRow.resourceLifecycleCursor}, row, laneId, now.getTime())) {
        onWaiting?.(RESOURCE_ADMISSION_WAIT, Boolean(originals.length || selected || row.fleetExclusiveReservation)); return null;
      }
      if (serializedPreparation) {
        if (originals.length && !backendRecorderClaimMatches(originals, requestId, fleetInputSha256, hostId, laneId)) {
          onWaiting?.(RESOURCE_ADMISSION_WAIT, true); return null;
        }
      }
      const allClaims = hostResourceReservationsSchema.parse(hostRow.resourceReservations ?? []),
        exclusiveClaims = allClaims.filter(isExclusiveHostReservation), claims = allClaims.filter((value): value is RecorderHostReservation => !isExclusiveHostReservation(value));
      // Probe custody and run admission share this host row. Refuse before selecting a fleet candidate.
      if (exclusiveClaims.some(claim => claim.prerequisite && claim.borrowerHostId === hostId && claim.laneId === laneId)) {
        onWaiting?.('Awaiting the current phone backend prerequisite release', Boolean(originals.length || selected || row.fleetExclusiveReservation)); return null;
      }
      const requests = claims.length ? await TestRequestModel.collection.find({requestId: {$in: claims.map(value => value.requestId)}},
        {projection: {requestId: 1, inputSha256: 1, fleetInputSha256: 1, fleetResourceReservation: 1, fleetBinding: 1, fleetCancellation: 1,
          dispatchCompletion: 1, input: 1, hostId: 1, state: 1, dispatchIntent: 1, dispatchIntentSha256: 1,
          preparationCancellation: 1, preparationRejection: 1}, readPreference: 'primary', readConcern: {level: 'majority'}, timeoutMS: 10_000}).limit(1001).toArray() as unknown as StoredRoutineJob[] : [];
      const retained = reconcileRecorderHostReservations(claims, requests, offered);
      const own = retained.find(value => value.requestId === requestId && value.fleetInputSha256 === fleetInputSha256);
      if (retained.some(value => value.requestId === requestId && value.fleetInputSha256 !== fleetInputSha256) ||
        selected && own?.id !== selected.id || own && own.poolId !== offered.poolId || !own && retained.length + exclusiveClaims.length >= 1000) return null;
      // Serialize before any request stage/dependency claim. Byte capacity alone cannot
      // authorize a future owner that would defeat the selected request's one phone check.
      if (serializedPreparation && (retained.some(value => value !== own && value.hostId === hostId && value.laneId === laneId) ||
        exclusiveClaims.some(value => value.borrowerHostId === hostId && value.laneId === laneId &&
          (value.owner.kind !== 'run' || value.owner.id !== requestId)))) {
        onWaiting?.('Awaiting the current Android lane preparation or resource return', Boolean(own || selected || row.fleetExclusiveReservation)); return null;
      }
      const unobserved = unobservedRecorderHostReservations(retained.filter(value => value !== own), requests, offered);
      if (!recorderStorageAvailable(offered, required, now.getTime(), unobserved)) {
        onWaiting?.(recorderWait(offered, required.minimumAvailableBytes, now.getTime(), unobserved) ?? RESOURCE_ADMISSION_WAIT); return null;
      }
      // A selected local Mac claim is already reserved. Validate its original
      // admission here; binding supplies the atomic authority CAS, not a second
      // reservation write. Exclusive dependencies keep their authority path.
      if (selected && lane.platform === 'ios-on-mac' && row.fleetResourceAdmission?.dependencies.length === 0 &&
        !row.fleetExclusiveReservation && requirements.resources.every(required => !lane.resources.find(resource => resource.kind === required.kind)!
          .exclusiveDependencies?.some(dependency => required.capabilities.includes(dependency.capability)))) {
        const admission = fleetResourceAdmissionSchema.safeParse(row.fleetResourceAdmission);
        if (!admission.success) return null;
        const intent = admission.data.intent;
        const expected = {operationId: `run:${requestId}`, hostId, laneId, inputSha256: fleetInputSha256,
          owner: {id: requestId, kind: 'run'}, controller: intent.controller,
          resources: requirements.resources.map(required => ({id: lane.resources.find(resource => resource.kind === required.kind)!.id,
            capabilities: [...required.capabilities]}))};
        if (!isDeepIdentity(intent, expected) || !isDeepIdentity(own, selected)) return null;
        const authorities = await resourceReservationRepository.claimedHosts!(requestId), checkedAt = Date.now();
        if (!authorities || authorities.length || row.fleetDeadline.getTime() <= checkedAt || !routineResourcesAvailable({hostId: host.hostId,
          incarnation: host.incarnation, incarnationGeneration: host.incarnationGeneration, sequence: host.sequence, receivedAt: hostRow.receivedAt,
          snapshot: host, laneControls: hostRow.laneControls, resourceReservations: hostRow.resourceReservations,
          resourceLifecycleCursor: hostRow.resourceLifecycleCursor}, row, laneId, checkedAt)) return null;
        return row;
      }
      const chosenModel = row.fleetPreparation.requirements.glasses ? lane.glasses!.find(value =>
        row!.fleetPreparation!.requirements.glasses!.models.includes(value.model))!.model : undefined;
      const claim = own ?? {id: randomUUID(), requestId, fleetInputSha256, hostId, laneId, poolId: offered.poolId,
        minimumAvailableBytes: required.minimumAvailableBytes, reservedAt: now.toISOString(), ...(chosenModel ? {chosenModel} : {})};
      const borrower: ResourceReservationHost = {hostId, incarnation: hostRow.incarnation, incarnationGeneration: hostRow.incarnationGeneration,
        sequence: hostRow.sequence, receivedAt: hostRow.receivedAt, snapshot: host, laneControls: hostRow.laneControls,
        laneControlVersion: hostRow.laneControlVersion, resourceReservations: hostRow.resourceReservations,
        resourceReservationVersion: hostRow.resourceReservationVersion, resourceLifecycleCursor: hostRow.resourceLifecycleCursor};
      const candidateIntent = {operationId: `run:${requestId}`, hostId, laneId, inputSha256: fleetInputSha256,
        owner: {id: requestId, kind: 'run' as const}, controller: {incarnation: hostRow.incarnation,
          generation: hostRow.incarnationGeneration, sequence: hostRow.sequence},
        resources: requirements.resources.map(required => ({id: lane.resources.find(resource => resource.kind === required.kind)!.id,
          capabilities: [...required.capabilities]}))};
      const candidateAdmission = fleetResourceAdmissionSchema.parse({intent: candidateIntent,
        dependencies: resourceIntentDependencies(borrower, candidateIntent)});

      if (serializedPreparation) {
        // Backend checks and run byte admission contend on this single existing host row.
        // Its receipt retains the acquired bytes; execution still requires binding.
        const current = await this.get(requestId);
        if (!current || current.fleetCandidatePreparation || current.fleetInputSha256 !== fleetInputSha256 || current.state !== 'awaiting-runner' ||
          current.fleetCancellation || current.fleetBinding || current.hostId || current.fleetDeadline <= now ||
          requestInputDigest(current.fleetSelection) !== row.fleetSelectionSha256 || routineJobInputDigest(current) !== fleetInputSha256) return null;
        if (!own || !current.fleetResourceReservation) {
          if (current.fleetResourceReservation || current.fleetExclusiveReservation) {
            const admission = current.fleetResourceAdmission;
            if (!admission || admission.intent.hostId !== hostId || admission.intent.laneId !== laneId ||
              admission.intent.controller.incarnation !== hostRow.incarnation || admission.intent.controller.generation !== hostRow.incarnationGeneration) {
              onWaiting?.(RESOURCE_ADMISSION_WAIT, true); return null;
            }
          }
          const claimedAt = Date.now();
          if (current.fleetDeadline.getTime() <= claimedAt || !routineResourcesAvailable({hostId: host.hostId, incarnation: host.incarnation,
            incarnationGeneration: host.incarnationGeneration, sequence: host.sequence, receivedAt: hostRow.receivedAt, snapshot: host,
            laneControls: hostRow.laneControls, resourceReservations: hostRow.resourceReservations, resourceLifecycleCursor: hostRow.resourceLifecycleCursor},
            current, laneId, claimedAt)) {onWaiting?.(RESOURCE_ADMISSION_WAIT); return null;}
          const saved = await resourceReservationRepository.claimFleet!(current, borrower,
            [...exclusiveClaims, ...(own ? retained : [...retained, claim])], candidateAdmission,
            {fleetResourceReservation: claim}, new Date(claimedAt));
          if (!saved) continue;
          row = saved;
        }
        // A reply loss/restart must reconcile this original; routing cannot try another lane.
        onWaiting?.(RESOURCE_ADMISSION_WAIT, true);
      }
      // The existing authority may have committed before its request receipt write failed. Always
      // reconcile that winner; current offers alone cannot establish the absence of an old claim.
      const admissionAt = Date.now();
      if (!row.fleetResourceAdmission && (row.fleetDeadline.getTime() <= admissionAt || !routineResourcesAvailable({hostId: host.hostId,
        incarnation: host.incarnation, incarnationGeneration: host.incarnationGeneration, sequence: host.sequence, receivedAt: hostRow.receivedAt,
        snapshot: host, laneControls: hostRow.laneControls, resourceReservations: hostRow.resourceReservations,
        resourceLifecycleCursor: hostRow.resourceLifecycleCursor}, row, laneId, admissionAt))) {
        onWaiting?.(RESOURCE_ADMISSION_WAIT, Boolean(own || serializedPreparation)); return null;
      }
      const exclusive = await exclusiveResources.reserveFleet(requestId, fleetInputSha256, hostId, laneId,
        (blocked, dependencies) => onWaiting?.(dependencyWaitingReason(dependencies, blocked.resourceId), Boolean(own || serializedPreparation)));
      if (exclusive === null) return null;
      row = await TestRequestModel.collection.findOne({requestId, fleetInputSha256, state: 'awaiting-runner',
        fleetBinding: {$exists: false}, fleetCancellation: {$exists: false}, fleetDeadline: {$gt: now}},
        {readPreference: 'primary', readConcern: {level: 'majority'}, timeoutMS: 10_000}) as unknown as StoredRoutineJob | null;
      // A replacement decision belongs to the validated request snapshot. A concurrent
      // acquisition must not become the CAS expectation for this older candidate.
      if (replacingQuota && (!isDeepIdentity(row?.fleetResourceReservation, quota) ||
        !isDeepIdentity(row?.fleetExclusiveReservation, exclusive || undefined) ||
        !exclusive && !isDeepIdentity(row?.fleetResourceAdmission, quotaAdmission))) return null;
      const admission = fleetResourceAdmissionSchema.safeParse(exclusive || serializedPreparation || row?.fleetResourceReservation && !replacingQuota
        ? row?.fleetResourceAdmission : candidateAdmission);
      if (!row?.fleetPreparation || !admission.success || admission.data.intent.hostId !== hostId || admission.data.intent.laneId !== laneId ||
        admission.data.intent.inputSha256 !== fleetInputSha256 || Boolean(exclusive) !== Boolean(admission.data.dependencies.length) ||
        exclusive && !isDeepIdentity(row.fleetExclusiveReservation, exclusive)) return null;
      if (!selected && (admission.data.intent.controller.incarnation !== hostRow.incarnation ||
        admission.data.intent.controller.generation !== hostRow.incarnationGeneration)) {
        onWaiting?.(RESOURCE_ADMISSION_WAIT, true); return null;
      }
      // This existing host resource record is the sole byte-claim authority. Snapshot and claim CAS fences race both reports and other lanes.
      if (serializedPreparation) {
        const originals = await resourceReservationRepository.recorderClaims!(requestId), currentHost = await resourceReservationRepository.get(hostId),
          currentLane = currentHost?.snapshot.lanes.find(value => value.id === laneId), checkedAt = Date.now();
        if (row.fleetDeadline.getTime() <= checkedAt || !backendRecorderClaimMatches(originals, requestId, fleetInputSha256, hostId, laneId) || originals[0]!.id !== claim.id ||
          !currentHost || !currentLane || !hostResourceReservationsSchema.parse(currentHost.resourceReservations ?? [])
            .some(value => requestInputDigest(value) === requestInputDigest(claim)) || currentHost.incarnation !== hostRow.incarnation ||
          currentHost.incarnationGeneration !== hostRow.incarnationGeneration ||
          !routineResourcesAvailable(currentHost, row, laneId, checkedAt) ||
          !compatibleStructuralRoutineLane({...requirements, resources: requirements.resources.map(({storage: _, ...resource}) => resource)},
            currentLane, routineLaneContext(currentHost.snapshot, row.fleetSelection.build, checkedAt), checkedAt)) return null;
      } else {
        const claimedAt = Date.now();
        if (row.fleetDeadline.getTime() <= claimedAt || !routineResourcesAvailable({hostId: host.hostId, incarnation: host.incarnation,
          incarnationGeneration: host.incarnationGeneration, sequence: host.sequence, receivedAt: hostRow.receivedAt, snapshot: host,
          laneControls: hostRow.laneControls, resourceReservations: hostRow.resourceReservations, resourceLifecycleCursor: hostRow.resourceLifecycleCursor},
          row, laneId, claimedAt)) {onWaiting?.(RESOURCE_ADMISSION_WAIT, Boolean(own || selected)); return null;}
        const savedHost = await resourceReservationRepository.claimFleet!(row, borrower,
          [...exclusiveClaims, ...(own ? retained : [...retained, claim])], admission.data,
          {fleetResourceReservation: claim, ...(exclusive ? {fleetExclusiveReservation: exclusive} : {})}, new Date(claimedAt));
        if (!savedHost) continue;
        row = savedHost;
      }
      const receiptAt = new Date(Date.now());
      if (row.fleetDeadline <= receiptAt || !routineResourcesAvailable({hostId: host.hostId, incarnation: host.incarnation,
        incarnationGeneration: host.incarnationGeneration, sequence: host.sequence, receivedAt: hostRow.receivedAt, snapshot: host,
        laneControls: hostRow.laneControls, resourceReservations: hostRow.resourceReservations, resourceLifecycleCursor: hostRow.resourceLifecycleCursor},
        row, laneId, receiptAt.getTime())) {onWaiting?.(RESOURCE_ADMISSION_WAIT, true); return null;}
      if (selected) return row;
      const winner = row, returnedAt = Date.now();
      // A slow successful receipt write is already custody. Refuse later execution
      // after expiry without deleting its original target or permitting relocation.
      if (!winner || winner.state !== 'awaiting-runner' || winner.fleetCancellation || winner.fleetBinding || winner.hostId ||
        winner.fleetResourceReservation?.id !== claim.id || winner.fleetDeadline.getTime() <= returnedAt ||
        !routineResourcesAvailable({hostId: host.hostId, incarnation: host.incarnation, incarnationGeneration: host.incarnationGeneration,
          sequence: host.sequence, receivedAt: hostRow.receivedAt, snapshot: host, laneControls: hostRow.laneControls,
          resourceReservations: hostRow.resourceReservations, resourceLifecycleCursor: hostRow.resourceLifecycleCursor}, winner, laneId, returnedAt)) return null;
      return winner;
    }
    return null;
  },
  async bind(requestId, fleetInputSha256, fleetBinding, dispatchIntent, now) {
    const row = await TestRequestModel.collection.findOne({requestId, fleetInputSha256},
      {readPreference: 'primary', readConcern: {level: 'majority'}, timeoutMS: 10_000}) as unknown as StoredRoutineJob | null,
      admission = fleetResourceAdmissionSchema.safeParse(row?.fleetResourceAdmission);
    if (!row || row.fleetCandidatePreparation || !admission.success || admission.data.intent.inputSha256 !== fleetInputSha256 ||
      admission.data.intent.hostId !== fleetBinding.hostId || admission.data.intent.laneId !== fleetBinding.laneId ||
      Boolean(row.fleetExclusiveReservation) !== Boolean(admission.data.dependencies.length)) return null;
    const host = await resourceReservationRepository.get(fleetBinding.hostId),
      lane = host?.snapshot.lanes.find(value => value.id === fleetBinding.laneId);
    if (!host || !lane || !freshRoutineHost(host.receivedAt, now.getTime()) || lane.activity || lane.dispatchMode !== 'automatic' ||
      !routineResourcesAvailable(host, row, fleetBinding.laneId, now.getTime())) return null;
    if (requiresBackendConnectivity(row) || lane && requiresSerializedAndroidPreparation(lane)) {
      const originals = await resourceReservationRepository.recorderClaims!(requestId);
      if (!backendRecorderClaimMatches(originals, requestId, fleetInputSha256, fleetBinding.hostId, fleetBinding.laneId) ||
        originals[0]!.id !== row.fleetResourceReservation?.id || !host || !lane || host.receivedAt > now ||
        now.getTime() - host.receivedAt.getTime() > 120_000 || !hostResourceReservationsSchema.parse(host.resourceReservations ?? [])
          .some(value => requestInputDigest(value) === requestInputDigest(originals[0])) ||
        !compatibleStructuralRoutineLane({...row.fleetPreparation!.requirements,
          resources: row.fleetPreparation!.requirements.resources.map(({storage: _, ...resource}) => resource)}, lane,
          routineLaneContext(host.snapshot, row.fleetSelection.build, now.getTime()), now.getTime())) return null;
    }
    const originals = await resourceReservationRepository.recorderClaims!(requestId),
      claims = hostResourceReservationsSchema.parse(host.resourceReservations ?? []),
      current = await TestRequestModel.collection.findOne({requestId, fleetInputSha256},
        {readPreference: 'primary', readConcern: {level: 'majority'}, timeoutMS: 10_000}) as unknown as StoredRoutineJob | null,
      acceptedAt = new Date(Date.now());
    if (!current || current.state !== 'awaiting-runner' || current.fleetCancellation || current.fleetBinding || current.hostId ||
      current.fleetDeadline <= acceptedAt || !backendRecorderClaimMatches(originals, requestId, fleetInputSha256, fleetBinding.hostId, fleetBinding.laneId) ||
      originals[0]!.id !== row.fleetResourceReservation?.id || !claims.some(claim => requestInputDigest(claim) === requestInputDigest(originals[0])) ||
      requestInputDigest(current.fleetResourceReservation) !== requestInputDigest(row.fleetResourceReservation) ||
      requestInputDigest(current.fleetResourceAdmission) !== requestInputDigest(admission.data) ||
      !routineResourcesAvailable(host, current, fleetBinding.laneId, acceptedAt.getTime())) return null;
    // This unchanged-claims CAS is the admission boundary, contending with reports
    // and operator controls. A later withdrawal is a new event, never a relocation
    // of this original. Any failed/lost request write retains the same custody.
    if (!await resourceReservationRepository.replace(host, claims)) return null;
    const boundAt = new Date(Date.now());
    if (!routineResourcesAvailable(host, current, fleetBinding.laneId, boundAt.getTime())) return null;
    return await TestRequestModel.collection.findOneAndUpdate({requestId, fleetInputSha256, state: 'awaiting-runner',
      fleetCandidatePreparation: {$exists: false},
      fleetResourceReservation: row.fleetResourceReservation,
      fleetResourceAdmission: admission.data, ...(row.fleetExclusiveReservation ? {fleetExclusiveReservation: row.fleetExclusiveReservation} : {fleetExclusiveReservation: {$exists: false}}),
      fleetBinding: {$exists: false}, hostId: {$exists: false}, 'fleetResourceReservation.hostId': fleetBinding.hostId, 'fleetResourceReservation.laneId': fleetBinding.laneId, fleetCancellation: {$exists: false}, fleetDeadline: {$gt: boundAt}},
      {$set: {hostId: fleetBinding.hostId, fleetBinding, dispatchIntent, dispatchIntentSha256: requestInputDigest(dispatchIntent),
        state: 'preparing', updatedAt: boundAt}}, {returnDocument: 'after', writeConcern: testWriteConcern}) as unknown as StoredRoutineJob | null;
  },
  async pending(limit, now) {
    return await TestRequestModel.find({fleetSelection: {$exists: true},
      $or:[{fleetCancellation:{$exists:true},'fleetActionsCancellation.settled':{$ne:true},$or:[{'fleetActionsCancellation.checkedAt':{$exists:false}},{'fleetActionsCancellation.checkedAt':{$lte:new Date(now.getTime()-30_000).toISOString()}}]},
        {fleetCancellation:{$exists:false},$or: [{fleetDeadline: {$lte: now}, $or: [{state: {$ne: 'terminal'}}, {fleetBinding: {$exists: true}, dispatchCompletion: {$exists: false}, hostRejection: {$exists: false},
          preparationCancellation: {$exists: false}, preparationRejection: {$exists: false}}]},
        {state: {$ne: 'terminal'}, fleetBinding: {$exists: false},
          $or: [{fleetDispatch: {$exists: false}}, {'fleetDispatch.lastAttemptAt': {$lte: new Date(now.getTime() - 30_000).toISOString()},
            $or:[{'fleetDispatch.checkedAt':{$exists:false}},{'fleetDispatch.checkedAt':{$lte:new Date(now.getTime()-30_000).toISOString()}}]}]}]}]})
      .sort({createdAt: 1, requestId: 1}).limit(limit).read('primary').readConcern('majority').lean() as unknown as StoredRoutineJob[];
  },
  async *qualificationCandidates(hostId, laneId, limit, now, timeoutMS, includeQueued, includeAccepted = false, includePreparing = false, platform = 'ios-on-mac', graphOnly = false) {
    const unbound = {state: 'awaiting-runner', hostId: {$exists: false}, fleetBinding: {$exists: false}, hostReceipt: {$exists: false}};
    const queued = {state: 'queued', hostId, 'fleetBinding.hostId': hostId, 'fleetBinding.laneId': laneId,
      'input.laneId': laneId, inputSha256: {$exists: true}, hostReceipt: {$exists: false}};
    const preparing = {state: 'preparing', hostId, 'fleetBinding.hostId': hostId, 'fleetBinding.laneId': laneId,
      input: {$exists: false}, inputSha256: {$exists: false}, hostReceipt: {$exists: false},
      dispatchIntentSha256: {$exists: true}, fleetResourceReservation: {$exists: true}, fleetResourceAdmission: {$exists: true}};
    const accepted = {state: 'accepted', hostId, 'fleetBinding.hostId': hostId, 'fleetBinding.laneId': laneId,
      'input.laneId': laneId, inputSha256: {$exists: true}, 'hostReceipt.hostId': hostId};
    // New preparing-capable workers scan existing custody first. Separate ordinary
    // queries avoid lexical state ordering or database-specific computed sort keys.
    // Older workers retain their original single-query discovery behavior.
    const prioritized = includeQueued && includePreparing;
    const streams = graphOnly ? [{...unbound, 'fleetCandidatePreparation.hostId': hostId, 'fleetCandidatePreparation.laneId': laneId,
      'fleetCandidatePreparation.target.purpose.kind': 'resource-readiness'}] : platform === 'android' && includePreparing ? [{state: 'awaiting-runner', 'fleetCandidatePreparation.hostId': hostId, 'fleetCandidatePreparation.laneId': laneId}, preparing] : prioritized ? [...includeAccepted ? [accepted] : [], preparing, queued, unbound] :
      [includeQueued ? {$or: [unbound, queued, ...includeAccepted ? [accepted] : []]} : unbound];
    const deadline = performance.now() + timeoutMS;
    let remaining = limit;
    for (const stream of streams) {
      const budget = prioritized ? Math.min(timeoutMS, Math.ceil(deadline - performance.now())) : timeoutMS;
      if (remaining <= 0 || budget <= 0) break;
      const cursor = TestRequestModel.find({...stream,
        runId: {$exists: false}, dispatchCompletion: {$exists: false},
        hostCancellation: {$exists: false}, hostRejection: {$exists: false},
        preparationCancellation: {$exists: false}, preparationRejection: {$exists: false},
        fleetCancellation: {$exists: false}, fleetDeadline: {$gt: now}, 'fleetSelection.platform': platform,
        fleetPreparation: {$exists: true}, ...(!graphOnly ? {'fleetPreparation.requirements.resources': {$elemMatch: platform === 'android'
          ? {kind: 'phone', capabilities: 'backend-connectivity'} : {permissions: {$elemMatch: {recipient: 'app'}}}}} : {}),
        $and: [{$or: [{'fleetTarget.hostId': {$exists: false}}, {'fleetTarget.hostId': hostId}]},
          {$or: [{'fleetTarget.laneId': {$exists: false}}, {'fleetTarget.laneId': laneId}]},
          {$or: [{fleetResourceAdmission: {$exists: false}},
            {'fleetResourceAdmission.intent.hostId': hostId, 'fleetResourceAdmission.intent.laneId': laneId}]}]})
        .sort(prioritized ? stream === accepted ? {'hostReceipt.acceptedAt': -1, createdAt: 1, requestId: 1} : {createdAt: 1, requestId: 1} :
          includeAccepted ? {'hostReceipt.acceptedAt': -1, state: -1, createdAt: 1, requestId: 1} :
          includeQueued ? {state: -1, createdAt: 1, requestId: 1} : {createdAt: 1, requestId: 1})
        .limit(remaining).read('primary').readConcern('majority')
        .setOptions({timeoutMS: budget, maxTimeMS: budget}).lean().cursor({batchSize: 20});
      try {for await (const row of cursor) {
        if ((prioritized && performance.now() >= deadline) || remaining <= 0) break;
        remaining--; yield row as unknown as StoredRoutineJob;
      }} finally {await cursor.close();}
    }
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
    return await TestRequestModel.findOneAndUpdate({requestId, $or:[{fleetInputSha256:inputSha256},{fleetSelectionSha256:inputSha256}], 'fleetActions.actionsRunId': {$ne: value.actionsRunId}}, {$push: {fleetActions: value}},
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


function candidateClaimConflict(row: StoredRoutineJob, claim: import('../types/resource-reservations.types').HostResourceReservation, hostId: string, laneId: string) {
  if (isExclusiveHostReservation(claim)) return claim.borrowerHostId === hostId && claim.laneId === laneId &&
    !row.fleetExclusiveReservation?.claims.some(original => requestInputDigest(original) === requestInputDigest(claim));
  return claim.hostId === hostId && claim.laneId === laneId && requestInputDigest(claim) !== requestInputDigest(row.fleetResourceReservation ?? null);
}
/** The request fence remains until every exact never-executed provisional claim has returned on its original authority. */
async function releaseCandidateProvisional(original: StoredRoutineJob, now: Date): Promise<StoredRoutineJob | null> {
  const pending = original.fleetCandidatePreparation, returning = pending?.provisionalReturn;
  if (!pending || !returning || returning.releasedAt) return original;
  const recorder = returning.recorder, admission = returning.admission, exclusive = returning.exclusive;
  if (recorder.requestId !== original.requestId || recorder.fleetInputSha256 !== original.fleetInputSha256 ||
    recorder.hostId !== pending.hostId || recorder.laneId !== pending.laneId ||
    admission && (!fleetResourceAdmissionSchema.safeParse(admission).success || admission.intent.owner.kind !== 'run' ||
      admission.intent.owner.id !== original.requestId || admission.intent.hostId !== pending.hostId || admission.intent.laneId !== pending.laneId ||
      admission.intent.inputSha256 !== original.fleetInputSha256) ||
    exclusive && (!admission || requestInputDigest(exclusive.intent) !== requestInputDigest(admission.intent) ||
      exclusive.origin.fleetInputSha256 !== original.fleetInputSha256 || exclusive.claims.length !== admission.dependencies.length ||
      exclusive.intentSha256 !== requestInputDigest({...admission.intent, controller: {incarnation: admission.intent.controller.incarnation,
        generation: admission.intent.controller.generation}, origin: exclusive.origin, dependencies: admission.dependencies}) ||
      exclusive.claims.some(claim => claim.owner.kind !== 'run' || claim.owner.id !== original.requestId || claim.borrowerHostId !== pending.hostId ||
        claim.laneId !== pending.laneId || claim.inputSha256 !== original.fleetInputSha256 || claim.intentSha256 !== exclusive.intentSha256 ||
        claim.operationId !== admission.intent.operationId || claim.controllerIncarnation !== admission.intent.controller.incarnation ||
        claim.controllerGeneration !== admission.intent.controller.generation || claim.borrowerSequence !== admission.intent.controller.sequence ||
        !admission.dependencies.some(dependency => dependency.resourceId === claim.resourceId && dependency.authorityHostId === claim.authorityHostId)))) return null;
  const claims = [returning.recorder, ...(returning.exclusive?.claims ?? [])], byHost = new Map<string, typeof claims>();
  for (const claim of claims) {
    const hostId = isExclusiveHostReservation(claim) ? claim.authorityHostId : claim.hostId;
    byHost.set(hostId, [...byHost.get(hostId) ?? [], claim]);
  }
  const currentRequest = async () => {
    const current = await routineJobRepository.get(original.requestId), prior = current?.fleetCandidatePreparations?.at(-1);
    return current && requestInputDigest(current.fleetCandidatePreparation) === requestInputDigest(pending) &&
      current.fleetInputSha256 === original.fleetInputSha256 && routineJobInputDigest(current) === original.fleetInputSha256 &&
      current.fleetSelectionSha256 === requestInputDigest(current.fleetSelection) && !current.fleetBinding && !current.hostId &&
      !current.dispatchIntent && !current.inputSha256 && !current.hostReceipt && !current.runId && !current.dispatchCompletion &&
      !current.fleetExclusiveExecutionBinding && Boolean(prior) && prior!.candidate.attemptId === pending.candidate.previousAttemptId &&
      prior!.settlement?.outcome === 'qualified' && (prior!.target.purpose?.kind === 'resource-readiness'
        ? pending.target.purpose?.kind === 'resource-readiness' && graphCandidateHistoricalSettlement(prior!)
        : prior!.claimReceipt && prior!.returnReceipt && candidateReturnMatches(prior!, prior!.returnReceipt)) &&
      prior!.hostId === pending.hostId && prior!.laneId === pending.laneId &&
      prior!.candidate.fleetInputSha256 === current.fleetInputSha256 && prior!.candidate.selectionSha256 === current.fleetSelectionSha256 &&
      (!admission || admission.intent.controller.incarnation === prior!.candidate.controller.incarnation &&
        admission.intent.controller.generation === prior!.candidate.controller.generation) &&
      requestInputDigest(current.fleetResourceReservation) === requestInputDigest(returning.recorder) &&
      requestInputDigest(current.fleetResourceAdmission ?? null) === requestInputDigest(returning.admission ?? null) &&
      requestInputDigest(current.fleetExclusiveReservation ?? null) === requestInputDigest(returning.exclusive ?? null) ? current : null;
  };
  const witness = (host: Awaited<ReturnType<typeof resourceReservationRepository.get>>) => {
    if (!host || !Number.isFinite(host.receivedAt.getTime()) || !Number.isFinite(Date.parse(host.snapshot.observedAt)) ||
      host.receivedAt > now || now.getTime() - host.receivedAt.getTime() > 120_000 ||
      Date.parse(host.snapshot.observedAt) > now.getTime() || now.getTime() - Date.parse(host.snapshot.observedAt) > 120_000 ||
      host.snapshot.resourceReservations?.claims.some(claim => claim.owner.id === original.requestId)) return false;
    if (host.hostId !== pending.hostId) return claims.filter(isExclusiveHostReservation).filter(claim => claim.authorityHostId === host.hostId).every(claim => {
      const subject = host.snapshot.resourceLifecycle?.subjects.find(subject => subject.subject.id === claim.resourceId),
        memberships = host.snapshot.lanes.filter(lane => lane.resources.some(resource => resource.id === claim.resourceId));
      return subject?.current && subject.subject.authorityHostId === host.hostId && subject.owner === null &&
        subject.observedAt && Date.parse(subject.observedAt) >= Date.parse(pending.candidate.requestedAt) &&
        Date.parse(subject.observedAt) <= now.getTime() && now.getTime() - Date.parse(subject.observedAt) <= 120_000 &&
        memberships.length > 0 && memberships.every(lane => lane.state === 'idle' && !lane.activity);
    });
    const lane = host.snapshot.lanes.find(lane => lane.id === pending.laneId), offer = lane?.resources.find(resource => resource.kind === 'recorder')?.storage,
      checkedIds = pending.target.purpose!.kind === 'resource-readiness' ? pending.target.purpose!.resources.map(member => member.id) :
        [pending.target.purpose!.resourceId],
      checkedReturned = checkedIds.every(id => {
        const subject = host.snapshot.resourceLifecycle?.subjects.find(subject => subject.subject.id === id)
        return subject?.current && subject.owner === null && subject.subject.authorityHostId === host.hostId
      });
    return host.incarnation === pending.candidate.controller.incarnation && host.incarnationGeneration === pending.candidate.controller.generation &&
      requestInputDigest(host.snapshot.frameworkBinding) === requestInputDigest(pending.target.acceptedBinding) && lane?.state === 'idle' && !lane.activity &&
      checkedReturned && offer && offer.poolId === returning.recorder.poolId &&
      Date.parse(offer.observedAt) >= Date.parse(pending.candidate.requestedAt) && Date.parse(offer.observedAt) <= now.getTime() &&
      now.getTime() - Date.parse(offer.observedAt) <= 120_000 && !offer.reservations.some(value => value.requestId === original.requestId);
  };
  for (const [hostId, expected] of byHost) {
    let absent = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = await currentRequest(), host = await resourceReservationRepository.get(hostId);
      if (!current || !witness(host) || !host) return null;
      const all = hostResourceReservationsSchema.parse(host.resourceReservations ?? []), actual = all.filter(claim => isExclusiveHostReservation(claim)
        ? claim.owner.kind === 'run' && claim.owner.id === original.requestId : claim.requestId === original.requestId);
      if (actual.some(claim => !expected.some(value => requestInputDigest(value) === requestInputDigest(claim)))) return null;
      // A later Check cannot block acknowledgment of an already returned original.
      // Live original claims still require the ordinary lane conflict guard.
      if (!actual.length) {absent = true; break;}
      if (host.hostId === pending.hostId && all.some(claim => candidateClaimConflict(original, claim, pending.hostId, pending.laneId))) return null;
      if (!await currentRequest()) return null;
      // A lost reply never clears the pending receipt; the next pass reads these same original claim identities.
      if (await resourceReservationRepository.replace(host, all.filter(claim => !actual.includes(claim)))) {
        const readback = await resourceReservationRepository.get(hostId);
        if (!witness(readback) || !readback || hostResourceReservationsSchema.parse(readback.resourceReservations ?? []).some(claim =>
          expected.some(value => requestInputDigest(value) === requestInputDigest(claim)))) return null;
        absent = true; break;
      }
    }
    if (!absent) return null;
  }
  const current = await currentRequest(); if (!current) return null;
  return await TestRequestModel.collection.findOneAndUpdate({requestId: current.requestId, fleetInputSha256: current.fleetInputSha256,
    fleetCandidatePreparation: pending, fleetResourceReservation: returning.recorder, fleetResourceAdmission: returning.admission ?? {$exists: false},
    fleetExclusiveReservation: returning.exclusive ?? {$exists: false}, fleetBinding: {$exists: false}, hostId: {$exists: false}, fleetCandidatePreparations: current.fleetCandidatePreparations,
    fleetSelectionSha256: current.fleetSelectionSha256, fleetDeadline: current.fleetDeadline,
    inputSha256: {$exists: false}, dispatchIntent: {$exists: false}, hostReceipt: {$exists: false}, runId: {$exists: false},
    fleetExclusiveExecutionBinding: {$exists: false}, dispatchCompletion: {$exists: false}, fleetCancellation: current.fleetCancellation ?? {$exists: false}},
    {$unset: {fleetResourceReservation: '', fleetResourceAdmission: '', fleetExclusiveReservation: ''},
      $set: {fleetCandidatePreparation: {...pending, provisionalReturn: {...returning, releasedAt: now.toISOString()}}}},
    {returnDocument: 'after', writeConcern: testWriteConcern, timeoutMS: 5000}) as unknown as StoredRoutineJob | null;
}

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
/** Structural preparation cannot authorize an app or device executor. */
export function compatibleStructuralRoutineLane(requirements: PortableRequirements, lane: RoutingTestHostState['lanes'][number],
  context?: Parameters<typeof compatibleRoutineLane>[2], now = context?.now ?? Date.now()) {
  return compatibleRoutineLane(requirements, lane, context, now);
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
    resources: lane.resources.map(({permissionObservations: _, backendConnectivity: _backend, storage: _storage, ...resource}) => ({...resource, capabilities: [...resource.capabilities ?? []].sort()})).sort((a, b) => a.id.localeCompare(b.id)),
    glasses: (lane.glasses ?? []).map(glasses => ({...glasses, capabilities: [...glasses.capabilities].sort()})).sort((a, b) => a.resourceId.localeCompare(b.resourceId))});
}
export function compatibleRoutineLane(requirements: PortableRequirements, lane: RoutingTestHostState['lanes'][number],
  context?: RoutineLaneEligibilityContext, now = context?.now ?? Date.now(), backendHealth = true) {
  return routineLaneRequirementBlocker(requirements, lane, context, now, false) === undefined;
}
export function routineLaneContext(host: Pick<RoutingTestHostState, 'hostId' | 'incarnation' | 'incarnationGeneration' | 'frameworkBinding' | 'resourceLifecycle'>,
  build: {headSha: string; archive?: {sha256: string}; receipt?: {sha256: string}}, now: number) {
  const context = permissionContext(host.frameworkBinding, build, now);
  return context && {...context, ...(host.incarnation && host.incarnationGeneration ? {backend: {
    hostId: host.hostId, incarnation: host.incarnation, generation: host.incarnationGeneration,
    resourceGenerations: host.resourceLifecycle?.subjects.map(subject => ({resourceId: subject.subject.id,
      generation: subject.generation, current: subject.current && subject.subject.authorityHostId === host.hostId,
      unowned: subject.owner === null})) ?? [],
  }} : {})};
}
const BACKEND_PREPARATION_WAIT = 'The phone’s internet connection check failed. Waiting for a new check.';

/** Selection preference only; the existing resource admission CAS remains the authority.
 * Per-request ties spread simultaneous zero-load snapshots without relying on Mongo row order.
 * Authority claims remain load until ordinary cleanup/reconciliation removes them.
 */
export function orderedRoutineCandidates(requestId: string, hosts: RoutingTestHostState[], selected: SelectedRoutineLane[] = []) {
  // Exclusive authority can live on a different host from its borrower. Keep
  // that retained custody as borrower lane load even after cancellation.
  const retained = hosts.flatMap(host => (host.authorityReservations ?? []).map(claim => isExclusiveHostReservation(claim)
    ? {hostId: claim.borrowerHostId, laneId: claim.laneId,
      requestId: claim.owner.kind === 'run' ? claim.owner.id : undefined, ownerKey: JSON.stringify([claim.owner.kind, claim.owner.id])}
    : {...claim, ownerKey: JSON.stringify(['run', claim.requestId])}));
  const pending = selected.map(claim => ({...claim, ownerKey: JSON.stringify(['run', claim.requestId])}));
  const ownersByLane = new Map<string, Set<string>>();
  for (const claim of [...retained, ...pending]) {
    if (claim.requestId === requestId) continue;
    const key = JSON.stringify([claim.hostId, claim.laneId]);
    let owners = ownersByLane.get(key);
    if (!owners) ownersByLane.set(key, owners = new Set());
    owners.add(claim.ownerKey);
  }
  return hosts.flatMap(host => host.lanes.map(lane => ({host, lane,
    load: ownersByLane.get(JSON.stringify([host.hostId, lane.id]))?.size ?? 0,
    tie: requestInputDigest({requestId, hostId: host.hostId, laneId: lane.id}),
  }))).sort((a, b) => a.load - b.load || a.tie.localeCompare(b.tie));
}

/** Kept identical to Harness contracts/dispatch.ts: opaque identities use canonical JSON hashes. */
export function routineRequirementLabels(requirements: PortableRequirements, model?: string, target?: StoredRoutineJob['fleetTarget']): string[] {
  const token = (value: string) => requestInputDigest(value).slice(0, 24);
  if (requirements.glasses && (!model || !requirements.glasses.models.includes(model)))
    throw new TestRequestConflict('Queue labels require one acceptable glasses model');
  return [...new Set([`mentra-platform-${requirements.platform}`,
    ...requirements.resources.flatMap(resource => [`mentra-resource-${resource.kind}`,
      ...resource.capabilities.map(capability => `mentra-cap-${token(`${resource.kind}:${capability}`)}`),
      ...resource.permissions?.filter(value => value.recipient !== 'app').map(value => `mentra-permission-${token(`${resource.kind}:${value.recipient}:${value.permission}`)}`) ?? []]),
    ...(model ? [`mentra-glasses-${token(model)}`, ...requirements.glasses!.capabilities.map(capability => `mentra-glasses-cap-${token(`${model}:${capability}`)}`)] : []),
    ...(target?.hostId ? [`mentra-host-${token(target.hostId)}`] : []),
    ...(target?.laneId ? [`mentra-lane-${token(`${target.hostId}:${target.laneId}`)}`] : [])])].sort();
}
/** Queue model choice follows current accepting lanes; the portable alternatives stay immutable. */
export function routineJobRouting(requirements: PortableRequirements, hosts: RoutingTestHostState[], now: number, target?: StoredRoutineJob['fleetTarget'],
  build?: {headSha: string; archive?: {sha256: string}; receipt?: {sha256: string}}, structuralPreparation = false,
  original?: {requestId: string; inputSha256: string}) {
  const matches = structuralPreparation ? compatibleStructuralRoutineLane : compatibleRoutineLane;
  const compatible = hosts.filter(host => Number.isFinite(Date.parse(host.receivedAt)) && Date.parse(host.receivedAt) <= now && now - Date.parse(host.receivedAt) <= 120_000 &&
    (!target?.hostId || target.hostId === host.hostId)).flatMap(host => host.lanes.filter(lane =>
      (!target?.laneId || target.laneId === lane.id) && lane.dispatchMode === 'automatic' && lane.state !== 'offline' &&
      selectableRoutineResources(host, requirements, lane, now, structuralPreparation, original) && matches(requirements, lane, build ? routineLaneContext(host, build, now) : undefined, now)));
  const accepting = compatible.filter(lane => original ? !['running', 'reserved'].includes(lane.state) && !('activity' in lane && lane.activity) : lane.state === 'idle');
  const chosenModel = requirements.glasses ? [...new Set(accepting.flatMap(lane => (lane.glasses ?? []).filter(glasses =>
    requirements.glasses!.models.includes(glasses.model) && requirements.glasses!.capabilities.every(value => glasses.capabilities.includes(value))).map(glasses => glasses.model)))].sort()[0]
    ?? [...requirements.glasses.models].sort()[0] : undefined;
  return {routingLabels: routineRequirementLabels(requirements, chosenModel, target), ...(chosenModel ? {chosenModel} : {}),
    ...(!accepting.length ? {waitingReason: compatible.length ? 'Awaiting an idle compatible enrolled runner' : 'Awaiting a compatible enrolled runner'} : {})};
}
function freshRoutineHost(receivedAt: string | Date, now: number) {
  const received = receivedAt instanceof Date ? receivedAt.getTime() : Date.parse(receivedAt)
  return Number.isFinite(received) && received <= now && now - received <= 120_000
}
/** Host-only source preparation may use an unknown app/phone baseline. Ordinary
 * reservation requires app idle and the phone's exact returned positive. */
function selectableRoutineResources(host: RoutingTestHostState, requirements: PortableRequirements,
  lane: RoutingTestHostState['lanes'][number], now: number, candidateCheck: boolean,
  original?: {requestId: string; inputSha256: string}) {
  if (resourceLaneBlocker(host, lane.id, original && {...original, hostId: host.hostId})) return false
  return requiredResourceBlocker({hostId: host.hostId, receivedAt: host.receivedAt, snapshot: host,
    resourceControlRecords: host.resourceControlRecords, resourceLifecycleCursor: host.resourceLifecycleCursor,
    authorityReservations: host.authorityReservations}, lane, requirements.resources, now, () => false, original) === undefined
}
/** Resolve declared physical resources and their exact native dependency closure.
 * Logical network capabilities remain in ordinary structural eligibility. */
export function routineResourceReadinessPurpose(host: RoutingTestHostState, lane: RoutingTestHostState['lanes'][number],
  requirements: PortableRequirements, now: number, original?: {requestId: string; inputSha256: string}): ResourceReadinessPurpose | undefined {
  const all = [...host.resources ?? [], ...host.lanes.flatMap(value => value.resources)],
    refs = new Map<string, typeof all[number]>(), selected = new Map<string, ResourceReadinessPurpose['resources'][number]>(), visiting = new Set<string>()
  for (const ref of all) {
    const prior = refs.get(ref.id)
    if (prior && (prior.kind !== ref.kind || requestInputDigest(prior.idleContract ?? null) !== requestInputDigest(ref.idleContract ?? null) ||
      requestInputDigest(prior.exclusiveDependencies ?? null) !== requestInputDigest(ref.exclusiveDependencies ?? null))) return undefined
    refs.set(ref.id, ref)
  }
  const visit = (id: string, requiredCapabilities?: string[]): boolean => {
    if (visiting.has(id)) return false
    const ref = refs.get(id), subject = host.resourceLifecycle?.subjects.find(value => value.subject.id === id), contract = ref?.idleContract
    if (!ref || !contract || contract.qualifiedScope.kind === 'unqualified' || !subject?.current ||
      subject.subject.authorityHostId !== host.hostId || subject.owner !== null || subject.repair.state !== 'none' ||
      !subject.supportedActions.includes('mark-out-of-service') || (requiredCapabilities ?? []).some(value => !ref.capabilities?.includes(value)) ||
      resourceCandidateBlocker({hostId: host.hostId, receivedAt: host.receivedAt, snapshot: host,
        resourceControlRecords: host.resourceControlRecords, resourceLifecycleCursor: host.resourceLifecycleCursor,
        authorityReservations: host.authorityReservations}, id, now, original && {...original, laneId: lane.id})) return false
    if (selected.has(id)) return true
    visiting.add(id)
    const capabilities = requiredCapabilities ?? ref.capabilities ?? [],
      dependencies = new Set([...contract.dependencies ?? [], ...subject.resource.dependencies])
    for (const dependency of (ref.exclusiveDependencies ?? []).filter(value => capabilities.includes(value.capability))) {
      if (dependency.authorityHostId !== host.hostId) return false
      dependencies.add(dependency.resourceId)
    }
    for (const dependency of dependencies) if (dependency !== id && !visit(dependency)) return false
    visiting.delete(id)
    const parsed = resourceReadinessMemberSchema.safeParse({id, kind: ref.kind,
      authorityHostId: host.hostId, subjectGeneration: subject.generation, contractVersion: contract.version,
      capabilities: [...capabilities]})
    if (!parsed.success) return false
    selected.set(id, parsed.data)
    return selected.size <= 30
  }
  for (const required of requirements.resources) {
    const matches = lane.resources.filter(value => value.kind === required.kind)
    if (matches.length !== 1) return undefined
    if (['network', 'workspace'].includes(required.kind)) {
      if (requiredResourceBlocker({hostId: host.hostId, receivedAt: host.receivedAt, snapshot: host,
        resourceControlRecords: host.resourceControlRecords, resourceLifecycleCursor: host.resourceLifecycleCursor,
        authorityReservations: host.authorityReservations}, lane, [required], now, () => false, original)) return undefined
      continue
    }
    if (!visit(matches[0]!.id, required.capabilities)) return undefined
  }
  const resources = [...selected.values()]
  return resources.length ? resourceReadinessPurposeSchema.parse({kind: 'resource-readiness', resourceId: resources[0]!.id, resources}) : undefined
}
export const routineJobInputDigest = (row: Pick<StoredRoutineJob, 'fleetSelection' | 'fleetPreparation' | 'fleetDeadline' | 'fleetTarget'>) =>
  requestInputDigest({selection: row.fleetSelection, prepared: row.fleetPreparation, deadline: row.fleetDeadline.toISOString(), target: row.fleetTarget ?? null});

// Canonical Harness main fda9fd5034e3255d9c7b6165fb86adc30963628e (#1034)
// publishes first-parent version 999 with original target/cancellation fencing.
const QUEUED_APP_QUALIFICATION_FRAMEWORK_VERSION = 999;
// Paired installed qualifier uses an exact accepted-original mode. Earlier
// workers retain their existing pre-admission targets and never parse this mode.
const ACCEPTED_APP_QUALIFICATION_API_VERSION = 51;
// Canonical Harness main d1761815f6eb32f668b8239dc63e1e61d5f62eed (#1102)
// is first-parent version 1070. Its delivery validates the original preparation
// alongside its target before worker observation; the routine API is unchanged.
const PREPARING_APP_QUALIFICATION_FRAMEWORK_VERSION = 1070;

/** A handoff may refresh evidence only for its original frozen executable identity. */
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
      (!resource.laneId || resource.laneId === lane.id) && lane.resources.some(offered => offered.id === resource.id && offered.kind === resource.kind &&
        requestInputDigest(offered.exclusiveDependencies ?? []) === requestInputDigest(resource.exclusiveDependencies ?? []))).length === 1);
}

/** Preparing has a frozen dispatch and resource selection, but no executable input yet. */
export function preparingQualificationReceipt(row: StoredRoutineJob, hostId: string, lane: RoutingTestHostState['lanes'][number]) {
  const binding = routineJobBindingSchema.safeParse(row.fleetBinding), intent = routineDispatchIntentSchema.safeParse(row.dispatchIntent),
    admission = fleetResourceAdmissionSchema.safeParse(row.fleetResourceAdmission), reservation = recorderHostReservationSchema.safeParse(row.fleetResourceReservation),
    prepared = row.fleetPreparation, recorder = lane.resources.find(resource => resource.kind === 'recorder'),
    required = prepared && recorderCapacityRequirements(prepared).resources.find(resource => resource.kind === 'recorder')?.storage;
  if (!prepared || !required || !recorder?.storage || row.state !== 'preparing' ||
    (row as StoredRoutineJob & {input?: unknown}).input !== undefined || row.inputSha256 !== undefined ||
    !binding.success || !intent.success || !admission.success || !reservation.success || row.hostId !== hostId ||
    binding.data.jobId !== row.requestId || binding.data.requestId !== row.requestId || binding.data.hostId !== hostId || binding.data.laneId !== lane.id ||
    binding.data.descriptorRevision !== routineLaneDescriptorRevision(lane) ||
    row.dispatchIntentSha256 !== requestInputDigest(intent.data) || requestInputDigest(intent.data) !==
      requestInputDigest({...row.fleetSelection, routineSource: prepared.routineSource, laneId: lane.id}) ||
    reservation.data.requestId !== row.requestId || reservation.data.hostId !== hostId || reservation.data.laneId !== lane.id ||
    reservation.data.fleetInputSha256 !== row.fleetInputSha256 || reservation.data.poolId !== recorder.storage.poolId ||
    reservation.data.minimumAvailableBytes !== required.minimumAvailableBytes || admission.data.intent.owner.id !== row.requestId ||
    admission.data.intent.hostId !== hostId || admission.data.intent.laneId !== lane.id || admission.data.intent.inputSha256 !== row.fleetInputSha256)
    return undefined;
  return {dispatchIntentSha256: row.dispatchIntentSha256, fleetInputSha256: row.fleetInputSha256!,
    bindingSha256: requestInputDigest(binding.data), admissionSha256: requestInputDigest(admission.data), reservationSha256: requestInputDigest(reservation.data)};
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
    private readonly actionsTransport: RoutineJobActions | null = rows === routineJobRepository ? new GithubRoutineJobActions() : null,
    private readonly localCandidates: CandidateAuthorization = new CandidateVerificationService(),
    private readonly localEnrollment: typeof assertEnrolledRequest = assertEnrolledRequest) {}
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
  async qualificationTargets(hostId: string, ownedInput?: OwnedRoutineQualification, unclaimedInput?: UnclaimedRoutineQualification): Promise<RoutineQualificationTarget[]> {
    const owned = ownedInput && ownedRoutineQualificationSchema.parse(ownedInput);
    const unclaimed = unclaimedInput && unclaimedRoutineQualificationSchema.parse(unclaimedInput);
    if (owned && unclaimed) throw new TestRunError(400, 'Qualification lookup cannot be both owned and unclaimed');
    const now = this.now(), host = await this.hosts.get(hostId), binding = host?.frameworkBinding;
    if (!host || host.hostId !== hostId || !binding || binding.routineApiVersion < 38 ||
      !Number.isFinite(Date.parse(host.receivedAt)) || Date.parse(host.receivedAt) > now || now - Date.parse(host.receivedAt) > 120_000) return [];
    if (owned && (host.incarnation !== owned.controller.incarnation || host.incarnationGeneration !== owned.controller.generation ||
      requestInputDigest(binding) !== requestInputDigest(owned.binding))) return [];
    const targets: RoutineQualificationTarget[] = [], queryDeadline = now + 5_000;
    for (const lane of host.lanes) {
      const graph = await this.candidateGraphQualificationTarget(host, lane, owned, queryDeadline, unclaimed)
      if (graph) {targets.push(graph); continue}
      if (unclaimed) continue
      if (lane.platform === 'android') {
        let localTarget: RoutineQualificationTarget | undefined;
        try {localTarget = await this.localBackendQualificationTarget(host, lane, owned, queryDeadline);}
        catch (error) {
          // Known local eligibility withdrawal must not fail the shared delivery GET for other lanes.
          if (!(error instanceof TestRequestConflict || error instanceof TestRunError && error.status === 409)) throw error;
        }
        const target = await this.candidateBackendQualificationTarget(host, lane, owned, queryDeadline) ?? localTarget ??
          await this.backendQualificationTarget(host, lane, owned, queryDeadline);
        if (target) targets.push(target);
        continue;
      }
      if (!owned || owned.purpose) continue;
      if (lane.platform !== 'ios-on-mac' || (owned ? lane.id !== owned.laneId || !['reserved', 'running'].includes(lane.state) ||
        lane.activity?.owner.kind !== 'authoring' || lane.activity.owner.id !== owned.ownerId || lane.activity.generation !== owned.generation
        : lane.state !== 'idle' || Boolean(lane.activity)) || lane.dispatchMode !== 'automatic' ||
        (lane.glasses?.length ?? 0) > 1 || new Set(lane.resources.map(resource => resource.kind)).size !== lane.resources.length) continue;
      if (!owned && !this.rows.qualificationCandidates || this.now() >= queryDeadline) break;
      // Finite ordered scan, shared five-second query budget; current 26-member suites fit without a mutable cursor.
      let scanned = 0;
      const candidates = owned ? [await this.rows.get(owned.jobId, Math.max(1, queryDeadline - this.now()))].filter((row): row is StoredRoutineJob => row !== null) :
        this.rows.qualificationCandidates!(hostId, lane.id, 100, new Date(now), queryDeadline - this.now(),
          binding.version >= QUEUED_APP_QUALIFICATION_FRAMEWORK_VERSION, binding.routineApiVersion >= ACCEPTED_APP_QUALIFICATION_API_VERSION,
          binding.version >= PREPARING_APP_QUALIFICATION_FRAMEWORK_VERSION);
      for await (const row of candidates) {
        if (++scanned > 100 || this.now() >= queryDeadline) break;
        const accepted = row.state === 'accepted', queued = row.state === 'queued', preparing = row.state === 'preparing', bound = queued || accepted || preparing;
        const preparation = preparing ? preparingQualificationReceipt(row, hostId, lane) : undefined;
        const receipt = row.hostReceipt;
        if ((!bound && (row.state !== 'awaiting-runner' || row.hostId || row.fleetBinding)) ||
          bound && (preparing ? binding.version < PREPARING_APP_QUALIFICATION_FRAMEWORK_VERSION || !preparation :
            (accepted ? binding.routineApiVersion < ACCEPTED_APP_QUALIFICATION_API_VERSION : binding.version < QUEUED_APP_QUALIFICATION_FRAMEWORK_VERSION) ||
            !queuedQualificationMatches(row, hostId, lane)) ||
          accepted && (!receipt || receipt.requestId !== row.requestId || receipt.hostId !== hostId || receipt.inputSha256 !== row.inputSha256 ||
            !Number.isFinite(Date.parse(receipt.acceptedAt)) || Date.parse(receipt.acceptedAt) > now) ||
          !accepted && row.hostReceipt || row.runId || row.dispatchCompletion ||
          row.hostCancellation || row.hostRejection || row.preparationCancellation || row.preparationRejection ||
          row.fleetCancellation || !row.fleetPreparation ||
          row.fleetDeadline.getTime() <= now || row.fleetSelection.platform !== 'ios-on-mac' ||
          row.fleetTarget?.hostId && row.fleetTarget.hostId !== hostId || row.fleetTarget?.laneId && row.fleetTarget.laneId !== lane.id) continue;
        if (owned && row.fleetResourceReservation && (row.fleetResourceReservation.hostId !== hostId ||
          row.fleetResourceReservation.laneId !== lane.id || row.fleetResourceReservation.requestId !== row.requestId ||
          row.fleetResourceReservation.fleetInputSha256 !== row.fleetInputSha256)) continue;
        this.assertExactInputs(row);
        const admission = row.fleetResourceAdmission === undefined ? undefined : fleetResourceAdmissionSchema.safeParse(row.fleetResourceAdmission);
        if (admission && (!admission.success || admission.data.intent.hostId !== hostId || admission.data.intent.laneId !== lane.id ||
          admission.data.intent.owner.id !== row.requestId || admission.data.intent.inputSha256 !== row.fleetInputSha256 ||
          admission.data.intent.resources.length !== row.fleetPreparation.requirements.resources.length ||
          !row.fleetPreparation.requirements.resources.every(required => admission.data.intent.resources.filter(selected =>
            requestInputDigest([...selected.capabilities].sort()) === requestInputDigest([...required.capabilities].sort()) &&
            lane.resources.some(offered => offered.id === selected.id && offered.kind === required.kind &&
              selected.capabilities.every(capability => offered.capabilities?.includes(capability)))).length === 1))) continue;
        const requirements = accepted || preparing ? recorderCapacityRequirements(row.fleetPreparation) : row.fleetPreparation.requirements;
        const context = permissionContext(binding, row.fleetSelection.build, now);
        if (!requirements.resources.some(resource => resource.permissions?.some(value => value.recipient === 'app')) ||
          row.fleetSelection.minimumFrameworkVersion && row.fleetSelection.minimumFrameworkVersion > binding.version ||
          row.fleetPreparation.routineSource.minimumRoutineApiVersion > binding.routineApiVersion) continue;
        // Structural suitability is only a probe candidate. The local provider still checks worker grants under reservation.
        const structural = {...requirements, resources: requirements.resources.map(({permissions: _, ...resource}) => resource)};
        const appGranted = requirements.resources.every(required => (required.permissions ?? []).filter(value => value.recipient === 'app')
          .every(value => Boolean(context && permissionObservationMatches(lane.resources.find(resource => resource.kind === required.kind)
            ?.permissionObservations?.find(observation => observation.permission === value.permission), value.permission,
          {...context, recipient: 'app'}))));
        const observedLane = accepted || preparing ? {...lane, resources: lane.resources.map(resource => resource.kind === 'recorder' && resource.storage ?
          {...resource, storage: {...resource.storage, reservations: resource.storage.reservations.filter(value =>
            value.requestId !== row.requestId || value.inputSha256 !== (preparing ? row.fleetInputSha256 : row.inputSha256))}} : resource)} : lane;
        if (!compatibleRoutineLane(structural, observedLane, undefined, now) || !owned && appGranted) continue;
        const target = {jobId: row.requestId, hostId, laneId: lane.id, deadline: row.fleetDeadline.toISOString(),
          selection: accepted || preparing ? {...row.fleetSelection, routineSource: row.fleetPreparation.routineSource} : row.fleetSelection, requirements,
          ...(preparation ? {preparing: preparation} : {}),
          ...(accepted ? {accepted: {...receipt!, binding, controller: {incarnation: host.incarnation, generation: host.incarnationGeneration}}} : {}),
          ...(bound || admission ? {target: {hostId, laneId: lane.id}} : row.fleetTarget ? {target: row.fleetTarget} : {})};
        const projected = routineQualificationTargetSchema.parse({...target, inputSha256: requestInputDigest(target)});
        if (owned && (projected.jobId !== owned.jobId || projected.inputSha256 !== owned.inputSha256)) continue;
        targets.push(projected);
        break;
      }
    }
    return targets;
  }
  /** Revalidate local eligibility after a heartbeat; the acquisition CAS owns sequence fencing. */
  private localBackendQualificationHostMatches(host: ReceivedTestHostState, target: RoutineQualificationTarget,
    owned: OwnedRoutineQualification | undefined, now: number) {
    const local = target.local, input = target.proposedInput, binding = host.frameworkBinding,
      lane = host.lanes.find(value => value.id === target.laneId),
      subject = host.resourceLifecycle?.subjects.find(value => value.subject.id === target.purpose?.resourceId),
      reported = (host.resourceReservations?.localPrerequisites ?? []).map(value => routineQualificationTargetSchema.safeParse(value))
        .flatMap(value => value.success && value.data.local ? [value.data] : []).filter(value => value.laneId === target.laneId &&
        (!owned || value.jobId === owned.jobId && value.inputSha256 === owned.inputSha256));
    if (!local || !input || target.purpose?.kind !== 'backend-connectivity' || !binding ||
      binding.routineApiVersion < BACKEND_CONNECTIVITY_ROUTINE_API_VERSION || target.hostId !== host.hostId ||
      requestInputDigest(target.acceptedBinding) !== requestInputDigest(binding) ||
      host.incarnation !== local.controller.incarnation || host.incarnationGeneration !== local.controller.generation ||
      !Number.isFinite(Date.parse(host.receivedAt)) || Date.parse(host.receivedAt) > now || now - Date.parse(host.receivedAt) > 120_000 ||
      !Number.isFinite(Date.parse(host.observedAt)) || Date.parse(host.observedAt) > now || Date.parse(local.requestedAt) > Date.parse(host.observedAt) ||
      Date.parse(local.requestedAt) > now || now >= local.admissionExpiresAt ||
      reported.length !== 1 || requestInputDigest(reported[0]) !== requestInputDigest(target) ||
      (input.minimumFrameworkVersion ?? 0) > binding.version || input.routineSource.minimumRoutineApiVersion > binding.routineApiVersion ||
      lane?.state !== 'idle' || lane.activity ||
      !lane.resources.some(value => value.id === target.purpose!.resourceId && value.kind === 'phone' && value.capabilities?.includes('backend-connectivity')) ||
      !subject?.current || subject.subject.authorityHostId !== host.hostId ||
      (owned ? subject.status !== 'checking' || subject.owner?.kind !== 'boundary-cleanup' || subject.owner.id !== owned.ownerId ||
        subject.owner.generation !== owned.generation || subject.owner.laneId !== lane.id : Boolean(subject.owner)) ||
      !compatibleStructuralRoutineLane(target.requirements, lane, routineLaneContext(host, target.selection.build, now), now) ||
      !input.resources.some(ref => ref.kind === 'phone' && ref.id === target.purpose!.resourceId) ||
      input.resources.length !== target.requirements.resources.length || target.requirements.resources.some(required =>
        input.resources.filter(ref => ref.kind === required.kind && lane.resources.some(offered => offered.kind === ref.kind && offered.id === ref.id &&
          requestInputDigest(offered.exclusiveDependencies ?? []) === requestInputDigest(ref.exclusiveDependencies ?? [])) && (!ref.laneId || ref.laneId === lane.id)).length !== 1)) return false;
    return true;
  }
  /** Local preparation is an authenticated immutable controller assertion, not a fabricated fleet preparing row. */
  private async localBackendQualificationTarget(host: ReceivedTestHostState,
    lane: RoutingTestHostState['lanes'][number], owned: OwnedRoutineQualification | undefined, queryDeadline: number) {
    const values = host.resourceReservations?.localPrerequisites ?? [];
    const candidates = values.map(value => routineQualificationTargetSchema.safeParse(value))
      .flatMap(value => value.success && value.data.local ? [value.data] : [])
      .filter(value => value.laneId === lane.id && (!owned || value.jobId === owned.jobId && value.inputSha256 === owned.inputSha256));
    if (candidates.length !== 1) return undefined;
    const target = candidates[0]!, local = target.local!, input = target.proposedInput!,
      {inputSha256: _, ...body} = target, now = this.now();
    if (requestInputDigest(body) !== target.inputSha256 || requestInputDigest(input) !== local.inputSha256 ||
      now >= queryDeadline || !this.localBackendQualificationHostMatches(host, target, owned, now)) return undefined;
    // Every existing request identity, including a terminal tombstone, excludes pre-admission local qualification.
    if (await this.rows.get(target.jobId, Math.max(1, queryDeadline - this.now()))) return undefined;
    await this.localEnrollment(input);
    if (local.authority.kind === 'candidate') await this.localCandidates.authorize(local.authority.verification, host.hostId,
      {...input, requestId: target.jobId, admissionExpiresAt: local.admissionExpiresAt});
    const definition = await this.definitions.getExact(input.routineId, input.platform, input.definitionRevision,
      local.authority.kind === 'operator');
    if (!definition || definition.definitionSha256 !== local.definitionSha256 ||
      requestInputDigest(definition.definition) !== local.definitionSha256 ||
      requestInputDigest(definition.routineSource) !== requestInputDigest(input.routineSource) ||
      requestInputDigest(definition.definition.execution?.policy ?? null) !== requestInputDigest(input.policy ?? null) ||
      requestInputDigest(routinePortableRequirements(definition)) !== requestInputDigest(target.requirements) ||
      requestInputDigest(frameworkExecutableBuild(target.selection.build, input.glassesModel)) !== requestInputDigest(input.build) ||
      input.minimumFrameworkVersion !== target.selection.minimumFrameworkVersion) return undefined;
    // Enrollment/work may change during definition and host reads. Recheck before exposing any reader authority.
    await this.localEnrollment(input);
    if (local.authority.kind === 'candidate') await this.localCandidates.authorize(local.authority.verification, host.hostId,
      {...input, requestId: target.jobId, admissionExpiresAt: local.admissionExpiresAt});
    const current = await this.hosts.get(host.hostId);
    if (!current || this.now() >= queryDeadline || !this.localBackendQualificationHostMatches(current, target, owned, this.now())) return undefined;
    if (await this.rows.get(target.jobId, Math.max(1, queryDeadline - this.now()))) return undefined;
    const finalHost = await this.hosts.get(host.hostId);
    if (!finalHost || this.now() >= queryDeadline || !this.localBackendQualificationHostMatches(finalHost, target, owned, this.now())) return undefined;
    return target;
  }
  private async candidateBackendQualificationTarget(host: ReceivedTestHostState, lane: RoutingTestHostState['lanes'][number],
    owned: OwnedRoutineQualification | undefined, queryDeadline: number) {
    const phone = lane.resources.find(resource => resource.kind === 'phone'), now = this.now();
    if (!phone || lane.platform !== 'android' || lane.state !== 'idle' || host.lanes.find(value => value.id === lane.id)?.activity || lane.dispatchMode !== 'automatic' ||
      host.resourceReservations?.candidatePrerequisites === undefined || this.now() >= queryDeadline ||
      owned && (owned.laneId !== lane.id || owned.purpose?.resourceId !== phone.id)) return undefined;
    const rows = owned ? [await this.rows.get(owned.jobId)] : this.rows.qualificationCandidates?.(host.hostId, lane.id, 100,
      new Date(now), Math.max(1, queryDeadline - now), true, false, true, 'android') ?? [];
    for await (const row of rows) {
      const pending = row?.fleetCandidatePreparation;
      if (!row || !candidateRequestCurrent(row, pending, this.now()) || !pending || pending.hostId !== host.hostId || pending.laneId !== lane.id ||
        pending.candidate.controller.incarnation !== host.incarnation || pending.candidate.controller.generation !== host.incarnationGeneration ||
        requestInputDigest(pending.target.acceptedBinding) !== requestInputDigest(host.frameworkBinding) ||
        owned && pending.targetInputSha256 !== owned.inputSha256) continue;
      const subject = host.resourceLifecycle?.subjects.find(value => value.subject.id === phone.id);
      if (!subject?.current || subject.subject.authorityHostId !== host.hostId || owned &&
        (subject.status !== 'checking' || subject.owner?.kind !== 'boundary-cleanup' || subject.owner.id !== owned.ownerId ||
          subject.owner.generation !== owned.generation || subject.owner.laneId !== lane.id)) continue;
      const current = await this.rows.get(row.requestId), finalHost = await this.hosts.get(host.hostId);
      if (!current || !candidateRequestCurrent(current, current.fleetCandidatePreparation, this.now()) ||
        requestInputDigest(current.fleetCandidatePreparation) !== requestInputDigest(pending) || !finalHost ||
        finalHost.incarnation !== host.incarnation || finalHost.incarnationGeneration !== host.incarnationGeneration ||
        finalHost.sequence !== host.sequence || this.now() >= queryDeadline) return undefined;
      return pending.target;
    }
    return undefined;
  }
  private async candidateGraphQualificationTarget(host: ReceivedTestHostState, lane: RoutingTestHostState['lanes'][number],
    owned: OwnedRoutineQualification | undefined, queryDeadline: number, unclaimed?: UnclaimedRoutineQualification) {
    if (host.resourceReservations?.resourceReadiness !== true || lane.dispatchMode !== 'automatic' ||
      this.now() >= queryDeadline || owned && (owned.laneId !== lane.id || owned.purpose?.kind !== 'resource-readiness')) return undefined
    if (unclaimed && (lane.state !== 'idle' || host.lanes.find(value => value.id === lane.id)?.activity)) return undefined
    const rows = owned ? [await this.rows.get(owned.jobId)] : unclaimed ? [await this.rows.get(unclaimed.jobId, Math.max(1, queryDeadline - this.now()))] : this.rows.qualificationCandidates?.(host.hostId, lane.id, 100,
      new Date(this.now()), Math.max(1, queryDeadline - this.now()), false, false, false, lane.platform, true) ?? []
    for await (const row of rows) {
      const pending = row?.fleetCandidatePreparation, purpose = pending?.target.purpose
      if (!row || !pending || purpose?.kind !== 'resource-readiness' || !candidateRequestCurrent(row, pending, this.now()) ||
        pending.laneId !== lane.id || unclaimed && (row.requestId !== unclaimed.jobId || pending.targetInputSha256 !== unclaimed.inputSha256) ||
        !this.graphQualificationHostCurrent(host, pending, owned)) continue
      const current = await this.rows.get(row.requestId), finalHost = await this.hosts.get(host.hostId)
      if (!current || !candidateRequestCurrent(current, current.fleetCandidatePreparation, this.now()) ||
        !isDeepIdentity(current.fleetCandidatePreparation, pending) || !finalHost ||
        !this.graphQualificationHostCurrent(finalHost, pending, owned) ||
        unclaimed && finalHost.lanes.some(value => value.id === lane.id && (value.state !== 'idle' || value.activity)) ||
        this.now() >= queryDeadline) return undefined
      return pending.target
    }
    return undefined
  }
  private graphQualificationHostCurrent(host: ReceivedTestHostState, pending: FleetCandidatePreparation, owned?: OwnedRoutineQualification) {
    const purpose = pending.target.purpose, lane = host.lanes.find(value => value.id === pending.laneId),
      ownerId = `resource-graph:${pending.targetInputSha256}`, received = Date.parse(host.receivedAt)
    if (purpose?.kind !== 'resource-readiness' || host.hostId !== pending.hostId ||
      host.resourceReservations?.resourceReadiness !== true || lane?.dispatchMode !== 'automatic' ||
      !Number.isFinite(received) || received > this.now() || this.now() - received > 120_000 ||
      pending.candidate.controller.incarnation !== host.incarnation || pending.candidate.controller.generation !== host.incarnationGeneration ||
      !isDeepIdentity(pending.target.acceptedBinding, host.frameworkBinding) || owned && pending.targetInputSha256 !== owned.inputSha256) return false
    const ownedLane = lane.activity?.owner.id === ownerId && lane.activity.owner.kind === 'boundary-cleanup' &&
      ['reserved', 'running'].includes(lane.state)
    if (!ownedLane && (lane.state !== 'idle' || lane.activity)) return false
    // Periodic report sequences are not resource authority. Revalidate only this
    // original graph; UNKNOWN baseline age may still receive its owned check.
    return purpose.resources.every(member => {
      const subject = host.resourceLifecycle?.subjects.find(value => value.subject.id === member.id)
      return subject?.current && subject.subject.authorityHostId === host.hostId &&
        subject.repair.state === 'none' && !['out-of-service', 'offline', 'in-repair'].includes(subject.status) &&
        (ownedLane ? subject.owner?.id === ownerId && subject.owner.kind === 'boundary-cleanup' &&
          (!owned || subject.owner.generation === owned.generation) : subject.owner === null)
    })
  }
  private async reconcileCandidatePreparation(row: StoredRoutineJob, host: ReceivedTestHostState | undefined, onPhase?: RoutinePreparationPhase) {
    const pending = row.fleetCandidatePreparation;
    if (!pending || !host || Date.parse(host.receivedAt) > this.now() || this.now() - Date.parse(host.receivedAt) > 120_000 ||
      Date.parse(host.observedAt) > this.now() || this.now() - Date.parse(host.observedAt) > 120_000 || !host.authorityReservations) return row;
    const settlement = candidateSettlement(pending, host, host.authorityReservations, this.now());
    if (!settlement) {
      if (!obsoleteUnboundGraphCandidate(row, host, this.now())) return row;
      onPhase?.('candidate-supersession-CAS');
      return await this.rows.supersedeCandidatePreparation?.(row, new Date(this.now())) ?? row;
    }
    if (!this.rows.settleCandidatePreparation) return row;
    onPhase?.('candidate-settlement-CAS');
    return await this.rows.settleCandidatePreparation(row, {...pending, settlement}, new Date(this.now())) ?? row;
  }
  /** A selected preparing receipt authorizes host-only preparation; only the owned check can observe the phone. */
  private async backendQualificationTarget(host: ReceivedTestHostState,
    lane: RoutingTestHostState['lanes'][number], owned: OwnedRoutineQualification | undefined, queryDeadline: number) {
    const binding = host.frameworkBinding, now = this.now(), phone = lane.resources.find(resource => resource.kind === 'phone'),
      subject = host.resourceLifecycle?.subjects.find(value => value.subject.id === phone?.id),
      journals = owned ? [] : host.resourceReservations?.resourceChecks?.filter(value => value.state === 'prepared' &&
        value.intent.laneId === lane.id && value.intent.prerequisite?.kind === 'backend-connectivity' && value.intent.prerequisite.preparing) ?? [];
    if (!binding || binding.routineApiVersion < BACKEND_CONNECTIVITY_ROUTINE_API_VERSION || lane.dispatchMode !== 'automatic' ||
      lane.state !== 'idle' || host.lanes.find(value => value.id === lane.id)?.activity || !phone?.capabilities?.includes('backend-connectivity') ||
      this.now() >= queryDeadline || !owned && !journals.length ||
      owned && (!owned.purpose || owned.purpose.resourceId !== phone.id || lane.id !== owned.laneId || !subject?.current ||
        subject.subject.authorityHostId !== host.hostId || subject.status !== 'checking' || subject.owner?.kind !== 'boundary-cleanup' ||
        subject.owner.id !== owned.ownerId || subject.owner.generation !== owned.generation || subject.owner.laneId !== lane.id) ||
      !owned && subject?.owner) return undefined;
    let scanned = 0;
    // Only an already journaled original check may finish legacy acquisition.
    // Ordinary discovery cannot construct another preparation target.
    const candidates = owned ? [owned.jobId] : [...new Set(journals.map(value => value.intent.prerequisite!.jobId))];
    for (const id of candidates) {
      if (++scanned > 100 || this.now() >= queryDeadline) break;
      const row = await this.rows.get(id, Math.max(1, queryDeadline - this.now()));
      if (!row) continue;
      const preparing = preparingQualificationReceipt(row, host.hostId, lane);
      if (!preparing || row.fleetExclusiveExecutionBinding || row.hostReceipt || row.runId || row.dispatchCompletion ||
        row.hostCancellation || row.hostRejection || row.preparationCancellation || row.preparationRejection || row.fleetCancellation ||
        !row.fleetPreparation || row.fleetDeadline.getTime() <= now || row.fleetSelection.platform !== 'android' ||
        row.fleetTarget?.hostId && row.fleetTarget.hostId !== host.hostId || row.fleetTarget?.laneId && row.fleetTarget.laneId !== lane.id ||
        row.fleetSelection.minimumFrameworkVersion && row.fleetSelection.minimumFrameworkVersion > binding.version ||
        row.fleetPreparation.routineSource.minimumRoutineApiVersion > binding.routineApiVersion) continue;
      this.assertExactInputs(row);
      const requirements = recorderCapacityRequirements(row.fleetPreparation),
        requiredPhone = requirements.resources.find(resource => resource.kind === 'phone');
      if (!requiredPhone?.capabilities.includes('backend-connectivity')) continue;
      const selectedLane = {...lane, resources: lane.resources.map(resource => resource.storage ? {...resource,
        storage: {...resource.storage, reservations: resource.storage.reservations.filter(value =>
          value.requestId !== row.requestId || value.inputSha256 !== row.fleetInputSha256)}} : resource)},
        selectedHost = {...host, lanes: host.lanes.map(value => value.id === lane.id ? selectedLane : value)};
      // Discovery omits only the health gate. Existing capability, storage and permission requirements still apply.
      const context = routineLaneContext(host, row.fleetSelection.build, now);
      if (!compatibleStructuralRoutineLane(requirements, selectedLane, context, now)) continue;
      const {recordedRoutineBuild} = await import('./routine-dispatch.service');
      const enrollment = routineEnrollmentSchema.parse({routineId: row.fleetSelection.routineId, platform: 'android',
        definitionRevision: row.fleetSelection.routineRevision, definition: row.fleetPreparation.definition,
        definitionSha256: row.fleetPreparation.definitionSha256, routineSource: row.fleetPreparation.routineSource});
      let proposedInput;
      try {proposedInput = routineAdmissionInput(enrollment, recordedRoutineBuild(row.fleetSelection.build, row.fleetSelection.source, 'android'),
        {hostId: host.hostId, laneId: lane.id}, selectedHost, now, {minimumFrameworkVersion: row.fleetSelection.minimumFrameworkVersion});
        proposedInput.build = frameworkExecutableBuild(row.fleetSelection.build, proposedInput.glassesModel);
      } catch (error) {if (error instanceof TestRunError && error.status === 409) continue; throw error;}
      const target = {jobId: row.requestId, hostId: host.hostId, laneId: lane.id, deadline: row.fleetDeadline.toISOString(),
        selection: {...row.fleetSelection, routineSource: row.fleetPreparation.routineSource}, requirements, preparing, proposedInput, purpose: {kind: 'backend-connectivity' as const, resourceId: phone.id}, acceptedBinding: binding,
        target: {hostId: host.hostId, laneId: lane.id}},
        projected = routineQualificationTargetSchema.parse({...target, inputSha256: requestInputDigest(target)});
      if (owned ? projected.inputSha256 !== owned.inputSha256 : !journals.some(value => {
        const original = value.intent.prerequisite!;
        return original.jobId === row.requestId && original.targetInputSha256 === projected.inputSha256 &&
          value.intent.inputSha256 === projected.inputSha256 && original.resourceId === phone.id &&
          isDeepIdentity(original.binding, binding) && isDeepIdentity(original.preparing, projected.preparing) &&
          isDeepIdentity(original.local, projected.local) && isDeepIdentity(original.candidate, projected.candidate);
      })) continue;
      const original = await this.rows.get(row.requestId, Math.max(1, queryDeadline - this.now()));
      if (!original?.fleetPreparation || this.now() >= queryDeadline || !preparingQualificationReceipt(original, host.hostId, lane) ||
        requestInputDigest(preparingQualificationReceipt(original, host.hostId, lane)) !== requestInputDigest(preparing) ||
        original.fleetExclusiveExecutionBinding || original.hostReceipt || original.runId ||
        original.dispatchCompletion || original.hostCancellation || original.hostRejection || original.preparationCancellation ||
        original.preparationRejection || original.fleetCancellation || original.fleetDeadline.getTime() <= this.now() ||
        routineJobInputDigest(original) !== row.fleetInputSha256 || original.fleetInputSha256 !== row.fleetInputSha256 ||
        requestInputDigest(original.fleetSelection) !== row.fleetSelectionSha256) return undefined;
      // Readback validates current selected authority, not an observation counter.
      // An ordinary heartbeat cannot withdraw an unchanged preparing target.
      const finalHost = await this.hosts.get(host.hostId), finalLane = finalHost?.lanes.find(value => value.id === lane.id),
        finalPhone = finalHost?.resourceLifecycle?.subjects.find(value => value.subject.id === phone.id);
      if (!finalHost || finalHost.incarnation !== host.incarnation || finalHost.incarnationGeneration !== host.incarnationGeneration ||
        !isDeepIdentity(finalHost.frameworkBinding, binding) || this.now() >= queryDeadline ||
        [finalHost.receivedAt, finalHost.observedAt].some(at => !at || Date.parse(at) > this.now() || this.now() - Date.parse(at) > 120_000) ||
        finalLane?.state !== 'idle' || finalLane.activity || finalLane.dispatchMode !== 'automatic' ||
        !finalPhone?.current || finalPhone.subject.authorityHostId !== host.hostId ||
        (owned ? finalPhone.status !== 'checking' || finalPhone.owner?.id !== owned.ownerId ||
          finalPhone.owner.kind !== 'boundary-cleanup' || finalPhone.owner.generation !== owned.generation || finalPhone.owner.laneId !== lane.id
          : Boolean(finalPhone.owner)) ||
        !isDeepIdentity(preparingQualificationReceipt(original, host.hostId, finalLane), preparing) ||
        requirements.resources.some(required => {
          const resourceId = lane.resources.find(value => value.kind === required.kind)?.id,
            before = host.resourceLifecycle?.subjects.find(value => value.subject.id === resourceId),
            after = finalHost.resourceLifecycle?.subjects.find(value => value.subject.id === resourceId);
          return !isDeepIdentity({generation: before?.generation ?? null, owner: before?.owner ?? null},
            {generation: after?.generation ?? null, owner: after?.owner ?? null});
        })) return undefined;
      const currentLane = {...finalLane, resources: finalLane.resources.map(resource => resource.storage ? {...resource,
        storage: {...resource.storage, reservations: resource.storage.reservations.filter(value =>
          value.requestId !== row.requestId || value.inputSha256 !== row.fleetInputSha256)}} : resource)},
        currentHost = {...finalHost, lanes: finalHost.lanes.map(value => value.id === lane.id ? currentLane : value)};
      if (!compatibleStructuralRoutineLane(requirements, currentLane, routineLaneContext(finalHost, row.fleetSelection.build, this.now()), this.now())) return undefined;
      try {
        const input = routineAdmissionInput(enrollment, recordedRoutineBuild(row.fleetSelection.build, row.fleetSelection.source, 'android'),
          {hostId: host.hostId, laneId: lane.id}, currentHost, this.now(), {minimumFrameworkVersion: row.fleetSelection.minimumFrameworkVersion});
        input.build = frameworkExecutableBuild(row.fleetSelection.build, input.glassesModel);
        if (!isDeepIdentity(input, proposedInput)) return undefined;
      } catch (error) {if (error instanceof TestRunError && error.status === 409) return undefined; throw error;}
      return projected;
    }
    return undefined;
  }
  private retry(row: StoredRoutineJob, selected: z.infer<typeof routineJobSubmissionSchema>) {
    const original = row.fleetSelection;
    if (selected.routineId !== original.routineId || selected.platform !== original.platform ||
      selected.minimumFrameworkVersion !== original.minimumFrameworkVersion || requestInputDigest(selected.source) !== requestInputDigest(original.source) ||
      selected.routineRevision && selected.routineRevision !== original.routineRevision ||
      selected.routineRepository && selected.routineRepository !== routineSourceRepository(original) ||
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
    const routineRepository = selected.routineRepository ?? selected.routineSource?.repository ?? configuredTestingTarget().repository;
    const routineRevision = selected.routineRevision ?? selected.routineSource?.commit ?? await this.sources.resolve(undefined, undefined, routineRepository);
    const build = inheritedBuild ? null : await this.builds.resolve(selected.source, selected.platform);
    if (build && (build.availability !== 'available' || !build.archive || !build.receipt))
      throw new TestRunError(409, build.reason ?? 'Exact app publication is unavailable');
    const {target: _, deadline: __, routineRepository: _repository, ...selection} = selected;
    return portableRoutineSelectionSchema.parse(JSON.parse(JSON.stringify({...selection, routineRevision,
      ...(routineRepository === testingTarget().repository ? {} : {routineRepository}),
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
    // The existing pending tick delivers this durable original. Frozen batch
    // admission must not wait for GitHub discovery or dispatch acknowledgements.
    return this.job(row.requestId);
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
    const runs = await this.actionsTransport.runs(row.requestId, row.fleetDispatch.firstAttemptAt ?? row.createdAt?.toISOString() ?? row.fleetDispatch.lastAttemptAt, retainedTestingTarget(row.fleetDispatch.target));
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
    if (source.channel === 'pr' && await this.builds.isPrSuperseded(source.prNumber, row.fleetSelection.build.headSha, row.fleetSelection.build.repository)) {
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
    if (!routineActionsRetry(previous,runs,this.now())) {
      if(previous)await this.rows.dispatch?.(row.requestId,previous,{...previous,checkedAt:new Date(this.now()).toISOString()});
      return this.job(row.requestId);
    }
    if (!this.rows.dispatch) throw new TestRunError(503, 'Actions dispatch receipt storage is unavailable');
    const value = {attempts:(previous?.attempts??0)+1,firstAttemptAt:previous?.firstAttemptAt??new Date(this.now()).toISOString(),lastAttemptAt:new Date(this.now()).toISOString(),checkedAt:new Date(this.now()).toISOString(),
      target: previous ? retainedTestingTarget(previous.target) : configuredTestingTarget()};
    const retained=await this.rows.dispatch(row.requestId,previous,value);
    if(!retained)return this.job(row.requestId);
    try {
      await this.actionsTransport.dispatch(row.requestId, value.target);
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
  async preparation(jobId: string, onPhase?: RoutinePreparationPhase) {
    onPhase?.('job-lookup');
    const selected = await this.job(jobId);
    onPhase?.('supersession');
    const row = await this.supersession(selected);
    const routing: Partial<ReturnType<typeof routineJobRouting>> = row.fleetPreparation ? await this.routing(row, onPhase) : {};
    return {jobId, kind: 'run' as const, inputSha256: row.fleetInputSha256 ?? row.fleetSelectionSha256, deadline: row.fleetDeadline.toISOString(),
      state: row.state, ...routing, ...(row.fleetCandidatePreparation ? {fleetCandidatePreparation: row.fleetCandidatePreparation} : {}), selection: row.fleetSelection, ...(row.fleetTarget ? {target: row.fleetTarget} : {}), ...(row.fleetPreparation ? {prepared: row.fleetPreparation} : {})};
  }
  private async routing(row: StoredRoutineJob, onPhase?: RoutinePreparationPhase) {
    const original = {requestId: row.requestId, inputSha256: row.fleetInputSha256!};
    if (row.fleetCandidatePreparation?.provisionalReturn && !row.fleetCandidatePreparation.provisionalReturn.releasedAt) {
      onPhase?.('candidate-provisional-release');
      row = await this.rows.releaseCandidateProvisional?.(row, new Date(this.now())) ?? row;
    }
    let candidateHost: ReceivedTestHostState | undefined;
    if (row.fleetCandidatePreparation) {
      onPhase?.('candidate-host-read');
      candidateHost = await this.hosts.get(row.fleetCandidatePreparation.hostId) ?? undefined;
    }
    onPhase?.('candidate-return-reconciliation');
    row = await this.reconcileCandidatePreparation(row, candidateHost, onPhase);
    let hosts: RoutingTestHostState[] = candidateHost ? [candidateHost] : [];
    if (row.state !== 'awaiting-runner' || row.fleetCancellation || row.fleetDeadline.getTime() <= this.now())
      return {...routineJobRouting(recorderCapacityRequirements(row.fleetPreparation!), hosts, this.now(), row.fleetTarget, row.fleetSelection.build, true, original), waitingReason: RESOURCE_ADMISSION_WAIT};
    if (row.fleetCandidatePreparation) return {...routineJobRouting(recorderCapacityRequirements(row.fleetPreparation!), hosts, this.now(), row.fleetTarget, row.fleetSelection.build, true, original),
      waitingReason: row.fleetCandidatePreparation.target.purpose?.kind === 'resource-readiness'
        ? 'Checking this candidate’s complete required resource graph and waiting for its original return'
        : 'Checking the selected phone and waiting for its complete return'};
    onPhase?.('initial-host-read');
    hosts = await this.hosts.list?.() ?? [];
    if (this.rows.reconcileRecorderHost) {
      let returned = false;
      for (const [hostIndex, host] of hosts.entries()) {
        if (host.authorityReservations && !host.authorityReservations.some(claim => !isExclusiveHostReservation(claim))) continue;
        onPhase?.('recorder-return-reconciliation', {hostCount: hosts.length, hostIndex});
        await this.rows.reconcileRecorderHost(host.hostId, new Date(this.now()),
          (phase, counts) => onPhase?.(phase, {hostCount: hosts.length, hostIndex, ...counts}), () => {returned = true;});
      }
      if (returned) {
        onPhase?.('refreshed-host-read', {hostCount: hosts.length});
        hosts = await this.hosts.list?.() ?? [];
      }
    }
    const requirements = recorderCapacityRequirements(row.fleetPreparation!);
    // Provisional physical custody is recovered independently of network-health requirements.
    onPhase?.('original-recorder-claims-read');
    const originals = await this.rows.recorderClaims?.(row.requestId) ??
      hosts.flatMap(host => (host.authorityReservations ?? []).filter((claim): claim is RecorderHostReservation =>
        !isExclusiveHostReservation(claim) && claim.requestId === row.requestId));
    if (originals.length > 1 || originals.some(claim => claim.fleetInputSha256 !== row.fleetInputSha256 ||
      row.fleetResourceReservation && row.fleetResourceReservation.id !== claim.id || row.fleetResourceAdmission &&
      (row.fleetResourceAdmission.intent.hostId !== claim.hostId || row.fleetResourceAdmission.intent.laneId !== claim.laneId)))
      return {...routineJobRouting(requirements, hosts, this.now(), row.fleetTarget, row.fleetSelection.build, false, original),
        waitingReason: RESOURCE_ADMISSION_WAIT};
    const quotaHost = row.fleetResourceReservation && hosts.find(host => host.hostId === row.fleetResourceReservation!.hostId),
      replacingQuota = Boolean(quotaHost && replaceableMacRecorderQuota(row,
        {...quotaHost, snapshot: quotaHost, receivedAt: new Date(quotaHost.receivedAt), resourceReservations: quotaHost.authorityReservations}, originals, this.now()));
    const provisional = replacingQuota ? undefined : originals[0];
    if (row.fleetResourceAdmission && (row.fleetResourceAdmission.intent.operationId !== `run:${row.requestId}` ||
      row.fleetResourceAdmission.intent.owner.kind !== 'run' || row.fleetResourceAdmission.intent.owner.id !== row.requestId ||
      row.fleetResourceAdmission.intent.inputSha256 !== row.fleetInputSha256))
      return {...routineJobRouting(requirements, hosts, this.now(), row.fleetTarget, row.fleetSelection.build, false, original),
        waitingReason: RESOURCE_ADMISSION_WAIT};
    const originalExclusive = hosts.flatMap(host => (host.authorityReservations ?? []).filter(isExclusiveHostReservation))
      .filter(claim => claim.owner.kind === 'run' && claim.owner.id === row.requestId && claim.origin?.kind === 'fleet');
    const retained = replacingQuota ? undefined : row.fleetResourceReservation,
      acquired = Boolean(retained || row.fleetExclusiveReservation || provisional || originalExclusive.length),
      admitted = acquired ? row.fleetResourceAdmission : undefined;
    if (originalExclusive.some(claim => claim.inputSha256 !== row.fleetInputSha256 || claim.origin?.fleetInputSha256 !== row.fleetInputSha256 ||
      !admitted || claim.borrowerHostId !== admitted.intent.hostId || claim.laneId !== admitted.intent.laneId))
      return {...routineJobRouting(requirements, hosts, this.now(), row.fleetTarget, row.fleetSelection.build, false, original),
        waitingReason: RESOURCE_ADMISSION_WAIT};
    const target = retained ? {hostId: retained.hostId, laneId: retained.laneId} : admitted
      ? {hostId: admitted.intent.hostId, laneId: admitted.intent.laneId} : provisional
        ? {hostId: provisional.hostId, laneId: provisional.laneId} : row.fleetTarget;
    const routed = routineJobRouting(requirements, hosts, this.now(), target, row.fleetSelection.build, true, original);
    const inventoryRequirements = {...requirements, resources: requirements.resources.map(({storage: _, ...resource}) => resource)};
    const inventory = routineJobRouting(inventoryRequirements, hosts, this.now(), target, row.fleetSelection.build, true, original);
    let waitingReason: string | undefined;
    const onWaiting = (reason: string) => {waitingReason = reason;};
    if (retained) {
      onPhase?.('retained-resource-reservation');
      const checked = await this.rows.reserveResources?.(row.requestId, row.fleetInputSha256!, retained.hostId, retained.laneId, new Date(this.now()), onWaiting);
      if (!checked) {
        const targetInventory = routineJobRouting(inventoryRequirements, hosts, this.now(), retained, row.fleetSelection.build, true, original);
        return {...routed, chosenModel: retained.chosenModel, resourceTarget: {hostId: retained.hostId, laneId: retained.laneId},
          routingLabels: routineRequirementLabels(requirements, retained.chosenModel, retained),
          waitingReason: targetInventory.waitingReason ?? waitingReason ?? sharedResourceWaitingReason(row, hosts) ?? RESOURCE_ADMISSION_WAIT};
      }
      return {...routed, chosenModel: retained.chosenModel, waitingReason: undefined, resourceTarget: {hostId: retained.hostId, laneId: retained.laneId},
        routingLabels: routineRequirementLabels(requirements, retained.chosenModel, retained)};
    }
    if (inventory.waitingReason) return inventory;
    if (routed.waitingReason) {
      const reasons = hosts.flatMap(host => host.lanes.filter(lane =>
        Number.isFinite(Date.parse(host.receivedAt)) && Date.parse(host.receivedAt) <= this.now() && this.now() - Date.parse(host.receivedAt) <= 120_000 &&
        (!target?.hostId || target.hostId === host.hostId) && (!target?.laneId || target.laneId === lane.id) &&
        !('activity' in lane && lane.activity) && lane.dispatchMode === 'automatic' && compatibleStructuralRoutineLane(inventoryRequirements, lane,
          routineLaneContext(host, row.fleetSelection.build, this.now()), this.now())).map(lane => {
        const resource = lane.resources.find(resource => resource.kind === 'recorder');
        return recorderWait(resource?.storage, requirements.resources.find(resource => resource.kind === 'recorder')!.storage!.minimumAvailableBytes, this.now());
      }));
      return {...routed, waitingReason: reasons.length && reasons.every(reason => reason === RECORDER_CAPACITY_WAIT)
        ? RECORDER_CAPACITY_WAIT : reasons.length && reasons.every(reason => reason === RECORDER_OBSERVATION_WAIT)
          ? RECORDER_OBSERVATION_WAIT : RESOURCE_ADMISSION_WAIT};
    }
    if (!admitted) onPhase?.('selected-lanes-read');
    const selected = admitted ? [] : await this.rows.selectedLanes?.(hosts.map(host => host.hostId)) ?? [];
    const candidateReasons: (string | undefined)[] = [];
    const candidates = orderedRoutineCandidates(row.requestId, hosts, selected),
      attempts = (hostId: string, laneId: string) => row.fleetCandidatePreparations?.filter(value =>
        value.hostId === hostId && value.laneId === laneId).length ?? 0;
    // Try available alternatives before renewing a failed preparation. This is
    // preference only; explicit targets and all custody/admission fences remain.
    candidates.sort((a, b) => attempts(a.host.hostId, a.lane.id) - attempts(b.host.hostId, b.lane.id));
    for (const {host, lane} of candidates) {
      // A staged admission may survive an interrupted authority/receipt write.
      // Continue that exact candidate; a preference change cannot move its custody.
      if (target?.hostId && target.hostId !== host.hostId || target?.laneId && target.laneId !== lane.id) continue;
      if (row.fleetTarget?.hostId && row.fleetTarget.hostId !== host.hostId || row.fleetTarget?.laneId && row.fleetTarget.laneId !== lane.id ||
        lane.dispatchMode !== 'automatic') continue;
      const context = routineLaneContext(host, row.fleetSelection.build, this.now());
      const current = evaluateRoutineLaneReadiness(requirements, host, lane, context, this.now(), original, {
        minimumRoutineApiVersion: row.fleetPreparation!.routineSource.minimumRoutineApiVersion,
        minimumFrameworkVersion: row.fleetSelection.minimumFrameworkVersion, target: row.fleetTarget,
        deadline: row.fleetDeadline, cancelled: Boolean(row.fleetCancellation),
      });
      if (!current.ready) {
        const storage = current.resources.find(resource => resource.kind === 'recorder')?.conditions.find(condition => condition.id === 'storage');
        candidateReasons.push(storage && storage.status !== 'match' ? recorderWait(lane.resources.find(resource => resource.kind === 'recorder')?.storage,
          requirements.resources.find(resource => resource.kind === 'recorder')!.storage!.minimumAvailableBytes, this.now()) :
          current.resources.flatMap(resource => resource.conditions).find(condition => condition.status === 'blocked' || condition.status === 'unknown')?.nextAction);
        continue;
      }
      let candidateReason: string | undefined, exclusiveBlocker = false;
      onPhase?.('resource-reservation');
      const saved = await this.rows.reserveResources?.(row.requestId, row.fleetInputSha256!, host.hostId, lane.id, new Date(this.now()),
        (reason, exclusive) => {candidateReason = reason; exclusiveBlocker = Boolean(exclusive);});
      if (saved?.fleetResourceReservation) return {...routed, chosenModel: saved.fleetResourceReservation.chosenModel, resourceTarget: {hostId: saved.fleetResourceReservation.hostId, laneId: saved.fleetResourceReservation.laneId},
        routingLabels: routineRequirementLabels(requirements, saved.fleetResourceReservation.chosenModel, saved.fleetResourceReservation)};
      // A staged candidate or retained backend byte claim keeps this original on
      // the same lane; later candidates cannot replace unresolved custody.
      if (exclusiveBlocker) return {...routed, waitingReason: candidateReason ?? RESOURCE_ADMISSION_WAIT};
      candidateReasons.push(candidateReason);
    }
    return {...routed, waitingReason: sharedResourceWaitingReason(row, hosts) ??
      (candidateReasons.length && candidateReasons.every(reason => reason === BACKEND_PREPARATION_WAIT) ? BACKEND_PREPARATION_WAIT
        : candidateReasons.length && candidateReasons.every(reason => reason === RECORDER_CAPACITY_WAIT) ? RECORDER_CAPACITY_WAIT
        : candidateReasons.length && candidateReasons.every(reason => reason === RECORDER_OBSERVATION_WAIT) ? RECORDER_OBSERVATION_WAIT
          : RESOURCE_ADMISSION_WAIT)};
  }
  async preparationStatus(jobId: string, value: unknown) {
    const input = routinePreparationStatusSchema.parse(value), row = await this.job(jobId);
    if (input.inputSha256 !== row.fleetSelectionSha256 || !row.fleetActions?.some(run => run.actionsRunId === input.actionsRunId))
      throw new TestRequestConflict('Preparation status differs from its recorded exact workflow');
    if (row.fleetPreparation || row.fleetBinding || row.fleetCancellation || row.state === 'terminal') return row;
    if (row.fleetActions.some(run => BigInt(run.actionsRunId) > BigInt(input.actionsRunId))) return row;
    if (!this.rows.preparationStatus) throw new TestRunError(503, 'Preparation status storage is unavailable');
    const reason = input.code === 'not-applicable' ? `Routine ${row.fleetSelection.routineId} does not support ${row.fleetSelection.platform}.`
      : input.phase === 'Git blobs' && input.retryable ? `${ROUTINE_SOURCE_DOWNLOAD_UNAVAILABLE} Tests did not start. Retrying the same request.`
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
  async inventory(jobId: string) {const row = await this.job(jobId); return this.sources.inventory(row.fleetSelection.routineRevision, routineSourceRepository(row.fleetSelection));}
  async blob(jobId: string, sha: string) {
    const file = (await this.inventory(jobId)).files.find(file => file.gitBlobSha1 === sha);
    if (!file) throw new TestRequestConflict('Requested blob is not part of the exact job source');
    const row = await this.job(jobId);
    return this.sources.blob(file, routineSourceRepository(row.fleetSelection));
  }
  async prepared(jobId: string, value: unknown, onPhase?: RoutinePreparationPhase) {
    const input = completeRoutineJobPreparationSchema.parse(value);
    onPhase?.('job-lookup');
    const row = await this.job(jobId), selected = row.fleetSelection;
    if (input.inputSha256 !== row.fleetSelectionSha256) throw new TestRequestConflict('Preparation changed the exact source selection');
    onPhase?.('ordinary-enrollment-lookup');
    const ordinary = await this.definitions.getExact(selected.routineId, selected.platform, selected.routineRevision, true);
    if (!ordinary) {
      onPhase?.('candidate-enrollment-lookup');
      if (await this.definitions.getExact(selected.routineId, selected.platform, selected.routineRevision, false))
        throw new TestRunError(422, 'Candidate-only source requires its accepted authoring job and review authorization');
    }
    const definition = routineEnrollmentSchema.parse({routineId: selected.routineId, platform: selected.platform, definitionRevision: selected.routineRevision,
      routineSource: input.routineSource, definitionSha256: input.definitionSha256, definition: input.definition});
    if (input.routineSource.repository !== routineSourceRepository(selected) || requestInputDigest(input.definition) !== input.definitionSha256 || selected.routineSource &&
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
    onPhase?.('prepared-input-CAS');
    const saved = await this.rows.prepare(jobId, row.fleetSelectionSha256, prepared, digest, new Date(this.now()));
    if (!saved) onPhase?.('prepared-input-winner-read');
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
    const accepting = (host: Awaited<ReturnType<TestHostStateService['get']>>, stage: 'before-reservation' | 'after-reservation') => {
      const lane = host?.lanes.find(lane => lane.id === input.laneId);
      const conditions: LaneAcceptanceCondition[] = [
        ['enrolled-host', 'The current enrolled report belongs to the authenticated host.'],
        ['report-timestamp', 'The accepted report timestamp is valid.'],
        ['report-not-future', 'The accepted report is not from the future.'],
        ['report-fresh', 'The accepted report is at most 120 seconds old.'],
        ['lane-automatic', 'The selected lane advertises automatic dispatch.'],
        ['lane-idle', 'The selected lane has no active operation.'],
        ['selected-host', 'The original target permits this host.'],
        ['selected-lane', 'The original target permits this lane.'],
        ['reported-descriptor', `Runner descriptor: ${input.descriptorRevision}`],
        ['computed-descriptor', `Runner descriptor: ${input.descriptorRevision}`],
        ['resource-state', 'Current original resource readiness and custody permit this request.'],
        ['job-compatibility', 'The current lane supports the frozen job requirements.'],
      ].map(([id, expected]) => ({id: id!, expected: expected!, status: 'not-evaluated'}));
      let index = 0;
      const check = (passed: boolean, observed: LaneAcceptanceCondition['observed']) => {
        Object.assign(conditions[index++]!, {status: passed ? 'passed' : 'failed', observed}); return passed;
      };
      // Keep the original short-circuit order. Later conditions remain unknown,
      // and the same pure blocker computes both the verdict and its diagnostic.
      let blocker: ReturnType<typeof routineResourceBlocker> | ReturnType<typeof routineLaneRequirementBlocker> = undefined;
      let descriptor: string | undefined;
      const resources = () => {
        blocker = routineResourceBlocker({hostId: host!.hostId, incarnation: host!.incarnation!, incarnationGeneration: host!.incarnationGeneration!,
          sequence: host!.sequence!, receivedAt: new Date(host!.receivedAt), snapshot: host!, laneControls: host!.resourceControlRecords,
          resourceReservations: host!.authorityReservations, resourceLifecycleCursor: host!.resourceLifecycleCursor}, row, input.laneId, this.now());
        return blocker === undefined;
      };
      const compatible = () => {
        blocker = routineLaneRequirementBlocker(requirements, {...lane!, resources: lane!.resources.map(resource => resource.storage ? {...resource,
          storage: {...resource.storage, reservations: resource.storage.reservations.filter(value =>
            value.requestId !== jobId || value.inputSha256 !== row.inputSha256)}} : resource)},
          routineLaneContext(host!, row.fleetSelection.build, this.now()), this.now(), false);
        return blocker === undefined;
      };
      if (!(check(host?.hostId === hostId, host?.hostId ?? null) &&
        check(Number.isFinite(Date.parse(host!.receivedAt)), host!.receivedAt) &&
        check(Date.parse(host!.receivedAt) <= this.now(), host!.receivedAt) &&
        check(this.now() - Date.parse(host!.receivedAt) <= 120_000, host!.receivedAt) &&
        check(lane?.dispatchMode === 'automatic', lane?.dispatchMode ?? null) && check(!lane!.activity, lane!.state) &&
        check(!row.fleetTarget?.hostId || row.fleetTarget.hostId === hostId, row.fleetTarget?.hostId ?? null) &&
        check(!row.fleetTarget?.laneId || row.fleetTarget.laneId === input.laneId, row.fleetTarget?.laneId ?? null) &&
        check(lane!.descriptorRevision === input.descriptorRevision, lane!.descriptorRevision ?? null) &&
        check((descriptor = routineLaneDescriptorRevision(lane!)) === input.descriptorRevision, descriptor) &&
        check(resources(), blocker ?? null) && check(compatible(), blocker ?? null)))
        throw new RoutineLaneAcceptanceConflict({stage, hostId, laneId: input.laneId, conditions});
    };
    accepting(await this.hosts.get(hostId), 'before-reservation');
    const reserved = await this.rows.reserveResources?.(jobId, input.inputSha256, hostId, input.laneId, new Date(this.now()));
    if (!reserved)
      throw new TestRequestConflict('Reserved recorder disk capacity is no longer available');
    row = reserved;
    accepting(await this.hosts.get(hostId), 'after-reservation');
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
    if (this.rows === routineJobRepository) {
      await exclusiveResources.reconcileFleetCancellation(jobId);
      await this.rows.reconcileBackendRecorderCancellation?.(jobId, new Date(this.now()));
    }
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
    const current = await this.job(jobId);
    if (row.fleetCancellation || current.fleetCancellation) {
      await this.rows.cancellationProgress?.(jobId,{checkedAt:new Date(this.now()-30_001).toISOString(),settled:false});
      await Promise.allSettled([this.actionsTransport?.cancel(input.actionsRunId, retainedTestingTarget(current.fleetDispatch?.target))]);
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
    // Cleanup follows the exact durable completion; a failed return never changes its ACK.
    if (saved.fleetResourceReservation && this.rows.reconcileRecorderHost) void this.rows.reconcileRecorderHost(
      hostId, new Date(this.now()), undefined, undefined, undefined, jobId).catch(() =>
      recorderReturnLogger.warn({hostId, requestId: jobId}, 'Recorder return remains pending after completion'));
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
    if (this.rows === routineJobRepository && row.state === 'terminal') await exclusiveResources.reconcileFleetCancellation(jobId);
    if (!row.fleetCancellation && this.now() >= row.fleetDeadline.getTime() && (row.state !== 'terminal' ||
      !!row.fleetBinding && !row.dispatchCompletion && !row.hostRejection && !row.preparationCancellation && !row.preparationRejection)) {
      phase('cancellation'); await this.cancel(jobId, {reason: 'Routine job reached its three-hour deadline'}, phase);
      phase('request'); row = await this.job(jobId);
    }
    phase('result'); let result: unknown;
    if (row.fleetBinding) try {result = await this.results.detail(jobId);}
    catch (error) {if (!(error instanceof TestRunError) || error.status !== 404) throw error;}
    phase('projection'); let reason = (!row.runId && row.publicationFailure ? `Publication failed: ${row.publicationFailure.message}` : undefined) ?? row.fleetCancellation?.reason ?? row.fleetPreparationStatus?.reason ?? row.fleetDispatch?.error ?? row.hostCancellation?.reason ?? row.preparationCancellation?.reason ??
      row.hostRejection?.reason ?? row.preparationRejection?.reason ?? row.preparation?.reason;
    if (!reason && row.state === 'awaiting-runner' && row.fleetResourceAdmission && !row.fleetBinding)
      reason = sharedResourceWaitingReason(row, await this.hosts.list?.().catch(() => []) ?? []);
    return {jobId, kind: 'run' as const, inputSha256: row.fleetInputSha256 ?? row.fleetSelectionSha256,
      deadline: row.fleetDeadline.toISOString(), state: row.fleetCancellation && !row.fleetBinding ? 'terminal' : row.state,
      ...(row.fleetBinding ? {binding: row.fleetBinding, ...(row.inputSha256 ? {boundInputSha256: row.inputSha256} : {})} : {}),
      actionsRuns: row.fleetActions ?? [], ...(row.fleetActionsCancellation ? {actionsCancellation:row.fleetActionsCancellation} : {}), ...(reason ? {waitingReason: reason} : {}),
      terminal: !row.fleetBinding ? row.state === 'terminal' || !!row.fleetCancellation
        : acknowledgedTerminalCancellation(row) || !!row.hostRejection || !!row.preparationCancellation || !!row.preparationRejection || !!row.dispatchCompletion && row.state === 'terminal',
      ...(row.dispatchCompletion ? {cleanupDisposition: row.dispatchCompletion.disposition, dispatchCompletion: row.dispatchCompletion} : {}),
      ...(row.terminalStatus ? {terminalStatus: row.terminalStatus} : row.fleetCancellation && !row.fleetBinding ? {terminalStatus: 'not-run'} : {}),
      ...(result ? {result} : {})};
  }
}

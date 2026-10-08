import {frameworkIdentitySchema, frameworkRequestInputSchema} from "../types/framework-request.types";
import {TestRunError} from "./test-result-error";
import {testWriteConcern} from "../models/test-write-concern";
import {createHash} from "node:crypto";
import {TestRequestModel} from "../models/test-request.model";
import {z} from "zod";
import {CandidateVerificationService, type CandidateAuthorization} from './candidate-verification.service';
import {RoutineDefinitionModel} from '../models/routine-definition.model';
import {routineDispatchIntentSchema, preparationStatusSchema, preparationRejectionSchema, type RoutineDispatchIntent} from '../types/routine-dispatch.types';
import {hostRequestDeliveryFilter, hostCancellationDeliveryFilter} from './test-request-activity';

export type RequestState = "queued" | "accepted" | "running" | "terminal";
export interface HostAcceptance {
  requestId: string;
  inputSha256: string;
  hostId: string;
  acceptedAt: string;
}
export const hostRejectionSchema = z.object({requestId: frameworkIdentitySchema, hostId: frameworkIdentitySchema,
  inputSha256: z.string().regex(/^[a-f0-9]{64}$/), rejectedAt: z.string().datetime({offset: true}),
  code: frameworkIdentitySchema, reason: z.string().min(1).max(2000)}).strict();
export type HostRejection = z.infer<typeof hostRejectionSchema>;
export const hostCancellationSchema = z.object({requestId: frameworkIdentitySchema, hostId: frameworkIdentitySchema,
  inputSha256: z.string().regex(/^[a-f0-9]{64}$/), requestedAt: z.string().datetime({offset: true}),
  reason: z.string().min(1).max(2000)}).strict();
export type HostCancellation = z.infer<typeof hostCancellationSchema>;
type QueueCursor = {createdAt: Date; requestId: string};
type CancellationCursor = {requestedAt: string; requestId: string};
export interface StoredTestRequest {
  requestId: string;
  inputSha256: string;
  input: unknown;
  hostId: string;
  state: RequestState;
  hostReceipt?: HostAcceptance;
  hostRejection?: HostRejection;
  hostCancellation?: HostCancellation;
  cancellationAcknowledged?: boolean;
  runId?: string;
  terminalStatus?: string;
  createdAt?: Date;
  catalogEligible?: boolean;
  dispatchIntent?: RoutineDispatchIntent;
  dispatchIntentSha256?: string;
}
export interface StoredPreparingRequest {
  requestId: string; hostId: string; state: 'preparing' | 'terminal';
  dispatchIntent: RoutineDispatchIntent; dispatchIntentSha256: string;
  input?: never; inputSha256?: never; hostReceipt?: never; hostRejection?: never; hostCancellation?: never;
  runId?: never; cancellationAcknowledged?: never; catalogEligible?: never;
  terminalStatus?: string; createdAt?: Date;
  preparation?: {code: string; reason: string; observedAt: string};
  preparationCancellation?: {requestedAt: string; reason: string};
  preparationRejection?: z.infer<typeof preparationRejectionSchema>;
}
export type StoredRequest = StoredTestRequest | StoredPreparingRequest;
export const isExecutableRequest = (row: StoredRequest): row is StoredTestRequest => typeof row.inputSha256 === 'string' && row.input !== undefined;
export interface TestRequestRepository {
  insert(request: StoredTestRequest): Promise<void>;
  get(requestId: string): Promise<StoredRequest | null>;
  accept(receipt: HostAcceptance): Promise<StoredTestRequest | null>;
  reject(receipt: HostRejection): Promise<StoredTestRequest | null>;
  cancel(receipt: HostCancellation): Promise<StoredTestRequest | null>;
  acknowledgeCancellation(receipt: HostCancellation): Promise<StoredTestRequest | null>;
  queued(hostId: string, after: QueueCursor | null, limit: number): Promise<StoredTestRequest[]>;
  cancellations(hostId: string, after: CancellationCursor | null, limit: number): Promise<StoredTestRequest[]>;
  insertPreparation?(request: StoredPreparingRequest): Promise<void>;
  preparations?(hostId: string, limit: number): Promise<StoredPreparingRequest[]>;
  completePreparation?(requestId: string, hostId: string, intentSha256: string, input: unknown, inputSha256: string): Promise<StoredTestRequest | null>;
  updatePreparation?(requestId: string, hostId: string, intentSha256: string, value: StoredPreparingRequest['preparation']): Promise<StoredPreparingRequest | null>;
  cancelPreparation?(requestId: string, intentSha256: string, value: NonNullable<StoredPreparingRequest['preparationCancellation']>): Promise<StoredPreparingRequest | null>;
  pendingDispatchCompletions?(hostId: string, limit: number): Promise<StoredTestRequest[]>;
  cancelFleet?(requestId: string, selectionSha256: string, value: {requestedAt: string; reason: string}): Promise<StoredRequest | null>;
  rejectPreparation?(requestId: string, hostId: string, intentSha256: string, value: NonNullable<StoredPreparingRequest['preparationRejection']>): Promise<StoredPreparingRequest | null>;
}
export class TestRequestConflict extends Error {}

/** Sort object keys before hashing: transport formatting cannot change identity. */
export function requestInputDigest(input: unknown): string {
  const canonical = (value: unknown): unknown => {
    if (value === null || typeof value === "boolean" || typeof value === "string") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (Array.isArray(value)) return value.map(canonical);
    if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype)
      return Object.fromEntries(Object.keys(value as object).sort().map(key => [key, canonical((value as Record<string, unknown>)[key])]));
    throw new TestRequestConflict("Request input must be finite JSON");
  };
  return createHash("sha256").update(JSON.stringify(canonical(input))).digest("hex");
}

const mongoRepository: TestRequestRepository = {
  async insert(request) {await TestRequestModel.create([request], {writeConcern: testWriteConcern});},
  async get(requestId) {return await TestRequestModel.findOne({requestId}).read("primary").readConcern("majority").lean() as StoredRequest | null;},
  async insertPreparation(request) {await TestRequestModel.create([request], {writeConcern: testWriteConcern});},
  async preparations(hostId, limit) {
    const rows = await TestRequestModel.find({hostId, state: 'preparing'}).sort({preparationCheckedAt: 1, createdAt: 1, requestId: 1})
      .limit(limit).read('primary').readConcern('majority').lean() as unknown as StoredPreparingRequest[];
    if (rows.length) await TestRequestModel.updateMany({hostId, state: 'preparing', requestId: {$in: rows.map(row => row.requestId)}},
      {$set: {preparationCheckedAt: new Date()}}, {writeConcern: testWriteConcern});
    return rows;
  },
  async completePreparation(requestId, hostId, dispatchIntentSha256, input, inputSha256) {
    // Mongoose immutable fields stay protected for every ordinary update. This one guarded transition fills absent input once.
    return await TestRequestModel.collection.findOneAndUpdate({requestId, hostId, dispatchIntentSha256, state: 'preparing',
      input: {$exists: false}, inputSha256: {$exists: false}, preparationCancellation: {$exists: false}, preparationRejection: {$exists: false}, fleetCancellation: {$exists: false}},
      {$set: {state: 'queued', input, inputSha256, updatedAt: new Date()}, $unset: {preparation: '', preparationCheckedAt: ''}},
      {returnDocument: 'after', writeConcern: testWriteConcern}) as unknown as StoredTestRequest | null;
  },
  async updatePreparation(requestId, hostId, dispatchIntentSha256, preparation) {
    return await TestRequestModel.findOneAndUpdate({requestId, hostId, dispatchIntentSha256, state: 'preparing'},
      {$set: {preparation}}, {new: true, writeConcern: testWriteConcern}).lean() as unknown as StoredPreparingRequest | null;
  },
  async cancelPreparation(requestId, dispatchIntentSha256, preparationCancellation) {
    return await TestRequestModel.findOneAndUpdate({requestId, dispatchIntentSha256, state: 'preparing', input: {$exists: false}},
      {$set: {state: 'terminal', terminalStatus: 'cancelled', preparationCancellation}},
      {new: true, writeConcern: testWriteConcern}).lean() as unknown as StoredPreparingRequest | null;
  },
  async rejectPreparation(requestId, hostId, dispatchIntentSha256, preparationRejection) {
    return await TestRequestModel.findOneAndUpdate({requestId, hostId, dispatchIntentSha256, state: 'preparing', input: {$exists: false}},
      {$set: {state: 'terminal', terminalStatus: 'not-run', preparationRejection}},
      {new: true, writeConcern: testWriteConcern}).lean() as unknown as StoredPreparingRequest | null;
  },
  async pendingDispatchCompletions(hostId, limit) {
    return await TestRequestModel.find({hostId, fleetBinding: {$exists: true}, dispatchCompletion: {$exists: false},
      inputSha256: {$exists: true}}).sort({createdAt: 1, requestId: 1}).limit(limit)
      .read('primary').readConcern('majority').lean() as StoredTestRequest[];
  },
  async cancelFleet(requestId, fleetSelectionSha256, fleetCancellation) {
    const identity = {requestId, fleetSelectionSha256, fleetCancellation: {$exists: false}};
    const unbound = await TestRequestModel.collection.findOneAndUpdate({...identity, fleetBinding: {$exists: false}},
      {$set: {fleetCancellation, state: 'terminal', terminalStatus: 'not-run', updatedAt: new Date()}},
      {returnDocument: 'after', writeConcern: testWriteConcern});
    if (unbound) return unbound as unknown as StoredRequest;
    return await TestRequestModel.collection.findOneAndUpdate(identity, [{$set: {fleetCancellation: {$literal: fleetCancellation}, updatedAt: new Date(),
      state: {$cond: [{$and: [{$ne: [{$type: '$dispatchCompletion'}, 'missing']}, {$ne: ['$state', 'terminal']}]}, 'terminal', '$state']},
      terminalStatus: {$cond: [{$and: [{$ne: [{$type: '$dispatchCompletion'}, 'missing']}, {$ne: ['$state', 'terminal']}]}, 'cancelled', '$terminalStatus']}}}],
      {returnDocument: 'after', writeConcern: testWriteConcern}) as unknown as StoredRequest | null;
  },
  async accept(receipt) {
    const accepted = await TestRequestModel.findOneAndUpdate({requestId: receipt.requestId, inputSha256: receipt.inputSha256,
      hostId: receipt.hostId, state: "queued", hostReceipt: {$exists: false}, hostRejection: {$exists: false}, fleetCancellation: {$exists: false}},
    {$set: {state: "accepted", hostReceipt: receipt}}, {new: true, writeConcern: testWriteConcern}).lean() as StoredTestRequest | null;
    if (accepted) return accepted;
    // Local admission may commit before Core receives its receipt. Preserve cancellation while recording that custody.
    return await TestRequestModel.findOneAndUpdate({requestId: receipt.requestId, inputSha256: receipt.inputSha256,
      hostId: receipt.hostId, state: "terminal", terminalStatus: "cancelled", hostReceipt: {$exists: false},
      hostRejection: {$exists: false}, "hostCancellation.requestId": receipt.requestId,
      "hostCancellation.hostId": receipt.hostId, "hostCancellation.inputSha256": receipt.inputSha256},
    {$set: {hostReceipt: receipt}}, {new: true, writeConcern: testWriteConcern}).lean() as StoredTestRequest | null;
  },
  async reject(receipt) {
    return await TestRequestModel.findOneAndUpdate({requestId: receipt.requestId, inputSha256: receipt.inputSha256,
      hostId: receipt.hostId, state: "queued", hostReceipt: {$exists: false}, hostRejection: {$exists: false}},
    {$set: {state: "terminal", terminalStatus: "not-run", hostRejection: receipt}},
    {new: true, writeConcern: testWriteConcern}).lean() as StoredTestRequest | null;
  },
  async cancel(receipt) {
    const identity = {requestId: receipt.requestId, hostId: receipt.hostId, inputSha256: receipt.inputSha256,
      hostCancellation: {$exists: false}};
    const queued = await TestRequestModel.findOneAndUpdate({...identity, state: "queued", hostReceipt: {$exists: false}},
      {$set: {state: "terminal", terminalStatus: "cancelled", hostCancellation: receipt}},
      {new: true, writeConcern: testWriteConcern}).lean() as StoredTestRequest | null;
    if (queued) return queued;
    return await TestRequestModel.findOneAndUpdate({...identity, state: {$in: ["accepted", "running"]}},
      {$set: {hostCancellation: receipt}}, {new: true, writeConcern: testWriteConcern}).lean() as StoredTestRequest | null;
  },
  async acknowledgeCancellation(receipt) {
    return await TestRequestModel.findOneAndUpdate({requestId: receipt.requestId, hostId: receipt.hostId,
      inputSha256: receipt.inputSha256, hostCancellation: receipt}, {$set: {cancellationAcknowledged: true}},
    {new: true, writeConcern: testWriteConcern}).lean() as StoredTestRequest | null;
  },
  async queued(hostId, after, limit) {
    const filter = {...hostRequestDeliveryFilter(hostId), ...(after ? {$or: [
      {createdAt: {$gt: after.createdAt}},
      {createdAt: after.createdAt, requestId: {$gt: after.requestId}},
    ]} : {})};
    return await TestRequestModel.find(filter).sort({createdAt: 1, requestId: 1}).limit(limit).lean() as StoredTestRequest[];
  },
  async cancellations(hostId, after, limit) {
    return await TestRequestModel.find({hostId, ...hostCancellationDeliveryFilter(),
      ...(after ? {$or: [{"hostCancellation.requestedAt": {$gt: after.requestedAt}},
        {"hostCancellation.requestedAt": after.requestedAt, requestId: {$gt: after.requestId}}]} : {})})
      .sort({"hostCancellation.requestedAt": 1, requestId: 1}).limit(limit).read("primary").readConcern("majority").lean() as StoredTestRequest[];
  },
};

const enrolledRequest = async (input: z.infer<typeof frameworkRequestInputSchema>) => {
  const row = await RoutineDefinitionModel.findOne({routineId: input.routineId, platform: input.platform,
    definitionRevision: input.definitionRevision}).read('primary').readConcern('majority').lean();
  const permitted = input.verification ? (row?.candidateBindings ?? []).some(value =>
    requestInputDigest(value) === requestInputDigest(input.verification)) : !!row?.ordinaryEnrolledAt;
  if (!row || !permitted) throw new TestRequestConflict('Request has no matching ordinary enrollment or candidate authorization');
  if (requestInputDigest(row.routineSource) !== requestInputDigest(input.routineSource))
    throw new TestRequestConflict('Request routine bundle differs from its enrolled immutable source');
};
export class TestRequestService {
  constructor(private readonly repository: TestRequestRepository = mongoRepository,
    private readonly candidates: CandidateAuthorization = new CandidateVerificationService(),
    private readonly enrolled: ((input: z.infer<typeof frameworkRequestInputSchema>) => Promise<void>) | null =
      repository === mongoRepository ? enrolledRequest : null) {}

  get(requestId: string) {return this.repository.get(requestId);}

  async queued(hostId: string, cursor: string | undefined, limit: number) {
    this.validatePageLimit(limit);
    const parsed = this.decodeCursor(hostId, cursor, "createdAt");
    const after = parsed ? {createdAt: new Date(parsed.timestamp), requestId: parsed.requestId} : null;
    const found = await this.repository.queued(hostId, after, limit + 1), requests = found.slice(0, limit), last = requests.at(-1);
    const dispatchCompletions = (await this.repository.pendingDispatchCompletions?.(hostId, limit) ?? []).map(row => ({
      requestId: row.requestId, hostId: row.hostId, inputSha256: row.inputSha256, laneId: (row.input as {laneId: string}).laneId}));
    const preparations = (await this.repository.preparations?.(hostId, limit) ?? []).map(row => ({requestId: row.requestId,
      hostId: row.hostId, dispatchIntentSha256: row.dispatchIntentSha256, dispatchIntent: row.dispatchIntent}));
    return {requests, preparations, dispatchCompletions, nextCursor: found.length > limit && last ? this.encodeCursor(hostId, last.requestId, "createdAt", last.createdAt!.toISOString()) : null};
  }
  async prepare(hostId: string, input: unknown): Promise<StoredRequest> {
    const intent = routineDispatchIntentSchema.parse(input);
    if (!frameworkIdentitySchema.safeParse(hostId).success) throw new TestRequestConflict('Assigned host identity is required');
    const request: StoredPreparingRequest = {requestId: intent.requestId, hostId, dispatchIntent: intent,
      dispatchIntentSha256: requestInputDigest(intent), state: 'preparing'};
    if (!this.repository.insertPreparation) throw new TestRunError(503, 'Request preparation storage is unavailable');
    try {await this.repository.insertPreparation(request); return request;}
    catch (error) {
      if ((error as {code?: number}).code !== 11000) throw error;
      const existing = await this.repository.get(request.requestId);
      if (!existing || existing.hostId !== hostId || existing.dispatchIntentSha256 !== request.dispatchIntentSha256)
        throw new TestRequestConflict('Request identity already belongs to a different dispatch intent or host');
      return existing;
    }
  }
  /** Retain cancellation even if the first source-preparation insert is still in flight. */
  async cancelPreparationSubmission(requestId: string, hostId: string, input: unknown, requestedAt: string, reason: string): Promise<StoredRequest> {
    const intent = routineDispatchIntentSchema.parse(input);
    if (intent.requestId !== requestId || !frameworkIdentitySchema.safeParse(hostId).success)
      throw new TestRequestConflict('Cancellation differs from its assigned request identity');
    const value = z.object({requestedAt: z.string().datetime({offset: true}), reason: z.string().min(1).max(2000)}).strict().parse({requestedAt, reason});
    const row: StoredPreparingRequest = {requestId, hostId, dispatchIntent: intent, dispatchIntentSha256: requestInputDigest(intent),
      state: 'terminal', terminalStatus: 'cancelled', preparationCancellation: value};
    if (!this.repository.insertPreparation) throw new TestRunError(503, 'Request preparation storage is unavailable');
    try {await this.repository.insertPreparation(row); return row;}
    catch (error) {if ((error as {code?: number}).code !== 11000) throw error;}
    const existing = await this.preparation(requestId, hostId, row.dispatchIntentSha256);
    return await this.cancel(requestId, requestedAt, reason) ?? existing;
  }
  async preparation(requestId: string, hostId: string, intentSha256?: string) {
    const row = await this.repository.get(requestId);
    if (!row || row.hostId !== hostId) throw new TestRunError(404, 'Assigned routine request was not found');
    if (!row.dispatchIntent || requestInputDigest(row.dispatchIntent) !== row.dispatchIntentSha256 ||
      intentSha256 && row.dispatchIntentSha256 !== intentSha256)
      throw new TestRequestConflict('Preparation differs from the immutable dispatch intent');
    return row;
  }
  async completePreparation(requestId: string, hostId: string, intentSha256: string, input: unknown): Promise<StoredRequest> {
    const row = await this.preparation(requestId, hostId, intentSha256), intent = row.dispatchIntent!;
    const frozen = frameworkRequestInputSchema.parse(input), digest = requestInputDigest(frozen);
    if (frozen.routineId !== intent.routineId || frozen.platform !== intent.platform || frozen.definitionRevision !== intent.routineRevision ||
      frozen.laneId !== intent.laneId || frozen.minimumFrameworkVersion !== intent.minimumFrameworkVersion ||
      requestInputDigest(frozen.build) !== requestInputDigest(intent.build) || intent.routineSource && requestInputDigest(frozen.routineSource) !== requestInputDigest(intent.routineSource))
      throw new TestRequestConflict('Prepared executable input contradicts its original dispatch intent');
    if (isExecutableRequest(row)) {
      if (row.inputSha256 !== digest) throw new TestRequestConflict('Prepared executable input changed after its first commit');
      return row;
    }
    if (row.state !== 'preparing') return row;
    await this.enrolled?.(frozen);
    if (!this.repository.completePreparation) throw new TestRunError(503, 'Request preparation storage is unavailable');
    const saved = await this.repository.completePreparation(requestId, hostId, intentSha256, frozen, digest) ??
      await this.preparation(requestId, hostId, intentSha256);
    if (isExecutableRequest(saved) && saved.inputSha256 !== digest)
      throw new TestRequestConflict('Prepared executable input changed after its first commit');
    return saved;
  }
  async preparationStatus(requestId: string, hostId: string, input: unknown): Promise<StoredRequest> {
    const value = preparationStatusSchema.parse(input), row = await this.preparation(requestId, hostId, value.dispatchIntentSha256);
    if (row.state !== 'preparing') return row;
    if (!this.repository.updatePreparation) throw new TestRunError(503, 'Request preparation storage is unavailable');
    return await this.repository.updatePreparation(requestId, hostId, value.dispatchIntentSha256,
      {code: value.code, reason: value.reason, observedAt: value.observedAt}) ?? await this.preparation(requestId, hostId, value.dispatchIntentSha256);
  }
  async rejectPreparation(requestId: string, hostId: string, input: unknown): Promise<StoredRequest> {
    const value = preparationRejectionSchema.parse(input), row = await this.preparation(requestId, hostId, value.dispatchIntentSha256);
    if (!isExecutableRequest(row) && row.preparationRejection && requestInputDigest(row.preparationRejection) !== requestInputDigest(value))
      throw new TestRequestConflict('Preparation rejection changed its original receipt');
    if (row.state !== 'preparing') return row;
    if (!this.repository.rejectPreparation) throw new TestRunError(503, 'Request preparation storage is unavailable');
    const saved = await this.repository.rejectPreparation(requestId, hostId, value.dispatchIntentSha256, value) ??
      await this.preparation(requestId, hostId, value.dispatchIntentSha256);
    if (!isExecutableRequest(saved) && saved.preparationRejection && requestInputDigest(saved.preparationRejection) !== requestInputDigest(value))
      throw new TestRequestConflict('Preparation rejection changed its original receipt');
    return saved;
  }
  async cancellations(hostId: string, cursor: string | undefined, limit: number) {
    this.validatePageLimit(limit);
    const parsed = this.decodeCursor(hostId, cursor, "requestedAt");
    const after = parsed ? {requestedAt: parsed.timestamp, requestId: parsed.requestId} : null;
    const found = await this.repository.cancellations(hostId, after, limit + 1), requests = found.slice(0, limit), last = requests.at(-1);
    return {requests, nextCursor: found.length > limit && last ? this.encodeCursor(hostId, last.requestId, "requestedAt", last.hostCancellation!.requestedAt) : null};
  }
  private validatePageLimit(limit: number) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new TestRequestConflict("Page limit must be between 1 and 100");
  }
  private decodeCursor(hostId: string, cursor: string | undefined, field: "createdAt" | "requestedAt") {
    if (!cursor) return null;
    try {
      const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
      if (parsed.hostId !== hostId || !frameworkIdentitySchema.safeParse(parsed.requestId).success
        || !z.string().datetime({offset: true}).safeParse(parsed[field]).success) throw new Error("invalid");
      return {timestamp: new Date(parsed[field]).toISOString(), requestId: parsed.requestId as string};
    } catch {throw new TestRequestConflict(field === "createdAt" ? "Invalid host queue cursor" : "Invalid host cancellation cursor");}
  }
  private encodeCursor(hostId: string, requestId: string, field: "createdAt" | "requestedAt", timestamp: string) {
    return Buffer.from(JSON.stringify({hostId, requestId, [field]: timestamp})).toString("base64url");
  }

  private submission(requestId: string, hostId: string, input: unknown): StoredTestRequest {
    if (!frameworkIdentitySchema.safeParse(requestId).success || !frameworkIdentitySchema.safeParse(hostId).success) throw new TestRequestConflict("Request and assigned host identities are required");
    if (!frameworkRequestInputSchema.safeParse(input).success) throw new TestRunError(400, "Invalid framework request input");
    const inputSha256 = requestInputDigest(input);
    const selected = frameworkRequestInputSchema.parse(input), exactSource = selected.build.source;
    const intent = !selected.verification && selected.build.channel !== 'local' ? routineDispatchIntentSchema.parse({requestId, routineId: selected.routineId, platform: selected.platform,
      routineRevision: selected.definitionRevision, routineSource: selected.routineSource, laneId: selected.laneId,
      source: exactSource, build: selected.build, ...(selected.minimumFrameworkVersion !== undefined ? {minimumFrameworkVersion: selected.minimumFrameworkVersion} : {})}) : undefined;
    return {requestId, hostId, input, inputSha256, state: "queued", ...(intent ? {dispatchIntent: intent, dispatchIntentSha256: requestInputDigest(intent)} : {}),
      ...(frameworkRequestInputSchema.parse(input).verification ? {catalogEligible: false} : {})};
  }

  async submit(requestId: string, hostId: string, input: unknown, authenticatedHostId?: string): Promise<StoredTestRequest> {
    const request = this.submission(requestId, hostId, input);
    const selected = frameworkRequestInputSchema.parse(input);
    await this.enrolled?.(selected);
    if (selected.verification) {
      if (authenticatedHostId !== hostId) throw new TestRequestConflict('Candidate admission requires the authenticated assigned host');
      await this.candidates.authorize(selected.verification, authenticatedHostId, selected);
    }
    try {await this.repository.insert(request); return request;}
    catch (error) {
      // Only duplicate identity is recoverable; outages must not become acceptance.
      if ((error as {code?: number}).code !== 11000) throw error;
      const existing = await this.repository.get(requestId);
      if (!existing || !isExecutableRequest(existing) || existing.inputSha256 !== request.inputSha256 || existing.hostId !== hostId)
        throw new TestRequestConflict("Request identity already belongs to different inputs or host");
      return existing;
    }
  }

  /** Fence a frozen submission even when its concurrent insert has not become visible yet. */
  async cancelSubmission(requestId: string, hostId: string, input: unknown, requestedAt: string, reason: string): Promise<StoredTestRequest> {
    const request = this.submission(requestId, hostId, input);
    const parsed = hostCancellationSchema.parse({requestId, hostId, inputSha256: request.inputSha256, requestedAt, reason});
    const hostCancellation = {...parsed, requestedAt: new Date(parsed.requestedAt).toISOString()};
    const cancelled: StoredTestRequest = {...request, state: "terminal", terminalStatus: "cancelled", hostCancellation};
    // The unique request ID arbitrates admission and cancellation in the same durable store.
    // A later queued insert cannot replace this terminal record, including after a process restart.
    try {await this.repository.insert(cancelled); return cancelled;}
    catch (error) {if ((error as {code?: number}).code !== 11000) throw error;}
    const existing = await this.repository.get(requestId);
    if (!existing || !isExecutableRequest(existing) || existing.hostId !== hostId || existing.inputSha256 !== request.inputSha256
      || requestInputDigest(existing.input) !== request.inputSha256)
      throw new TestRequestConflict("Cancellation submission differs from the original inputs or host");
    const saved = await this.cancel(requestId, hostCancellation.requestedAt, reason);
    if (!saved || !isExecutableRequest(saved) || saved.state !== "terminal" && !saved.hostCancellation)
      throw new TestRunError(503, "Cancellation submission was not retained");
    return saved;
  }

  /** Publish a host's already committed local admission; this never dispatches work. */
  async registerLocal(input: unknown, receipt: HostAcceptance, authenticatedHostId: string): Promise<StoredTestRequest> {
    if (!frameworkRequestInputSchema.safeParse(input).success) throw new TestRunError(400, "Invalid framework request input");
    if (!frameworkIdentitySchema.safeParse(receipt.requestId).success || !frameworkIdentitySchema.safeParse(receipt.hostId).success || receipt.hostId !== authenticatedHostId || !Number.isFinite(Date.parse(receipt.acceptedAt))
      || requestInputDigest(input) !== receipt.inputSha256)
      throw new TestRequestConflict("Local acceptance must match the authenticated host and immutable input");
    const selected = frameworkRequestInputSchema.parse(input);
    const original = await this.repository.get(receipt.requestId);
    if (!original) {
      await this.enrolled?.(selected);
      if (selected.verification) await this.candidates.authorize(selected.verification, authenticatedHostId, selected);
    }
    const row: StoredTestRequest = {requestId: receipt.requestId, hostId: authenticatedHostId, input,
      inputSha256: receipt.inputSha256, state: "accepted", hostReceipt: receipt,
      ...(selected.verification ? {catalogEligible: false} : {})};
    try {await this.repository.insert(row); return row;}
    catch (error) {
      if ((error as {code?: number}).code !== 11000) throw error;
      const existing = await this.repository.get(receipt.requestId);
      if (!existing || !isExecutableRequest(existing) || existing.hostId !== authenticatedHostId || existing.inputSha256 !== receipt.inputSha256
        || !existing.hostReceipt || existing.hostReceipt.acceptedAt !== receipt.acceptedAt)
        throw new TestRequestConflict("Local request conflicts with an existing admission");
      return existing;
    }
  }

  async accept(receipt: HostAcceptance, authenticatedHostId: string): Promise<StoredTestRequest> {
    if (!frameworkIdentitySchema.safeParse(receipt.requestId).success || !frameworkIdentitySchema.safeParse(receipt.hostId).success || receipt.hostId !== authenticatedHostId || !Number.isFinite(Date.parse(receipt.acceptedAt)))
      throw new TestRequestConflict("Acceptance must identify the authenticated host and its local commit time");
    const accepted = await this.repository.accept(receipt);
    if (accepted) return accepted;
    const existing = await this.repository.get(receipt.requestId);
    if (!existing || !isExecutableRequest(existing) || existing.inputSha256 !== receipt.inputSha256 || existing.hostId !== authenticatedHostId || !existing.hostReceipt
      || requestInputDigest(existing.hostReceipt) !== requestInputDigest(receipt))
      throw new TestRequestConflict("Request is missing, changed, or has not been accepted by this host");
    // Lost acknowledgements return the original receipt, never another execution.
    return existing;
  }

  /** An impossible delivery remains a terminal request receipt, never a fabricated routine run. */
  async reject(input: unknown, authenticatedHostId: string): Promise<StoredTestRequest> {
    const parsed = hostRejectionSchema.safeParse(input);
    if (!parsed.success || parsed.data.hostId !== authenticatedHostId)
      throw new TestRequestConflict("Rejection must identify the authenticated host and its immutable receipt");
    const receipt = parsed.data, existing = await this.repository.get(receipt.requestId);
    if (!existing || !isExecutableRequest(existing) || existing.hostId !== authenticatedHostId || existing.inputSha256 !== receipt.inputSha256
      || requestInputDigest(existing.input) !== receipt.inputSha256)
      throw new TestRequestConflict("Rejection does not match the original request host and immutable input");
    const original = (row: StoredRequest | null) => {
      if (!row || !isExecutableRequest(row) || row.state !== "terminal" || row.terminalStatus !== "not-run" || !row.hostRejection
        || requestInputDigest(row.hostRejection) !== requestInputDigest(receipt))
        throw new TestRequestConflict("Request is already accepted or has a different terminal rejection");
      return row;
    };
    if (existing.hostRejection) return original(existing);
    if (existing.state !== "queued" || existing.hostReceipt)
      throw new TestRequestConflict("Only an unaccepted queued request can be rejected");
    return await this.repository.reject(receipt) ?? original(await this.repository.get(receipt.requestId));
  }

  async cancel(requestId: string, requestedAt: string, reason: string): Promise<StoredRequest | null> {
    let row = await this.repository.get(requestId);
    if (!row) return null;
    const fleet = row as StoredRequest & {fleetSelectionSha256?: string; fleetBinding?: unknown; fleetCancellation?: {requestedAt: string; reason: string}};
    if (fleet.fleetSelectionSha256 && !fleet.fleetCancellation) {
      if (!this.repository.cancelFleet) throw new TestRunError(503, 'Fleet cancellation storage is unavailable');
      const value = z.object({requestedAt: z.string().datetime({offset: true}), reason: z.string().min(1).max(2000)}).strict().parse({requestedAt, reason});
      row = await this.repository.cancelFleet(requestId, fleet.fleetSelectionSha256, value) ?? await this.repository.get(requestId);
      if (!row) return null;
      if (!(row as typeof fleet).fleetBinding) return row;
    }
    if (row.hostCancellation || row.state === "terminal") return row;
    if (!isExecutableRequest(row)) {
      const value = z.object({requestedAt: z.string().datetime({offset: true}), reason: z.string().min(1).max(2000)}).strict().parse({requestedAt, reason});
      if (!this.repository.cancelPreparation) throw new TestRunError(503, 'Request preparation storage is unavailable');
      const saved = await this.repository.cancelPreparation(requestId, row.dispatchIntentSha256, value);
      if (saved) return saved;
      const winner = await this.repository.get(requestId);
      return winner && isExecutableRequest(winner) ? this.cancel(requestId, requestedAt, reason) : winner;
    }
    const parsed = hostCancellationSchema.parse({requestId, hostId: row.hostId, inputSha256: row.inputSha256, requestedAt, reason});
    const receipt = {...parsed, requestedAt: new Date(parsed.requestedAt).toISOString()};
    return await this.repository.cancel(receipt) ?? await this.repository.get(requestId);
  }
  /** Acknowledgement proves the host accepted cooperative cancellation, not that writers or cleanup settled. */
  async acknowledgeCancellation(input: unknown, authenticatedHostId: string): Promise<StoredTestRequest> {
    const parsed = hostCancellationSchema.safeParse(input);
    if (!parsed.success || parsed.data.hostId !== authenticatedHostId)
      throw new TestRequestConflict("Cancellation must identify the authenticated host");
    const receipt = parsed.data, row = await this.repository.get(receipt.requestId);
    if (!row || !isExecutableRequest(row) || !row.hostCancellation || row.hostId !== authenticatedHostId || row.inputSha256 !== receipt.inputSha256
      || requestInputDigest(row.hostCancellation) !== requestInputDigest(receipt))
      throw new TestRequestConflict("Cancellation acknowledgement differs from the immutable intent");
    const saved = await this.repository.acknowledgeCancellation(row.hostCancellation);
    if (!saved) throw new TestRequestConflict("Cancellation intent changed before acknowledgement");
    return saved;
  }
}

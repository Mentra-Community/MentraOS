import {frameworkIdentitySchema, frameworkRequestInputSchema} from "../types/framework-request.types";
import {TestRunError} from "./test-result-error";
import {testWriteConcern} from "../models/test-write-concern";
import {createHash} from "node:crypto";
import {TestRequestModel} from "../models/test-request.model";
import {z} from "zod";
import {CandidateVerificationService, type CandidateAuthorization} from './candidate-verification.service';
import {RoutineDefinitionModel} from '../models/routine-definition.model';

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
}
export interface TestRequestRepository {
  insert(request: StoredTestRequest): Promise<void>;
  get(requestId: string): Promise<StoredTestRequest | null>;
  accept(receipt: HostAcceptance): Promise<StoredTestRequest | null>;
  reject(receipt: HostRejection): Promise<StoredTestRequest | null>;
  cancel(receipt: HostCancellation): Promise<StoredTestRequest | null>;
  acknowledgeCancellation(receipt: HostCancellation): Promise<StoredTestRequest | null>;
  queued(hostId: string, after: QueueCursor | null, limit: number): Promise<StoredTestRequest[]>;
  cancellations(hostId: string, after: CancellationCursor | null, limit: number): Promise<StoredTestRequest[]>;
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
  async get(requestId) {return await TestRequestModel.findOne({requestId}).read("primary").readConcern("majority").lean() as StoredTestRequest | null;},
  async accept(receipt) {
    const accepted = await TestRequestModel.findOneAndUpdate({requestId: receipt.requestId, inputSha256: receipt.inputSha256,
      hostId: receipt.hostId, state: "queued", hostReceipt: {$exists: false}, hostRejection: {$exists: false}},
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
    const filter = {hostId, state: "queued", ...(after ? {$or: [
      {createdAt: {$gt: after.createdAt}},
      {createdAt: after.createdAt, requestId: {$gt: after.requestId}},
    ]} : {})};
    return await TestRequestModel.find(filter).sort({createdAt: 1, requestId: 1}).limit(limit).lean() as StoredTestRequest[];
  },
  async cancellations(hostId, after, limit) {
    return await TestRequestModel.find({hostId, hostCancellation: {$exists: true}, cancellationAcknowledged: {$ne: true},
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
    return {requests, nextCursor: found.length > limit && last ? this.encodeCursor(hostId, last.requestId, "createdAt", last.createdAt!.toISOString()) : null};
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
    return {requestId, hostId, input, inputSha256, state: "queued",
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
      if (!existing || existing.inputSha256 !== request.inputSha256 || existing.hostId !== hostId)
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
    if (!existing || existing.hostId !== hostId || existing.inputSha256 !== request.inputSha256
      || requestInputDigest(existing.input) !== request.inputSha256)
      throw new TestRequestConflict("Cancellation submission differs from the original inputs or host");
    const saved = await this.cancel(requestId, hostCancellation.requestedAt, reason);
    if (!saved || saved.state !== "terminal" && !saved.hostCancellation)
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
      if (!existing || existing.hostId !== authenticatedHostId || existing.inputSha256 !== receipt.inputSha256
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
    if (!existing || existing.inputSha256 !== receipt.inputSha256 || existing.hostId !== authenticatedHostId || !existing.hostReceipt
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
    if (!existing || existing.hostId !== authenticatedHostId || existing.inputSha256 !== receipt.inputSha256
      || requestInputDigest(existing.input) !== receipt.inputSha256)
      throw new TestRequestConflict("Rejection does not match the original request host and immutable input");
    const original = (row: StoredTestRequest | null) => {
      if (!row || row.state !== "terminal" || row.terminalStatus !== "not-run" || !row.hostRejection
        || requestInputDigest(row.hostRejection) !== requestInputDigest(receipt))
        throw new TestRequestConflict("Request is already accepted or has a different terminal rejection");
      return row;
    };
    if (existing.hostRejection) return original(existing);
    if (existing.state !== "queued" || existing.hostReceipt)
      throw new TestRequestConflict("Only an unaccepted queued request can be rejected");
    return await this.repository.reject(receipt) ?? original(await this.repository.get(receipt.requestId));
  }

  async cancel(requestId: string, requestedAt: string, reason: string): Promise<StoredTestRequest | null> {
    const row = await this.repository.get(requestId);
    if (!row) return null;
    if (row.hostCancellation || row.state === "terminal") return row;
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
    if (!row?.hostCancellation || row.hostId !== authenticatedHostId || row.inputSha256 !== receipt.inputSha256
      || requestInputDigest(row.hostCancellation) !== requestInputDigest(receipt))
      throw new TestRequestConflict("Cancellation acknowledgement differs from the immutable intent");
    const saved = await this.repository.acknowledgeCancellation(row.hostCancellation);
    if (!saved) throw new TestRequestConflict("Cancellation intent changed before acknowledgement");
    return saved;
  }
}

import {createHash} from "node:crypto";
import {TestRequestModel} from "../models/test-request.model";

export type RequestState = "queued" | "accepted" | "running" | "terminal";
export interface HostAcceptance {
  requestId: string;
  inputSha256: string;
  hostId: string;
  acceptedAt: string;
}
export interface StoredTestRequest {
  requestId: string;
  inputSha256: string;
  input: unknown;
  hostId: string;
  state: RequestState;
  hostReceipt?: HostAcceptance;
  runId?: string;
  terminalStatus?: string;
  createdAt?: Date;
}
export interface TestRequestRepository {
  insert(request: StoredTestRequest): Promise<void>;
  get(requestId: string): Promise<StoredTestRequest | null>;
  accept(receipt: HostAcceptance): Promise<StoredTestRequest | null>;
  queued(hostId: string, after: {createdAt: Date; requestId: string} | null, limit: number): Promise<StoredTestRequest[]>;
}
export class TestRequestConflict extends Error {}

/** Sort object keys before hashing: transport formatting cannot change identity. */
export function requestInputDigest(input: unknown): string {
  const canonical = (value: unknown): string => {
    if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
    if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype)
      return `{${Object.keys(value as object).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
    throw new TestRequestConflict("Request input must be finite JSON");
  };
  return createHash("sha256").update(canonical(input)).digest("hex");
}

const mongoRepository: TestRequestRepository = {
  async insert(request) {await TestRequestModel.create(request);},
  async get(requestId) {return await TestRequestModel.findOne({requestId}).lean() as StoredTestRequest | null;},
  async accept(receipt) {
    return await TestRequestModel.findOneAndUpdate({requestId: receipt.requestId, inputSha256: receipt.inputSha256,
      hostId: receipt.hostId, state: "queued", hostReceipt: {$exists: false}},
    {$set: {state: "accepted", hostReceipt: receipt}}, {new: true}).lean() as StoredTestRequest | null;
  },
  async queued(hostId, after, limit) {
    const filter = {hostId, state: "queued", ...(after ? {$or: [
      {createdAt: {$gt: after.createdAt}},
      {createdAt: after.createdAt, requestId: {$gt: after.requestId}},
    ]} : {})};
    return await TestRequestModel.find(filter).sort({createdAt: 1, requestId: 1}).limit(limit).lean() as StoredTestRequest[];
  },
};

export class TestRequestService {
  constructor(private readonly repository: TestRequestRepository = mongoRepository) {}

  async queued(hostId: string, cursor: string | undefined, limit: number) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new TestRequestConflict("Page limit must be between 1 and 100");
    let after: {createdAt: Date; requestId: string} | null = null;
    if (cursor) {
      try {
        const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
        if (parsed.hostId !== hostId || typeof parsed.requestId !== "string" || !parsed.requestId
          || !Number.isFinite(Date.parse(parsed.createdAt))) throw new Error("invalid");
        after = {createdAt: new Date(parsed.createdAt), requestId: parsed.requestId};
      } catch {throw new TestRequestConflict("Invalid host queue cursor");}
    }
    const found = await this.repository.queued(hostId, after, limit + 1);
    const requests = found.slice(0, limit);
    const last = requests.at(-1);
    const nextCursor = found.length > limit && last ? Buffer.from(JSON.stringify({hostId,
      createdAt: last.createdAt, requestId: last.requestId})).toString("base64url") : null;
    return {requests, nextCursor};
  }

  async submit(requestId: string, hostId: string, input: unknown): Promise<StoredTestRequest> {
    if (!requestId || !hostId) throw new TestRequestConflict("Request and assigned host identities are required");
    const inputSha256 = requestInputDigest(input);
    const request: StoredTestRequest = {requestId, hostId, input, inputSha256, state: "queued"};
    try {await this.repository.insert(request); return request;}
    catch (error) {
      // Only duplicate identity is recoverable; outages must not become acceptance.
      if ((error as {code?: number}).code !== 11000) throw error;
      const existing = await this.repository.get(requestId);
      if (!existing || existing.inputSha256 !== inputSha256 || existing.hostId !== hostId)
        throw new TestRequestConflict("Request identity already belongs to different inputs or host");
      return existing;
    }
  }

  async accept(receipt: HostAcceptance, authenticatedHostId: string): Promise<StoredTestRequest> {
    if (receipt.hostId !== authenticatedHostId || !Number.isFinite(Date.parse(receipt.acceptedAt)))
      throw new TestRequestConflict("Acceptance must identify the authenticated host and its local commit time");
    const accepted = await this.repository.accept(receipt);
    if (accepted) return accepted;
    const existing = await this.repository.get(receipt.requestId);
    if (!existing || existing.inputSha256 !== receipt.inputSha256 || existing.hostId !== authenticatedHostId || !existing.hostReceipt)
      throw new TestRequestConflict("Request is missing, changed, or has not been accepted by this host");
    // Lost acknowledgements return the original receipt, never another execution.
    return existing;
  }
}

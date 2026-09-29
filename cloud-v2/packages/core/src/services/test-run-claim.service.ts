import { createHash, timingSafeEqual } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { TestRunClaimModel } from "../models/test-run-claim.model";
import { testRunIdSchema } from "../types/test-run.types";
import {
  testRunClaimCloseRequestSchema, testRunClaimRequestSchema, testRunClaimSettleRequestSchema,
  type TestRunClaim, type TestRunClaimCloseResponse, type TestRunClaimClosureRecord, type TestRunClaimResponse, type TestRunClaimSettlement,
  testRunProgressRequestSchema, type TestRunProgressCheckpoint, type TestRunProgressResponse,
} from "../types/test-run-claim.types";

export class TestRunClaimError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409, message: string) { super(message); }
}
export interface StoredTestRunClaim {
  claim: TestRunClaim; executionTokenSha256: string; progress?: TestRunProgressCheckpoint; closure?: TestRunClaimClosureRecord;
}
export interface TestRunClaimRepository {
  get(requestId: string): Promise<StoredTestRunClaim | null>;
  insert(value: StoredTestRunClaim): Promise<{ stored: StoredTestRunClaim; created: boolean }>;
  settle(requestId: string, tokenSha256: string, settlement: TestRunClaimSettlement, settledAt: string): Promise<StoredTestRunClaim>;
  progress(requestId: string, tokenSha256: string, value: TestRunProgressCheckpoint): Promise<{ stored: StoredTestRunClaim; updated: boolean }>;
  /** Adds the first closure to an unclosed recovery-required claim of this owner; otherwise returns the stored row. */
  close(requestId: string, tokenSha256: string, closure: TestRunClaimClosureRecord): Promise<StoredTestRunClaim>;
}

const writeConcern = { w: "majority" as const, j: true, wtimeout: 10_000 };
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const tokenMatches = (token: string, digest: string) => timingSafeEqual(Buffer.from(hash(token), "hex"), Buffer.from(digest, "hex"));
function requestId(value: string): string {
  const parsed = testRunIdSchema.safeParse(value);
  if (!parsed.success) throw new TestRunClaimError(400, "invalid request ID");
  return parsed.data;
}
function stored(row: { claim: unknown; executionTokenSha256: string; progress?: unknown; closure?: unknown }): StoredTestRunClaim {
  return { claim: row.claim as TestRunClaim, executionTokenSha256: row.executionTokenSha256,
    ...(row.progress ? { progress: row.progress as TestRunProgressCheckpoint } : {}),
    ...(row.closure ? { closure: row.closure as TestRunClaimClosureRecord } : {}) };
}

export class MongoTestRunClaimRepository implements TestRunClaimRepository {
  async get(id: string): Promise<StoredTestRunClaim | null> {
    const row = await TestRunClaimModel.findOne({ requestId: id }).read("primary").readConcern("majority").lean();
    return row ? stored(row) : null;
  }
  async insert(value: StoredTestRunClaim) {
    try {
      await TestRunClaimModel.create([{ requestId: value.claim.requestId, ...value }], { writeConcern });
      return { stored: value, created: true };
    } catch (error) {
      // An uncertain write is not converted into a successful grant by a later read.
      if ((error as { code?: number })?.code !== 11000) throw error;
      const existing = await this.get(value.claim.requestId);
      if (!existing) throw error;
      return { stored: existing, created: false };
    }
  }
  async settle(id: string, tokenSha256: string, settlement: TestRunClaimSettlement, settledAt: string) {
    const row = await TestRunClaimModel.findOneAndUpdate(
      { requestId: id, executionTokenSha256: tokenSha256, "claim.state": "claimed" },
      { $set: { "claim.state": settlement.state, "claim.settlement": settlement, "claim.settledAt": settledAt } },
      { new: true, writeConcern },
    ).lean();
    if (row) return stored(row);
    const existing = await this.get(id);
    if (!existing) throw new Error("Claim disappeared during settlement");
    return existing;
  }
  async progress(id: string, tokenSha256: string, value: TestRunProgressCheckpoint) {
    const row = await TestRunClaimModel.findOneAndUpdate({ requestId: id, executionTokenSha256: tokenSha256,
      "claim.state": { $in: value.mode === "running" ? ["claimed"] : ["claimed", "recovery-required"] },
      closure: { $exists: false },
      $or: [{ progress: { $exists: false } }, { "progress.sequence": { $lt: value.sequence } }],
    }, { $set: { progress: value } }, { new: true, writeConcern }).lean();
    if (row) return { stored: stored(row), updated: true };
    const existing = await this.get(id);
    if (!existing) throw new Error("Claim disappeared during progress update");
    return { stored: existing, updated: false };
  }
  async close(id: string, tokenSha256: string, closure: TestRunClaimClosureRecord) {
    const row = await TestRunClaimModel.findOneAndUpdate(
      { requestId: id, executionTokenSha256: tokenSha256, "claim.state": "recovery-required", closure: { $exists: false } },
      { $set: { closure } }, { new: true, writeConcern },
    ).lean();
    if (row) return stored(row);
    const existing = await this.get(id);
    if (!existing) throw new Error("Claim disappeared during closure");
    return existing;
  }
}

export class TestRunClaimService {
  constructor(private readonly repository: TestRunClaimRepository = new MongoTestRunClaimRepository()) {}

  async claim(input: unknown): Promise<TestRunClaimResponse> {
    const parsed = testRunClaimRequestSchema.safeParse(input);
    if (!parsed.success) throw new TestRunClaimError(400, "invalid claim request");
    const { executionToken, ...identity } = parsed.data;
    const result = await this.repository.insert({
      claim: { ...identity, state: "claimed", claimedAt: new Date().toISOString() },
      executionTokenSha256: hash(executionToken),
    });
    if (Object.entries(identity).some(([key, value]) => result.stored.claim[key as keyof typeof identity] !== value)
        || !tokenMatches(executionToken, result.stored.executionTokenSha256)) {
      throw new TestRunClaimError(409, "request ID already belongs to a different request or execution owner");
    }
    // Only the acknowledged insertion response grants execution, even to the same owner.
    return { executionGranted: result.created, claim: result.stored.claim };
  }

  async get(id: string): Promise<TestRunClaimResponse> {
    const value = await this.repository.get(requestId(id));
    if (!value) throw new TestRunClaimError(404, "claim not found; absence does not grant execution");
    return { executionGranted: false, claim: value.claim };
  }

  async settle(id: string, input: unknown): Promise<TestRunClaimResponse> {
    id = requestId(id);
    const parsed = testRunClaimSettleRequestSchema.safeParse(input);
    if (!parsed.success) throw new TestRunClaimError(400, "invalid settlement request");
    const { executionToken, settlement } = parsed.data;
    const before = await this.repository.get(id);
    if (!before) throw new TestRunClaimError(404, "claim not found");
    if (!tokenMatches(executionToken, before.executionTokenSha256)) throw new TestRunClaimError(403, "execution owner token required");
    const result = await this.repository.settle(id, before.executionTokenSha256, settlement, new Date().toISOString());
    if (JSON.stringify(result.claim.settlement) !== JSON.stringify(settlement)) {
      throw new TestRunClaimError(409, "claim already has a different immutable settlement");
    }
    return { executionGranted: false, claim: result.claim };
  }

  async progress(id: string, input: unknown): Promise<TestRunProgressResponse> {
    id = requestId(id);
    const parsed = testRunProgressRequestSchema.safeParse(input);
    if (!parsed.success) throw new TestRunClaimError(400, "invalid progress checkpoint");
    const { executionToken, ...projection } = parsed.data;
    const before = await this.repository.get(id);
    if (!before) throw new TestRunClaimError(404, "claim not found");
    if (!tokenMatches(executionToken, before.executionTokenSha256)) throw new TestRunClaimError(403, "execution owner token required");
    const current = before.progress;
    if ((!current || projection.sequence > current.sequence) && before.closure)
      throw new TestRunClaimError(409, "closed claim does not accept new routine progress");
    if ((!current || projection.sequence > current.sequence) && (before.claim.state === "terminal"
      || (before.claim.state === "recovery-required" && projection.mode === "running")))
      throw new TestRunClaimError(409, "settled claim does not accept new routine progress");
    const update = await this.repository.progress(id, before.executionTokenSha256,
      { ...projection, receivedAt: new Date().toISOString() });
    const result = update.stored;
    if (!result.progress || result.progress.sequence < projection.sequence)
      throw new TestRunClaimError(409, "claim settled before progress was recorded");
    const { receivedAt, ...saved } = result.progress;
    if (saved.sequence === projection.sequence && !isDeepStrictEqual(saved, projection))
      throw new TestRunClaimError(409, "journal sequence already has a different checkpoint");
    return { accepted: update.updated,
      sequence: saved.sequence, receivedAt };
  }

  /**
   * Records the original owner's append-only closure of a recovery-required claim.
   * The claim, settlement, token and progress are unchanged and no execution is
   * granted. Only the exact first closure is accepted again; it never certifies a
   * fixture or a result.
   */
  async close(id: string, input: unknown): Promise<TestRunClaimCloseResponse> {
    id = requestId(id);
    const parsed = testRunClaimCloseRequestSchema.safeParse(input);
    if (!parsed.success) throw new TestRunClaimError(400, "invalid closure request");
    const { executionToken, closure, ...identity } = parsed.data;
    const before = await this.repository.get(id);
    if (!before) throw new TestRunClaimError(404, "claim not found");
    if (!tokenMatches(executionToken, before.executionTokenSha256)) throw new TestRunClaimError(403, "execution owner token required");
    if (Object.entries(identity).some(([key, value]) => before.claim[key as keyof typeof identity] !== value))
      throw new TestRunClaimError(409, "closure identity differs from the original request, worker, fixture or execution");
    if (!before.closure && before.claim.state !== "recovery-required")
      throw new TestRunClaimError(409, "only a settled recovery-required claim can be closed");
    const result = before.closure ? before
      : await this.repository.close(id, before.executionTokenSha256, { ...closure, closedAt: new Date().toISOString() });
    const saved = result.closure;
    if (!saved) throw new TestRunClaimError(409, "claim state changed before closure was recorded");
    const { closedAt: _, ...frozen } = saved;
    if (!isDeepStrictEqual(frozen, closure)) throw new TestRunClaimError(409, "claim already has a different immutable closure");
    return { executionGranted: false, claim: result.claim, closure: saved };
  }
}

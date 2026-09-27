import { createHash } from "node:crypto";
import { z } from "zod";
import { TestRepairModel } from "../models/test-repair.model";
import { isOriginalCandidate, type ContinuationGrant } from "../types/test-continuation.types";
import { TEST_REPAIR_OPERATIONS, testRepairRequestSchema, testRepairStatusSchema, type TestRepairOperation,
  type TestRepairReceipt, type TestRepairView } from "../types/test-repair.types";
import { TestDispatchError } from "./test-builds.service";
import { requireContinuationLease } from "./test-continuation-lease";
import { acknowledgedCase } from "./test-continuation.service";
import { TestRunService } from "./test-run.service";

interface StoredRepair { inputSha256: string; receipt: TestRepairReceipt }
type SendOutcome = { state: "accepted" } | { state: "rejected"; reason: string };
export interface TestRepairRepository {
  get(repairId: string): Promise<StoredRepair | null>;
  insert(value: StoredRepair): Promise<{ stored: StoredRepair; created: boolean }>;
  /** Settles only a `sending` receipt; null records an unknown send outcome. */
  acknowledge(repairId: string, outcome: SendOutcome | null): Promise<TestRepairReceipt>;
}
const writeConcern = { w: "majority" as const, j: true, wtimeout: 10_000 };
const stored = (row: { inputSha256: string; receipt: unknown }): StoredRepair => ({ inputSha256: row.inputSha256, receipt: row.receipt as TestRepairReceipt });
export class MongoTestRepairRepository implements TestRepairRepository {
  async get(repairId: string) {
    const row = await TestRepairModel.findOne({ repairId }).read("primary").readConcern("majority").lean();
    return row ? stored(row) : null;
  }
  async insert(value: StoredRepair) {
    try {
      await TestRepairModel.create([{ repairId: value.receipt.repairId, ...value }], { writeConcern });
      return { stored: value, created: true };
    } catch (error) {
      if ((error as { code?: number })?.code !== 11000) throw error;
      const existing = await this.get(value.receipt.repairId);
      if (!existing) throw error;
      return { stored: existing, created: false };
    }
  }
  async acknowledge(repairId: string, outcome: SendOutcome | null) {
    const row = await TestRepairModel.findOneAndUpdate({ repairId, "receipt.sendState": "sending" }, { $set: {
      "receipt.sendState": outcome?.state ?? "unknown", ...(outcome?.state === "rejected" ? { "receipt.rejectionReason": outcome.reason } : {}),
    } }, { new: true, writeConcern }).lean();
    if (!row) throw new TestDispatchError(503, "Repair acknowledgement was not saved; reconcile before requesting another repair");
    return stored(row).receipt;
  }
}

/**
 * The owned private executor of the named repairs. Core never runs a repair itself and
 * has no fallback: without an executor for an operation, nothing is sent.
 */
export interface TestRepairExecutor {
  supports(operation: TestRepairOperation): boolean;
  /** At most one send per receipt. A throw leaves the outcome unknown; it is never resent. */
  submit(receipt: TestRepairReceipt): Promise<SendOutcome>;
  status(receipt: TestRepairReceipt): Promise<unknown>;
}
/**
 * No remotely invocable executor exists yet. Each private recovery is an operator-run
 * worker command with host-local run paths, and Day1 recovery additionally requires
 * isolated host maintenance. A private broker companion must provide this interface.
 */
export const absentTestRepairExecutor: TestRepairExecutor = {
  supports: () => false,
  submit: async () => { throw new TestDispatchError(501, "No owned repair executor is available"); },
  status: async () => { throw new TestDispatchError(501, "No owned repair executor is available"); },
};

const fail = (message: string): never => { throw new TestDispatchError(409, message); };
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Registered state repairs for one case occurrence: authenticated, deduplicated sends and executor status. Not a queue. */
export class TestRepairService {
  constructor(private readonly runs: Pick<TestRunService, "failureDetail"> = new TestRunService(),
    private readonly executor: TestRepairExecutor = absentTestRepairExecutor,
    private readonly repository: TestRepairRepository = new MongoTestRepairRepository(),
    private readonly checkLease: typeof requireContinuationLease = requireContinuationLease) {}

  async request(grant: ContinuationGrant, input: unknown): Promise<TestRepairView> {
    const request = testRepairRequestSchema.parse(input), candidate = grant.candidate;
    if (!isOriginalCandidate(candidate)) fail("A state repair is bound to the occurrence's original target");
    if (!grant.routineIds.includes(request.routineId)) fail("Routine is outside this capability");
    if (TEST_REPAIR_OPERATIONS[request.operation].routineId !== request.routineId) fail("This repair does not belong to the routine");
    const source = (await acknowledgedCase(this.runs, grant)).source!;
    if (source.repository !== candidate.repository || source.headSha !== candidate.headSha) fail("The original target differs from the recorded source");
    const binding: TestRepairReceipt["binding"] = { occurrenceId: grant.occurrenceId, agentRunId: grant.agentRunId, candidate,
      ...(grant.caseBinding ? { caseBinding: grant.caseBinding } : {}) };
    const inputSha256 = createHash("sha256").update(JSON.stringify({ request, binding })).digest("hex");
    const replay = (value: StoredRepair) => {
      this.bound(grant, value.receipt);
      if (value.inputSha256 !== inputSha256) fail("This operation ID already owns a different repair; reconcile it");
      return this.present(value.receipt);
    };
    const before = await this.repository.get(request.operationId);
    if (before) return replay(before);
    // The controller authenticates its own registered reservation of this exact operation under the live lease.
    await this.checkLease(grant, request.routineId, undefined, { operation: request.operation, operationId: request.operationId });
    // A missing capability sends nothing and does not burn the registered operation ID.
    if (!this.executor.supports(request.operation))
      throw new TestDispatchError(501, "No owned executor accepts this state repair; nothing was sent");
    const receipt: TestRepairReceipt = { repairId: request.operationId, request, binding, createdAt: new Date().toISOString(), sendState: "sending" };
    const inserted = await this.repository.insert({ inputSha256, receipt });
    if (!inserted.created) return replay(inserted.stored);
    let outcome: SendOutcome | null;
    try { outcome = await this.executor.submit(receipt); } catch { outcome = null; }
    // A failed database acknowledgement cannot authorize a second send.
    return this.present(await this.repository.acknowledge(receipt.repairId, outcome));
  }

  async detail(grant: ContinuationGrant, operationId: string): Promise<TestRepairView> {
    if (!z.string().uuid().safeParse(operationId).success) throw new TestDispatchError(400, "Invalid operation ID");
    await acknowledgedCase(this.runs, grant);
    const value = await this.repository.get(operationId);
    if (!value) throw new TestDispatchError(404, "Registered repair not found");
    this.bound(grant, value.receipt);
    return this.present(value.receipt);
  }

  /** Reads stay bound to the registering occurrence, anchor, original target and case binding. */
  private bound(grant: ContinuationGrant, receipt: TestRepairReceipt) {
    const binding = receipt.binding;
    if (binding.occurrenceId !== grant.occurrenceId || binding.agentRunId !== grant.agentRunId || !same(binding.candidate, grant.candidate)
      || !same(binding.caseBinding ?? null, grant.caseBinding ?? null) || !grant.routineIds.includes(receipt.request.routineId))
      throw new TestDispatchError(404, "Registered repair not found");
  }

  private async present(receipt: TestRepairReceipt): Promise<TestRepairView> {
    const base = { repairId: receipt.repairId, operation: receipt.request.operation };
    if (receipt.sendState === "rejected") return { ...base, state: "rejected",
      message: `The executor rejected this repair: ${receipt.rejectionReason ?? "no reason was given"}. Nothing ran.` };
    if (receipt.sendState !== "accepted") return { ...base, state: receipt.sendState,
      message: "The send outcome is not confirmed. It is never resent; keep this operation ID and reconcile before any other repair." };
    let raw: unknown;
    try { raw = await this.executor.status(receipt); }
    catch { return { ...base, state: "accepted", message: "Accepted; the executor's current status is unavailable. Refresh later." }; }
    const parsed = testRepairStatusSchema.safeParse(raw);
    if (!parsed.success) throw new TestDispatchError(502, "Repair executor status is malformed");
    const status = parsed.data;
    // Only the executor's own passing check makes a repair complete. Nothing is inferred or filled in here.
    if (status.state === "completed" && (!status.owner || status.evidence?.check.passed !== true))
      throw new TestDispatchError(502, "Repair executor reported completion without its owner and a passing check");
    return { ...base, ...status, message: status.state === "completed" ? "Completed with the executor's passing check."
      : ["failed", "rejected"].includes(status.state) ? "Ended without a repaired state. The original failure is unchanged."
      : "Not finished. Another repair must wait until this one is resolved." };
  }
}

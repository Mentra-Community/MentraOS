import { createHash } from "node:crypto";
import { z } from "zod";
import { TestDispatchModel } from "../models/test-dispatch.model";
import { TestRunClaimModel } from "../models/test-run-claim.model";
import { testDispatchInputSchema, type TestDispatchReceipt, type TestDispatchView } from "../types/test-dispatch.types";
import { GithubTestBuildGateway, TestDispatchError, type TestBuildGateway } from "./test-builds.service";
import { TestRunService } from "./test-run.service";

interface StoredDispatch { inputSha256: string; receipt: TestDispatchReceipt }
interface ClaimState { state: string; resultRunId?: string }
interface ResultState { runId: string; requestId: string; outcome: string; outcomes: Record<string, string>; provenance: Record<string, string> }
export interface TestDispatchRepository {
  get(id: string): Promise<StoredDispatch | null>;
  recent(): Promise<TestDispatchReceipt[]>;
  insert(value: StoredDispatch): Promise<{ stored: StoredDispatch; created: boolean }>;
  acknowledge(id: string, response: { requestRunId: number; requestUrl: string } | null): Promise<TestDispatchReceipt>;
  claim(requestId: string): Promise<ClaimState | null>;
  result(runId: string): Promise<ResultState>;
}
const writeConcern = { w: "majority" as const, j: true, wtimeout: 10_000 };
const receipt = (row: { inputSha256: string; receipt: unknown }): StoredDispatch => ({
  inputSha256: row.inputSha256, receipt: row.receipt as TestDispatchReceipt,
});
export class MongoTestDispatchRepository implements TestDispatchRepository {
  async get(id: string) {
    const row = await TestDispatchModel.findOne({ dispatchId: id }).read("primary").readConcern("majority").lean();
    return row ? receipt(row) : null;
  }
  async recent() {
    const rows = await TestDispatchModel.find().sort({ "receipt.createdAt": -1 }).limit(25).lean();
    return rows.map(row => receipt(row).receipt);
  }
  async insert(value: StoredDispatch) {
    try {
      await TestDispatchModel.create([{ dispatchId: value.receipt.dispatchId, ...value }], { writeConcern });
      return { stored: value, created: true };
    } catch (error) {
      if ((error as { code?: number })?.code !== 11000) throw error;
      const existing = await this.get(value.receipt.dispatchId);
      if (!existing) throw error;
      return { stored: existing, created: false };
    }
  }
  async acknowledge(id: string, response: { requestRunId: number; requestUrl: string } | null) {
    const row = await TestDispatchModel.findOneAndUpdate({ dispatchId: id, "receipt.sendState": "sending" },
      { $set: { "receipt.sendState": response ? "accepted" : "unknown", ...(response ? {
        "receipt.requestRunId": response.requestRunId, "receipt.requestUrl": response.requestUrl,
      } : {}) } }, { new: true, writeConcern }).lean();
    if (!row) throw new TestDispatchError(503, "Dispatch acknowledgement was not saved; reconcile before sending another request");
    return receipt(row).receipt;
  }
  async claim(requestId: string): Promise<ClaimState | null> {
    const row = await TestRunClaimModel.findOne({ requestId }).lean();
    if (!row) return null;
    const value = row.claim as { state: string; settlement?: { resultRunId?: string } };
    return { state: value.state, resultRunId: value.settlement?.resultRunId };
  }
  async result(runId: string) { return new TestRunService().detail(runId); }
}

/** One acknowledged sending insert permits one send. Replays only read the saved receipt. */
export class TestDispatchService {
  constructor(private readonly repository: TestDispatchRepository = new MongoTestDispatchRepository(),
    private readonly github: TestBuildGateway = new GithubTestBuildGateway()) {}

  async create(input: unknown, requestedBy: string): Promise<TestDispatchView> {
    const parsed = testDispatchInputSchema.safeParse(input);
    if (!parsed.success || !requestedBy) throw new TestDispatchError(400, "Invalid routine dispatch request");
    const data = parsed.data;
    const inputSha256 = createHash("sha256").update(JSON.stringify({ input: data, requestedBy })).digest("hex");
    const dispatchId = data.idempotencyKey;
    const replay = (stored: StoredDispatch) => {
      if (stored.inputSha256 !== inputSha256) throw new TestDispatchError(409, "Submission ID already belongs to a different request");
      return this.present(stored.receipt);
    };
    const before = await this.repository.get(dispatchId);
    if (before) return replay(before);
    let rejectionReason: string | undefined;
    try {
      const build = await this.github.resolve(data.source);
      if (build.availability !== "available" || build.archive?.sha256 !== data.archiveSha256)
        throw new TestDispatchError(409, build.reason ?? "Selected build changed or is unavailable; refresh the build list");
      const routine = build.routines.find(item => item.id === data.routineId);
      if (!routine?.available) throw new TestDispatchError(409, routine?.reason ?? "This routine is not compatible with the selected build");
    } catch (error) {
      if (!(error instanceof TestDispatchError) || ![400, 404, 409].includes(error.status)) throw error;
      rejectionReason = error.message;
    }
    const value: TestDispatchReceipt = { dispatchId, input: data, requestedBy, createdAt: new Date().toISOString(),
      sendState: rejectionReason === undefined ? "sending" : "rejected", ...(rejectionReason === undefined ? {} : { rejectionReason }) };
    // Rejection must own the same unique ID as sending. A concurrent validator
    // may already have sent; only the stored winner can authorize a new request.
    const inserted = await this.repository.insert({ inputSha256, receipt: value });
    if (!inserted.created) return replay(inserted.stored);
    if (value.sendState === "rejected") return this.present(value);
    let response;
    try { response = await this.github.dispatch(data); }
    catch {
      return this.present(await this.repository.acknowledge(dispatchId, null));
    }
    // A failed database acknowledgement cannot authorize a second external send.
    return this.present(await this.repository.acknowledge(dispatchId, response));
  }
  async list() { return { dispatches: await this.repository.recent() }; }
  async detail(id: string) {
    if (!z.string().uuid().safeParse(id).success) throw new TestDispatchError(400, "Invalid dispatch ID");
    const stored = await this.repository.get(id);
    if (!stored) throw new TestDispatchError(404, "Routine request not found");
    return this.present(stored.receipt);
  }
  private async present(value: TestDispatchReceipt): Promise<TestDispatchView> {
    if (value.sendState === "rejected") return { ...value, state: "unavailable",
      message: `Request was not sent: ${value.rejectionReason ?? "The selected build is unavailable"}. Choose New request to refresh the build selection.` };
    if (value.sendState !== "accepted" || !value.requestRunId) return { ...value, state: "unknown",
      message: "Submission is in progress or its acknowledgement is unknown. Keep this submission ID; do not send a replacement until reconciled." };
    const source = value.input.source;
    const requestId = `routine-${value.requestRunId}-1-${source.channel === "pr" ? source.prNumber : source.channel}-${value.input.routineId}`;
    const claim = await this.repository.claim(requestId);
    if (claim?.state === "recovery-required") return { ...value, requestId, state: "recovery-required",
      message: "The worker retained this fixture for recovery. Review the worker evidence before reuse." };
    if (claim?.state === "terminal" && claim.resultRunId) {
      const result = await this.repository.result(claim.resultRunId);
      if (result.requestId !== requestId || result.provenance.archiveSha256 !== value.input.archiveSha256)
        throw new TestDispatchError(409, "Recorded result does not match the requested build");
      return { ...value, requestId, state: "finished", message: "The recorded result is available. Test, teardown and evidence verdicts are shown separately.",
        result: { runId: result.runId, outcome: result.outcome, outcomes: result.outcomes, reportPath: `/?testRun=${result.runId}` } };
    }
    try {
      const progress = await this.github.progress(value.requestRunId, value.input);
      return { ...value, ...progress };
    } catch {
      return { ...value, requestId, state: "unknown", message: "Current workflow status is unavailable. The saved request is unchanged; refresh to check again." };
    }
  }
}

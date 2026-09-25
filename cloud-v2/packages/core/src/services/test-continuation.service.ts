import { createHash } from "node:crypto";
import { z } from "zod";
import { TestRunModel } from "../models/test-run.model";
import { TestDispatchModel } from "../models/test-dispatch.model";
import { TestRunClaimModel } from "../models/test-run-claim.model";
import type { TestRunClaim } from "../types/test-run-claim.types";
import { continuationRequestSchema, type ContinuationGrant, type TestContinuationBinding } from "../types/test-continuation.types";
import { testRoutineIdSchema, type TestDispatchReceipt, type TestDispatchInput, type TestRoutineId } from "../types/test-dispatch.types";
import { TestDispatchService } from "./test-dispatch.service";
import { GithubTestBuildGateway, TestDispatchError, type TestBuildGateway } from "./test-builds.service";
import { GithubContinuationSource, type ContinuationSourceGateway } from "./test-continuation.github";
import { requireContinuationLease } from "./test-continuation-lease";
import { TestRunService } from "./test-run.service";
import { recoveredClaim } from "./test-run-overview.service";

type Runs = Pick<TestRunService, "failureDetail" | "detail" | "failureMedia">;
export interface ContinuationRepository {
  list(grant: ContinuationGrant): Promise<TestDispatchReceipt[]>;
  results(requestId: string): Promise<string[]>;
  claim(requestId: string): Promise<TestRunClaim | null>;
}
class MongoContinuationRepository implements ContinuationRepository {
  async claim(requestId: string) {
    const row = await TestRunClaimModel.findOne({ requestId }).select({ claim: 1 }).lean();
    return row ? row.claim as TestRunClaim : null;
  }
  async results(requestId: string) {
    const rows = await TestRunModel.find({ requestId }).sort({ startedAt: 1, runId: 1 }).limit(21).select({ runId: 1 }).lean();
    if (rows.length > 20) throw new TestDispatchError(409, "Recorded result history exceeds the continuation bound");
    return rows.map(row => row.runId);
  }
  async list(grant: ContinuationGrant) {
    const rows = await TestDispatchModel.find({ "receipt.continuation.occurrenceId": grant.occurrenceId,
      "receipt.continuation.agentRunId": grant.agentRunId,
      "receipt.continuation.candidate.repository": grant.candidate.repository,
      "receipt.continuation.candidate.pullRequest": grant.candidate.pullRequest,
      "receipt.continuation.candidate.headSha": grant.candidate.headSha }).sort({ "receipt.createdAt": 1, dispatchId: 1 }).limit(100).lean();
    return rows.map(row => row.receipt as TestDispatchReceipt);
  }
}
export function continuationOperationId(grant: ContinuationGrant, routineId: TestRoutineId): string {
  const digest = createHash("sha256").update(JSON.stringify([grant.occurrenceId, grant.agentRunId, grant.candidate.repository,
    grant.candidate.pullRequest, grant.candidate.headSha, routineId, grant.executionAttempt])).digest("hex");
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}
const fail = (message: string): never => { throw new TestDispatchError(409, message); };
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Case-bound continuation over the existing dispatcher/claims. This is not a queue. */
export class TestContinuationService {
  constructor(private readonly runs: Runs = new TestRunService(),
    private readonly dispatch = new TestDispatchService(),
    private readonly builds: TestBuildGateway = new GithubTestBuildGateway(),
    private readonly source: ContinuationSourceGateway = new GithubContinuationSource(),
    private readonly repository: ContinuationRepository = new MongoContinuationRepository(),
    private readonly checkLease = requireContinuationLease) {}
  private async case(grant: ContinuationGrant) {
    const packet = await this.runs.failureDetail(grant.occurrenceId);
    if (packet.occurrenceId !== grant.occurrenceId || packet.sourceStatus !== "recorded" || !packet.source
      || packet.delivery.state !== "acknowledged" || packet.delivery.agentRunId !== grant.agentRunId)
      fail("Recorded source and acknowledged case ownership are required");
    return packet;
  }
  private routine(grant: ContinuationGrant, routine: unknown): TestRoutineId {
    const id = testRoutineIdSchema.parse(routine);
    if (!grant.routineIds.includes(id)) fail("Routine is outside this capability");
    return id;
  }
  async inventory(grant: ContinuationGrant, routine: unknown) {
    const routineId = this.routine(grant, routine), packet = await this.case(grant);
    const target = await this.source.target(packet, grant, routineId);
    const builds = await this.builds.inventory({ ...target.query, routineId });
    return { candidate: grant.candidate, builds: builds.filter(build => build.headSha === target.expectedHeadSha),
      expectedHeadSha: target.expectedHeadSha, ...(target.expectedHarnessSha ? { expectedHarnessSha: target.expectedHarnessSha } : {}) };
  }
  async request(grant: ContinuationGrant, input: unknown) {
    const { executionAttempt, retryReason, ...data } = continuationRequestSchema.parse(input), routineId = this.routine(grant, data.routineId);
    if (executionAttempt !== grant.executionAttempt) fail("Execution attempt differs from the capability");
    const packet = await this.case(grant), idempotencyKey = continuationOperationId(grant, routineId);
    const saved = await this.dispatch.receipt(idempotencyKey);
    if (saved) {
      this.bound(grant, saved);
      if (!same(saved.input, { ...data, idempotencyKey }) || saved.continuation?.executionAttempt !== executionAttempt
        || saved.continuation.retryReason !== retryReason) fail("This candidate/routine already owns a different build request; reconcile it");
      return this.acknowledgement(grant, idempotencyKey);
    }
    const excludeRequestRunIds: number[] = [];
    if (executionAttempt > 1) {
      const previousId = continuationOperationId({ ...grant, executionAttempt: executionAttempt - 1 }, routineId);
      const previous = await this.detail(grant, previousId);
      if (!previous.verifiedRecovery) fail("Additional execution requires a completed request with verified fixture cleanup");
      if (previous.requestRunId) excludeRequestRunIds.push(previous.requestRunId);
    }
    await this.checkLease(grant, routineId);
    const target = await this.source.target(packet, grant, routineId);
    if (data.source.channel !== target.query.channel
      || (data.source.channel === "pr" && data.source.prNumber !== target.query.pr)) fail("Build is outside the candidate source");
    const build = await this.builds.resolve(data.source, routineId);
    if (build.headSha !== target.expectedHeadSha || build.archive?.sha256 !== data.archiveSha256 || build.availability !== "available")
      fail("Published build does not match the candidate");
    const binding: TestContinuationBinding = { occurrenceId: grant.occurrenceId, agentRunId: grant.agentRunId,
      candidate: grant.candidate, ...(grant.caseBinding ? { caseBinding: grant.caseBinding } : {}), executionAttempt, ...(retryReason ? { retryReason } : {}), expectedHeadSha: target.expectedHeadSha,
      ...(target.expectedHarnessSha ? { expectedHarnessSha: target.expectedHarnessSha } : {}) };
    const request: TestDispatchInput = { ...data, idempotencyKey };
    if (!this.builds.findExisting) throw new TestDispatchError(503, "Trusted request reconciliation is unavailable");
    const since = target.requestNotBefore && Date.parse(target.requestNotBefore) > Date.parse(build.createdAt)
      ? target.requestNotBefore : build.createdAt;
    const existing = await this.builds.findExisting(request, since, excludeRequestRunIds);
    if (!existing && target.automaticExpected && executionAttempt === 1)
      throw new TestDispatchError(503, "Waiting for the existing automatic request; no duplicate was sent");
    await this.dispatch.create(request, `routine-fixer:${grant.agentRunId}`, binding, existing ?? undefined, () => this.checkLease(grant, routineId));
    return this.acknowledgement(grant, idempotencyKey);
  }
  /** POST acknowledges only the send. Results always require the read endpoint. */
  private async acknowledgement(grant: ContinuationGrant, operationId: string) {
    const receipt = await this.dispatch.receipt(operationId);
    if (!receipt) throw new TestDispatchError(404, "Registered routine request not found");
    this.bound(grant, receipt);
    return { dispatchId: receipt.dispatchId, sendState: receipt.sendState,
      ...(receipt.requestRunId ? { requestRunId: receipt.requestRunId } : {}),
      ...(receipt.requestUrl ? { requestUrl: receipt.requestUrl } : {}),
      ...(receipt.adopted ? { adopted: true } : {}) };
  }
  /** Historical reads stay bound to the original occurrence, anchor, candidate and
   * (for an adopted shared candidate) the recorded case owner, not the current lease. */
  private bound(grant: ContinuationGrant, receipt: TestDispatchReceipt) {
    const binding = receipt.continuation;
    if (!binding || binding.occurrenceId !== grant.occurrenceId || binding.agentRunId !== grant.agentRunId
      || !same(binding.candidate, grant.candidate) || !same(binding.caseBinding ?? null, grant.caseBinding ?? null)
      || !grant.routineIds.includes(receipt.input.routineId))
      throw new TestDispatchError(404, "Registered routine request not found");
    return binding;
  }
  async list(grant: ContinuationGrant) {
    await this.case(grant);
    const receipts = await this.repository.list(grant);
    return { reruns: await Promise.all(receipts.filter(receipt => grant.routineIds.includes(receipt.input.routineId)
      && same(receipt.continuation?.caseBinding ?? null, grant.caseBinding ?? null))
      .map(receipt => this.detail(grant, receipt.dispatchId))) };
  }
  async detail(grant: ContinuationGrant, operationId: string) {
    await this.case(grant);
    if (!z.string().uuid().safeParse(operationId).success) throw new TestDispatchError(400, "Invalid operation ID");
    const receipt = await this.dispatch.receipt(operationId);
    if (!receipt) throw new TestDispatchError(404, "Registered routine request not found");
    const binding = this.bound(grant, receipt);
    const view = await this.dispatch.detail(operationId);
    const ids = view.requestId ? await this.repository.results(view.requestId) : [];
    if (view.result && !ids.includes(view.result.runId)) ids.push(view.result.runId);
    const results = await Promise.all(ids.map(async id => {
      const result = await this.runs.detail(id);
      if (result.requestId !== view.requestId || result.routineId !== receipt.input.routineId
        || result.provenance.archiveSha256 !== receipt.input.archiveSha256
        || (result.source?.headSha ?? result.provenance.headSha) !== binding.expectedHeadSha
        || (binding.expectedHarnessSha && (result.provenance.harnessSha ?? result.provenance.harnessRevision) !== binding.expectedHarnessSha))
        fail("Recorded result differs from the registered candidate, archive, routine or worker revision");
      return result;
    }));
    const claim = view.requestId ? await this.repository.claim(view.requestId) : null;
    const resolution = claim && claim.state !== "claimed" ? recoveredClaim(claim, results) : null;
    const verifiedRecovery = resolution && results.find(result => result.runId === resolution.recoveryRunId)?.outcomes.evidence === "complete"
      ? resolution : null;
    const recordedResults = results.map(result => ({ runId: result.runId, outcome: result.outcome, outcomes: result.outcomes,
        reportPath: `/?testRun=${result.runId}`, source: result.source ?? null, provenance: {
          headSha: binding.expectedHeadSha, archiveSha256: receipt.input.archiveSha256,
          ...(binding.expectedHarnessSha ? { harnessSha: binding.expectedHarnessSha } : {}) },
        failureOccurrenceIds: (result.failureOccurrences ?? []).map(item => item.occurrenceId) }));
    // A retained fixture can publish useful failed evidence. Preserve its
    // recovery-required state while returning every authenticated recorded result.
    return { ...view, recordedResults, verifiedRecovery };
  }
  async failure(grant: ContinuationGrant, operationId: string, occurrenceId: string) {
    const view = await this.detail(grant, operationId);
    if (!view.recordedResults.some(result => result.failureOccurrenceIds.includes(occurrenceId)))
      throw new TestDispatchError(404, "Failure is not part of this registered result");
    const packet = await this.runs.failureDetail(occurrenceId);
    return { ...packet, evidence: { ...packet.evidence, assets: packet.evidence.assets.map(asset => ({ ...asset,
      path: `/api/agent/test-failures/${grant.occurrenceId}/reruns/${operationId}/failures/${occurrenceId}/assets/${asset.assetId}` })) } };
  }
  async media(grant: ContinuationGrant, operationId: string, occurrenceId: string, assetId: string, request: Request) {
    await this.failure(grant, operationId, occurrenceId);
    return this.runs.failureMedia(occurrenceId, assetId, request);
  }
}

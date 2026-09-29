import { createHash } from "node:crypto";
import { z } from "zod";
import { TestDispatchModel } from "../models/test-dispatch.model";
import { continuationRequestSchema, isOriginalCandidate, type ContinuationGrant, type TestContinuationBinding } from "../types/test-continuation.types";
import { testRoutineIdSchema, type TestBuild, type TestBuildSource, type TestDispatchReceipt, type TestDispatchInput, type TestRoutineId } from "../types/test-dispatch.types";
import { TestDispatchService } from "./test-dispatch.service";
import { GithubTestBuildGateway, TestDispatchError, type TestBuildGateway } from "./test-builds.service";
import { GithubContinuationSource, type ContinuationSourceGateway, type ContinuationTarget } from "./test-continuation.github";
import { requireContinuationLease } from "./test-continuation-lease";
import { TestRunService } from "./test-run.service";
import { TestFailureIncidentService } from "./test-failure-incident.service";
import { MongoRegisteredResultRepository, registeredResults, type RegisteredResultRepository } from "./test-registered-results";

type Runs = Pick<TestRunService, "failureDetail" | "detail" | "failureMedia">;
type Incidents = Pick<TestFailureIncidentService, "metadata" | "artifact">;
export interface ContinuationRepository extends RegisteredResultRepository {
  list(grant: ContinuationGrant): Promise<TestDispatchReceipt[]>;
}
class MongoContinuationRepository extends MongoRegisteredResultRepository implements ContinuationRepository {
  async list(grant: ContinuationGrant) {
    const candidate = grant.candidate;
    const rows = await TestDispatchModel.find({ "receipt.continuation.occurrenceId": grant.occurrenceId,
      "receipt.continuation.agentRunId": grant.agentRunId,
      "receipt.continuation.candidate.repository": candidate.repository,
      ...(isOriginalCandidate(candidate) ? { "receipt.continuation.candidate.target": "original" }
        : { "receipt.continuation.candidate.pullRequest": candidate.pullRequest }),
      "receipt.continuation.candidate.headSha": candidate.headSha }).sort({ "receipt.createdAt": 1, dispatchId: 1 }).limit(100).lean();
    return rows.map(row => row.receipt as TestDispatchReceipt);
  }
}
/** Deterministic UUID-shaped identity; a registered replay recomputes the same ID. */
export function operationUuid(parts: unknown[]): string {
  const digest = createHash("sha256").update(JSON.stringify(parts)).digest("hex");
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}
/** Existing PR operation IDs are unchanged; the original target uses "original" in place of a PR number. */
export function continuationOperationId(grant: ContinuationGrant, routineId: TestRoutineId): string {
  const candidate = grant.candidate;
  return operationUuid([grant.occurrenceId, grant.agentRunId, candidate.repository,
    isOriginalCandidate(candidate) ? "original" : candidate.pullRequest, candidate.headSha, routineId, grant.executionAttempt]);
}
const fail = (message: string): never => { throw new TestDispatchError(409, message); };
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/** Read the grant's exact occurrence and immutable intake acknowledgement. For a
 * triaged recurrence, the continuation lease callback separately proves its editor. */
export async function acknowledgedCase(runs: Pick<Runs, "failureDetail">, grant: Pick<ContinuationGrant, "occurrenceId" | "agentRunId" | "acknowledgedAgentRunId">) {
  const packet = await runs.failureDetail(grant.occurrenceId);
  if (packet.occurrenceId !== grant.occurrenceId || !["recorded", "corrected"].includes(packet.sourceStatus) || !packet.source
    || packet.delivery.state !== "acknowledged" || packet.delivery.agentRunId !== (grant.acknowledgedAgentRunId ?? grant.agentRunId))
    fail("Recorded source and acknowledged case ownership are required");
  return packet;
}

/** Case-bound continuation over the existing dispatcher/claims. This is not a queue. */
export class TestContinuationService {
  constructor(private readonly runs: Runs = new TestRunService(),
    private readonly dispatch = new TestDispatchService(),
    private readonly builds: TestBuildGateway = new GithubTestBuildGateway(),
    private readonly source: ContinuationSourceGateway = new GithubContinuationSource(),
    private readonly repository: ContinuationRepository = new MongoContinuationRepository(),
    private readonly checkLease = requireContinuationLease,
    private readonly incidents: Incidents = new TestFailureIncidentService(runs)) {}
  private case(grant: ContinuationGrant) { return acknowledgedCase(this.runs, grant); }
  private routine(grant: ContinuationGrant, routine: unknown): TestRoutineId {
    const id = testRoutineIdSchema.parse(routine);
    if (!grant.routineIds.includes(id)) fail("Routine is outside this capability");
    return id;
  }
  async inventory(grant: ContinuationGrant, routine: unknown) {
    const routineId = this.routine(grant, routine), packet = await this.case(grant);
    const target = await this.source.target(packet, grant, routineId);
    if (target.localPublication) {
      const build = await this.recordedAppBuild(target, routineId);
      return { candidate: grant.candidate, builds: [build], expectedHeadSha: target.expectedHeadSha,
        expectedHarnessSha: target.expectedHarnessSha };
    }
    if (target.original) {
      // Exactly the recorded build, however old: never the newest listing or a current head.
      const selection = await this.originalSelection(target, routineId);
      const build = await this.originalBuild(selection.source, routineId, selection.source.channel === "pr" ? target.original.requestRunId : undefined);
      return { candidate: grant.candidate, builds: [build].filter(item => item.headSha === target.expectedHeadSha
          && item.archive?.sha256 === selection.archiveSha256), expectedHeadSha: target.expectedHeadSha };
    }
    const builds = await this.builds.inventory({ ...target.query, routineId });
    return { candidate: grant.candidate, builds: builds.filter(build => build.headSha === target.expectedHeadSha),
      expectedHeadSha: target.expectedHeadSha, ...(target.expectedHarnessSha ? { expectedHarnessSha: target.expectedHarnessSha } : {}) };
  }
  private recordedAppBuild(target: ContinuationTarget, routineId: TestRoutineId): Promise<TestBuild> {
    if (!this.builds.resolveRecordedApp) throw new TestDispatchError(503, "Recorded app publication verification is unavailable");
    return this.builds.resolveRecordedApp({ ...target.localPublication!, headSha: target.expectedHeadSha }, routineId);
  }
  /** The issuer's immutable selection for the original request, cross-checked with the recorded result. */
  private async originalSelection(target: ContinuationTarget, routineId: TestRoutineId) {
    if (!this.builds.originalSelection) throw new TestDispatchError(503, "Original build verification is unavailable");
    const selection = await this.builds.originalSelection(target.original!.requestRunId, routineId);
    if (selection.archiveSha256 !== target.original!.archiveSha256 || selection.headSha !== target.expectedHeadSha
      || selection.source.channel !== target.query.channel || (selection.source.channel === "pr" && selection.source.prNumber !== target.query.pr))
      fail("The original request differs from the recorded result");
    return selection;
  }
  /** The exact recorded build. A PR original resolves for its original request's recorded PR head/base,
   * so a later push, base advance, close or merge does not prevent its exact replay. */
  private async originalBuild(source: TestBuildSource, routineId: TestRoutineId, originalRequestRunId?: number): Promise<TestBuild> {
    let build: TestBuild;
    try { build = await this.builds.resolve(source, routineId, originalRequestRunId); }
    catch (error) {
      if (error instanceof TestDispatchError && error.status < 500) fail(`The original build can no longer be dispatched: ${error.message}`);
      throw error;
    }
    if (build.availability !== "available") fail(`The original build can no longer be dispatched: ${build.reason ?? "it is unavailable"}`);
    return build;
  }
  async request(grant: ContinuationGrant, input: unknown) {
    const { executionAttempt, retryReason, ...data } = continuationRequestSchema.parse(input), routineId = this.routine(grant, data.routineId);
    if (executionAttempt !== grant.executionAttempt) fail("Execution attempt differs from the capability");
    const packet = await this.case(grant), idempotencyKey = continuationOperationId(grant, routineId);
    const saved = await this.dispatch.receipt(idempotencyKey);
    if (saved) {
      this.bound(grant, saved);
      // The original request run is derived by Core from the bound packet, never supplied by the caller.
      const { originalRequestRunId: _derived, ...savedInput } = saved.input;
      if (!same(savedInput, { ...data, idempotencyKey }) || saved.continuation?.executionAttempt !== executionAttempt
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
    // The original target admits only the build its recorded request selected, never a caller-named,
    // rebuilt or newer one.
    if (target.original) {
      const selection = await this.originalSelection(target, routineId);
      if (!same(data.source, selection.source) || data.archiveSha256 !== selection.archiveSha256) fail("Build is not the original recorded artifact");
    }
    // A PR original is replayed by its request run through the trusted issuer, for its recorded PR identity.
    const originalRequestRunId = target.original && data.source.channel === "pr" ? target.original.requestRunId : undefined;
    const build = target.localPublication ? await this.recordedAppBuild(target, routineId)
      : target.original ? await this.originalBuild(data.source, routineId, originalRequestRunId) : await this.builds.resolve(data.source, routineId);
    if (target.localPublication && !same(data.source, build.source)) fail("Build is not the local test's recorded app publication");
    if (build.headSha !== target.expectedHeadSha || build.archive?.sha256 !== data.archiveSha256 || build.availability !== "available")
      fail(build.reason ?? "Published build does not match the candidate");
    const binding: TestContinuationBinding = { occurrenceId: grant.occurrenceId, agentRunId: grant.agentRunId,
      candidate: grant.candidate, ...(grant.caseBinding ? { caseBinding: grant.caseBinding } : {}),
      ...(grant.executionDestination ? { executionDestination: grant.executionDestination } : {}),
      executionAttempt, ...(retryReason ? { retryReason } : {}), expectedHeadSha: target.expectedHeadSha,
      ...(target.expectedHarnessSha ? { expectedHarnessSha: target.expectedHarnessSha } : {}) };
    const request: TestDispatchInput = { ...data, idempotencyKey, ...(originalRequestRunId !== undefined ? { originalRequestRunId } : {}) };
    if (!target.original && !target.expectedHarnessSha && !this.builds.findExisting) throw new TestDispatchError(503, "Trusted request reconciliation is unavailable");
    const since = target.requestNotBefore && Date.parse(target.requestNotBefore) > Date.parse(build.createdAt)
      ? target.requestNotBefore : build.createdAt;
    // Originals need a new execution; harness verification additionally needs its own
    // immutable private-revision fence. Older automatic requests have no such fence.
    const existing = target.original || target.expectedHarnessSha ? null : await this.builds.findExisting!(request, since, excludeRequestRunIds);
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
  /** Historical reads stay bound to the original occurrence, anchor, candidate,
   * (for an adopted shared candidate) the recorded case owner and (for a local
   * feature-branch source) the execution destination, not the current lease. */
  private bound(grant: ContinuationGrant, receipt: TestDispatchReceipt) {
    const binding = receipt.continuation;
    if (!binding || binding.occurrenceId !== grant.occurrenceId || binding.agentRunId !== grant.agentRunId
      || !same(binding.candidate, grant.candidate) || !same(binding.caseBinding ?? null, grant.caseBinding ?? null)
      || !same(binding.executionDestination ?? null, grant.executionDestination ?? null)
      || !grant.routineIds.includes(receipt.input.routineId))
      throw new TestDispatchError(404, "Registered routine request not found");
    return binding;
  }
  async list(grant: ContinuationGrant) {
    await this.case(grant);
    const receipts = await this.repository.list(grant);
    return { reruns: await Promise.all(receipts.filter(receipt => grant.routineIds.includes(receipt.input.routineId)
      && same(receipt.continuation?.caseBinding ?? null, grant.caseBinding ?? null)
      && same(receipt.continuation?.executionDestination ?? null, grant.executionDestination ?? null))
      .map(receipt => this.detail(grant, receipt.dispatchId))) };
  }
  async detail(grant: ContinuationGrant, operationId: string) {
    await this.case(grant);
    if (!z.string().uuid().safeParse(operationId).success) throw new TestDispatchError(400, "Invalid operation ID");
    const receipt = await this.dispatch.receipt(operationId);
    if (!receipt) throw new TestDispatchError(404, "Registered routine request not found");
    const binding = this.bound(grant, receipt);
    const view = await this.dispatch.detail(operationId);
    const { recordedResults, verifiedRecovery } = await registeredResults(view, { routineId: receipt.input.routineId,
      archiveSha256: receipt.input.archiveSha256, expectedHeadSha: binding.expectedHeadSha,
      ...(binding.expectedHarnessSha ? { expectedHarnessSha: binding.expectedHarnessSha } : {}) }, this.repository, this.runs);
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
  /** Registered result binding first; the incident service then checks exact incident membership. */
  async incident(grant: ContinuationGrant, operationId: string, occurrenceId: string, reportId: string) {
    await this.failure(grant, operationId, occurrenceId);
    return this.incidents.metadata(occurrenceId, reportId,
      `/api/agent/test-failures/${grant.occurrenceId}/reruns/${operationId}/failures/${occurrenceId}/incidents/${reportId}`);
  }
  async incidentArtifact(grant: ContinuationGrant, operationId: string, occurrenceId: string, reportId: string, artifactId: string, request: Request) {
    await this.failure(grant, operationId, occurrenceId);
    return this.incidents.artifact(occurrenceId, reportId, artifactId, request);
  }
}

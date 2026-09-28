import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { existingWorkRequestSchema, testExistingWorkBindingSchema, type ExistingWorkGrant,
  type TestExistingWorkBinding } from "../types/test-existing-work.types";
import { testBuildSourceSchema, testRoutineIdSchema, type TestBuild, type TestBuildSource, type TestDispatchReceipt,
  type TestDispatchView, type TestRoutineId } from "../types/test-dispatch.types";
import { boundBackendDeployment, type TestRun } from "../types/test-run.types";
import type { TestRunClaim } from "../types/test-run-claim.types";
import { GithubTestBuildGateway, TestDispatchError, type ExistingWorkBundleEvidence, type TestBuildGateway } from "./test-builds.service";
import { acknowledgedCase, operationUuid } from "./test-continuation.service";
import { TestDispatchService } from "./test-dispatch.service";
import { requireExistingWorkOperation, type ExistingWorkAuthority, type ExistingWorkOperation } from "./test-existing-work-authority";
import { MongoRegisteredResultRepository, registeredResults, type RegisteredResultRepository } from "./test-registered-results";
import { TestRunService } from "./test-run.service";

type Runs = Pick<TestRunService, "failureDetail" | "detail">;
const fail = (message: string): never => { throw new TestDispatchError(409, message); };
const notFound = (): never => { throw new TestDispatchError(404, "Registered verification request not found"); };
/** This leg's selection boundary, reported on every inventory so it is never read as general PR coverage. */
const SCOPE = { publications: "merged-dev-staging", pullRequestPublications: "unsupported" } as const;

/**
 * Frozen shared operation identity: exactly `["existing-work-verification-v1", bindingSha256,
 * schema-parsed TestBuildSource, archiveSha256, expectedHeadSha, routineId, verificationAttempt]`,
 * in the continuation UUID shape. The binding revision is excluded, so it never makes a new send.
 */
export function existingWorkOperationId(bindingSha256: string, source: TestBuildSource, archiveSha256: string,
  expectedHeadSha: string, routineId: string, verificationAttempt: 1): string {
  return operationUuid(["existing-work-verification-v1", bindingSha256, testBuildSourceSchema.parse(source),
    archiveSha256, expectedHeadSha, routineId, verificationAttempt]);
}

type Resolution = Awaited<ReturnType<typeof registeredResults>>["verifiedRecovery"];
type BackendRequirement = TestExistingWorkBinding["backendRequirement"];
export const MISSING_BACKEND_PROVENANCE = "missing-backend-provenance";
/**
 * A backend requirement is verified only by the `backendDeployment` projection of the exact result
 * that already passed the client gates below (this request's claimed, first-generation terminal
 * result), bound to that run, request and claim, and observing exactly the required repository
 * and merge commit. Request text, a merge, a ZIP, another result or a later deployment read never
 * qualify; a later descendant commit stays unverified in this first narrow producer.
 */
function backendVerdict(requirement: NonNullable<BackendRequirement>, result: TestRun | undefined, claim: TestRunClaim | null) {
  const unverified = (reason: string, message: string) => ({ required: true as const, requirement, state: "unverified" as const, reason, message });
  if (!result || !claim) return unverified("client-not-verified",
    "Backend proof is read only from this request's verified passing first-generation result.");
  const bound = boundBackendDeployment(result);
  if (!bound) return unverified(MISSING_BACKEND_PROVENANCE,
    "This result carries no run-bound backend deployment observation; a merge, ZIP, request text or current deployment read is not accepted.");
  if ("problem" in bound) return unverified("backend-proof-invalid", `Backend proof is refused: ${bound.problem}.`);
  const proof = bound.proof;
  // The proof's claim document hash is bound to the result above; the result's request hash must be
  // the registered claim's. The two hashes are distinct and never compared with each other.
  if (proof.runId !== result.runId || proof.requestId !== claim.requestId || result.provenance.requestSha256 !== claim.requestSha256)
    return unverified("backend-proof-invalid", "Backend proof is refused: it does not bind this request's registered claim.");
  if (proof.repository !== requirement.repository || proof.commitSha !== requirement.mergeCommitSha)
    return unverified("backend-commit-mismatch",
      "The observed backend is not exactly the required repository and merge commit; a different or later commit is not verified.");
  return { required: true as const, requirement, state: "verified" as const, resultRunId: result.runId, proof };
}
/**
 * Whether one registered request verified the existing fix. Only the claim's own terminal
 * result can pass, and only with a passing test, complete evidence and a verified return of
 * that first generation. A recovery generation, a retained fixture, a later result or any
 * other request never verifies. A backend requirement is verified only by that same result's
 * bound backend deployment projection; absent or legacy producers stay unverified.
 */
export function existingWorkVerification(view: Pick<TestDispatchView, "sendState" | "state">, results: TestRun[],
  claim: TestRunClaim | null, verifiedRecovery: Resolution, backendRequirement: TestExistingWorkBinding["backendRequirement"]) {
  const settled = claim?.state === "terminal" && claim.settlement.state === "terminal" ? claim.settlement.resultRunId : null;
  const result = settled ? results.find(item => item.runId === settled) : undefined;
  const client = view.sendState === "rejected" ? { state: "not-verified" as const, reason: "The request was not sent" }
    : claim?.state === "recovery-required" ? { state: "not-verified" as const, reason: "The worker retained the fixture for recovery; a retained fixture never verifies the fix" }
    : view.sendState !== "accepted" || !settled ? { state: "pending" as const, reason: "No terminal result is registered for this request yet" }
    : view.state !== "finished" || !result ? { state: "not-verified" as const, reason: "The terminal result is not this request's registered result" }
    : result.outcome !== "passed" || result.outcomes.test !== "passed" ? { state: "not-verified" as const, reason: "The registered result did not pass" }
    : result.outcomes.evidence !== "complete" ? { state: "not-verified" as const, reason: "The registered result's evidence is incomplete" }
    : verifiedRecovery?.kind === "recovery" ? { state: "not-verified" as const, reason: "Only a recovery generation verified the return; recovery never verifies the fix" }
    : verifiedRecovery?.kind !== "late-result" || verifiedRecovery.recoveryRunId !== result.runId
      ? { state: "not-verified" as const, reason: "The fixture return after this result was not verified" }
    : { state: "passed" as const, resultRunId: result.runId };
  const backend = backendRequirement === null ? { required: false as const }
    : backendVerdict(backendRequirement, client.state === "passed" ? result : undefined, claim);
  const state = client.state === "pending" ? "pending" as const
    : client.state === "passed" && (!backend.required || backend.state === "verified") ? "verified" as const : "unverified" as const;
  return { state, client, backend };
}

/**
 * Verification of an existing reviewed fix through the existing dispatcher. It is bound to one
 * acknowledged occurrence/agent run and one controller existing-work binding; there is no case,
 * candidate, lease, queue or adoption of another request.
 */
export class TestExistingWorkService {
  constructor(private readonly runs: Runs = new TestRunService(),
    private readonly dispatch = new TestDispatchService(),
    private readonly builds: TestBuildGateway = new GithubTestBuildGateway(),
    private readonly repository: RegisteredResultRepository = new MongoRegisteredResultRepository(),
    private readonly authority: ExistingWorkAuthority = requireExistingWorkOperation) {}

  /** The acknowledged occurrence, whose recorded routine is the only routine this binding verifies. */
  private async occurrence(grant: ExistingWorkGrant) {
    const packet = await acknowledgedCase(this.runs, grant);
    if (packet.routine.id !== grant.routineId) fail("Existing-work verification uses the occurrence's recorded routine");
    return packet;
  }
  /** A routine this Core does not register is unavailable; no other routine stands in for it. */
  private registered(grant: ExistingWorkGrant): TestRoutineId | null {
    const parsed = testRoutineIdSchema.safeParse(grant.routineId);
    return parsed.success ? parsed.data : null;
  }
  private unregistered(grant: ExistingWorkGrant) {
    return `Routine ${grant.routineId} is not registered on this Core; it is unavailable and no other routine is substituted`;
  }
  private async evidence(grant: ExistingWorkGrant, heads: string[]): Promise<ExistingWorkBundleEvidence> {
    if (!this.builds.existingWorkBundle) throw new TestDispatchError(503, "Bundle source verification is unavailable");
    return this.builds.existingWorkBundle(grant.bundle, heads);
  }
  /** Why a publication cannot verify this binding, or null when it carries the exact reviewed bundle. */
  private refusal(grant: ExistingWorkGrant, build: TestBuild, routineId: TestRoutineId, evidence: ExistingWorkBundleEvidence): string | null {
    const routine = build.routines.find(item => item.id === routineId), head = evidence.heads[build.headSha];
    if (build.availability !== "available" || !build.archive) return build.reason ?? "A verified published app build is required";
    if (!routine?.available) return routine?.reason ?? "This routine is not compatible with the selected build";
    if (!evidence.merged) return "GitHub does not record the bundling PR as merged into its base at the signed merge commit";
    if (!head?.containsMerge) return "This publication does not contain the bundling merge";
    if (head.artifactBlobSha !== grant.bundle.artifactBlobSha) return "This publication does not carry the reviewed miniapp artifact blob";
    return null;
  }

  async inventory(grant: ExistingWorkGrant) {
    await this.occurrence(grant);
    const base = { routineId: grant.routineId, scope: SCOPE, bundle: grant.bundle, backendRequirement: grant.backendRequirement };
    const routineId = this.registered(grant);
    if (!routineId) return { ...base, available: false, reason: this.unregistered(grant), builds: [] };
    const listed = await this.builds.inventory({ channel: grant.bundle.baseBranch, routineId });
    const evidence = await this.evidence(grant, listed.filter(build => build.availability === "available").map(build => build.headSha));
    return { ...base, available: true, builds: listed.map(build => {
      const reason = this.refusal(grant, build, routineId, evidence);
      return { ...build, existingWork: reason !== null ? { selectable: false, reason } : { selectable: true,
        operationId: existingWorkOperationId(grant.binding.sha256, build.source, build.archive!.sha256, build.headSha, routineId, 1) } };
    }) };
  }

  async request(grant: ExistingWorkGrant, input: unknown) {
    const data = existingWorkRequestSchema.parse(input);
    if (data.source.channel === "pr") throw new TestDispatchError(501,
      "Existing-work verification selects merged dev/staging publications only; PR publications are not supported yet");
    if (data.routineId !== grant.routineId) fail("Routine differs from the existing-work capability");
    if (data.verificationAttempt !== grant.verificationAttempt) fail("Verification attempt differs from the capability");
    if (data.source.channel !== grant.bundle.baseBranch) fail("Publication channel differs from the bundling PR base");
    await this.occurrence(grant);
    const routineId = this.registered(grant) ?? fail(this.unregistered(grant));
    // The authenticated publication, never the caller, names the head in the operation identity.
    const build = await this.builds.resolve(data.source, routineId);
    const operationId = existingWorkOperationId(grant.binding.sha256, data.source, data.archiveSha256, build.headSha, routineId, 1);
    const request = { source: data.source, routineId, archiveSha256: data.archiveSha256, idempotencyKey: operationId };
    const saved = await this.dispatch.receipt(operationId);
    if (saved) {
      // Replays read only; a changed bundle, backend requirement or grant identity is refused.
      if (!this.matches(grant, saved) || !isDeepStrictEqual(saved.input, request))
        fail("This operation already belongs to a different existing-work binding or request; reconcile it");
      return this.acknowledgement(grant, operationId);
    }
    if (build.archive?.sha256 !== data.archiveSha256) fail("Selected publication archive differs; refresh the build list");
    const reason = this.refusal(grant, build, routineId, await this.evidence(grant, [build.headSha]));
    if (reason !== null) fail(reason);
    const binding: TestExistingWorkBinding = { kind: "existing-work-verification-v1", occurrenceId: grant.occurrenceId,
      agentRunId: grant.agentRunId, bindingSha256: grant.binding.sha256, authorizedBindingRevision: grant.binding.revision,
      bundle: grant.bundle, backendRequirement: grant.backendRequirement, routineId, verificationAttempt: 1, expectedHeadSha: build.headSha };
    const operation: ExistingWorkOperation = { operationId, source: data.source, archiveSha256: data.archiveSha256,
      expectedHeadSha: build.headSha, routineId, verificationAttempt: 1 };
    // The dispatcher re-resolves the publication, then the controller must confirm this exact
    // reserved operation before the one durable sending insert. No existing request is adopted.
    await this.dispatch.create(request, `routine-fixer-existing-work:${grant.agentRunId}`, binding, undefined,
      () => this.authority(grant, operation));
    return this.acknowledgement(grant, operationId);
  }

  /** Stable identity only: the binding revision may advance without changing the operation. */
  private matches(grant: ExistingWorkGrant, receipt: TestDispatchReceipt) {
    const parsed = testExistingWorkBindingSchema.safeParse(receipt.existingWork);
    if (!parsed.success || receipt.continuation) return false;
    const saved = parsed.data;
    return saved.occurrenceId === grant.occurrenceId && saved.agentRunId === grant.agentRunId
      && saved.bindingSha256 === grant.binding.sha256 && saved.routineId === grant.routineId
      && receipt.input.routineId === grant.routineId && saved.verificationAttempt === grant.verificationAttempt
      && isDeepStrictEqual(saved.bundle, grant.bundle) && isDeepStrictEqual(saved.backendRequirement, grant.backendRequirement);
  }
  /** POST acknowledges only the send; results always require the read endpoint. */
  private async acknowledgement(grant: ExistingWorkGrant, operationId: string) {
    const receipt = await this.dispatch.receipt(operationId);
    if (!receipt || !this.matches(grant, receipt)) notFound();
    return { dispatchId: receipt!.dispatchId, sendState: receipt!.sendState,
      ...(receipt!.requestRunId ? { requestRunId: receipt!.requestRunId } : {}),
      ...(receipt!.requestUrl ? { requestUrl: receipt!.requestUrl } : {}) };
  }

  /** Historical reads bind the saved identity; they need no live lease or current revision. */
  async detail(grant: ExistingWorkGrant, operationId: string) {
    await this.occurrence(grant);
    if (!z.string().uuid().safeParse(operationId).success) throw new TestDispatchError(400, "Invalid operation ID");
    const receipt = await this.dispatch.receipt(operationId);
    if (!receipt || !this.matches(grant, receipt)) return notFound();
    const binding = receipt.existingWork!;
    const view = await this.dispatch.detail(operationId);
    const { results, claim, recordedResults, verifiedRecovery } = await registeredResults(view, { routineId: receipt.input.routineId,
      archiveSha256: receipt.input.archiveSha256, expectedHeadSha: binding.expectedHeadSha }, this.repository, this.runs);
    return { ...view, recordedResults, verifiedRecovery,
      verification: existingWorkVerification(view, results, claim, verifiedRecovery, binding.backendRequirement) };
  }
}

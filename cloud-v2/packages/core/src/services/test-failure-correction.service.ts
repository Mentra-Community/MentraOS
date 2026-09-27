import { createHash } from "node:crypto";
import {
  testFailureOccurrenceIdSchema, testFailureProvenanceCorrectionRequestSchema, testFailureSchema,
  type TestFailureOccurrence, type TestFailureProvenanceCorrection, type TestFailureProvenanceCorrectionRequest, type TestFailureSource,
} from "../types/test-failure.types";
import { testRunIdSchema, type TestRun } from "../types/test-run.types";
import { testFailureEnvironment } from "./test-failure-auth";
import { canonical, MongoTestRunRepository, TestRunError, type StoredTestAsset, type StoredTestRun, type TestRunRepository } from "./test-run.service";

/**
 * Which source fields the immutable accepted result proves, and which rest only on the reviewer's cited evidence.
 * Throws on any contradiction, and when the result records no tested head to corroborate against.
 */
export function corroborateCorrectionSource(run: TestRun, source: TestFailureSource) {
  const bad = (message: string): never => { throw new TestRunError(400, message); };
  if (source.channel !== run.channel) bad("source channel contradicts the accepted result");
  if (source.repository !== run.provenance.repository) bad("source repository contradicts the accepted result");
  const heads = (["headSha", "mobileSourceCommit"] as const).map(key => run.provenance[key]).filter((value): value is string => value !== undefined);
  if (!heads.length) bad("insufficient evidence: the accepted result records no tested head commit to corroborate the source");
  if (heads.some(head => head !== source.headSha)) bad("source head contradicts the accepted result");
  const corroborated = ["repository", "channel", "headSha"], asserted: string[] = [];
  if (source.pullRequest) {
    if (source.pullRequest.number !== run.prNumber) bad("source pull request contradicts the accepted result");
    corroborated.push("pullRequest.number");
    if (run.provenance.baseSha !== undefined) {
      if (source.pullRequest.baseSha !== run.provenance.baseSha) bad("source base contradicts the accepted result");
      corroborated.push("pullRequest.baseSha");
    } else asserted.push("pullRequest.baseSha");
    asserted.push("pullRequest.headRepository", "pullRequest.baseBranch");
  }
  // Recorded provenance labels must agree; otherwise coordinated channels pin their branch/trigger by schema.
  for (const key of ["branch", "trigger"] as const) {
    const recorded = run.provenance[key];
    if (recorded !== undefined && recorded !== source[key]) bad(`source ${key} contradicts the accepted result`);
    const pinned = key === "branch" ? ["dev", "staging"].includes(source.channel) : ["pr", "dev", "staging", "local"].includes(source.trigger);
    (recorded !== undefined || pinned ? corroborated : asserted).push(key);
  }
  return { corroborated, asserted };
}

/**
 * Admin-reviewed provenance correction of one existing, acknowledged occurrence. The admin session authorizes the
 * request; it never substitutes for the checks below. The accepted payload, its digest, the occurrence identity,
 * failure, and delivery receipt are never written: the correction is appended beside them, at most once.
 */
export class TestFailureCorrectionService {
  constructor(private readonly repository: TestRunRepository = new MongoTestRunRepository(),
    private readonly environment = testFailureEnvironment, private readonly now = () => new Date()) {}

  private async target(runId: string, occurrenceId: string) {
    if (!testRunIdSchema.safeParse(runId).success || !testFailureOccurrenceIdSchema.safeParse(occurrenceId).success)
      throw new TestRunError(400, "invalid run or occurrence");
    const stored = await this.repository.get(runId);
    const occurrence = stored?.failureOccurrences?.find(item => item.occurrenceId === occurrenceId);
    if (!stored || !occurrence) throw new TestRunError(404, "failure occurrence not found in this run");
    return { stored, occurrence };
  }

  /** The exact binding a reviewer must echo (accepted digest, occurrence revision, acknowledged anchor), and any correction. */
  async read(runId: string, occurrenceId: string) {
    const { stored, occurrence } = await this.target(runId, occurrenceId);
    return { schemaVersion: 1 as const, runId, payloadSha256: stored.payloadSha256, occurrenceId, occurrenceRevision: occurrence.revision,
      delivery: occurrence.delivery, publishedSource: stored.run.source ?? null,
      correction: stored.provenanceCorrections?.find(item => item.occurrenceId === occurrenceId) ?? null };
  }

  async submit(runId: string, occurrenceId: string, input: unknown, reviewedBy: string) {
    if (!reviewedBy || reviewedBy.length > 240) throw new TestRunError(400, "authenticated admin identity required");
    const parsed = testFailureProvenanceCorrectionRequestSchema.safeParse(input);
    if (!parsed.success) throw new TestRunError(400, parsed.error.issues[0]?.message ?? "invalid provenance correction");
    const request = parsed.data;
    const environment = this.environment();
    if (!environment) throw new TestRunError(409, "this Core has no configured environment");
    if (request.environment !== environment) throw new TestRunError(400, "correction names another environment");
    if (request.runId !== runId || request.occurrenceId !== occurrenceId) throw new TestRunError(400, "correction identity differs from its route");
    const { stored, occurrence } = await this.target(runId, occurrenceId);
    const correctionSha256 = createHash("sha256").update(canonical(request)).digest("hex");
    const existing = stored.provenanceCorrections?.find(item => item.occurrenceId === occurrenceId);
    // A lost reply is answered with the recorded correction; anything else about this occurrence is already decided.
    if (existing) return this.replay(existing, correctionSha256);
    this.bind(stored, occurrence, request);
    const assets = await this.repository.assets(runId);
    const uploaded = (ref: { assetId: string; sha256: string }) => {
      const declared = stored.run.assets.find(asset => asset.assetId === ref.assetId);
      const object = assets.find((asset: StoredTestAsset) => asset.assetId === ref.assetId);
      if (!declared || declared.sha256 !== ref.sha256) throw new TestRunError(400, `asset ${ref.assetId} is not declared by this result with that SHA-256`);
      if (!object || object.sha256 !== declared.sha256 || object.sizeBytes !== declared.sizeBytes)
        throw new TestRunError(400, `asset ${ref.assetId} is not uploaded with its declared bytes`);
    };
    for (const ref of request.review.evidence) uploaded(ref);
    for (const ref of request.diagnostics?.assets ?? []) {
      if (occurrence.failure.assetIds.includes(ref.assetId)) throw new TestRunError(400, `asset ${ref.assetId} is already assigned`);
      const chapter = stored.run.chapters.find(item => item.id === ref.chapterId);
      if (!chapter || chapter.status === "passed" || (chapter.videoAssetId !== ref.assetId && chapter.screenshotAssetId !== ref.assetId))
        throw new TestRunError(400, `asset ${ref.assetId} is not the recording or screenshot of non-passing chapter ${ref.chapterId}`);
      uploaded(ref);
    }
    if (occurrence.failure.assetIds.length + occurrence.failure.incidentIds.length + (request.diagnostics?.assets.length ?? 0) === 0)
      throw new TestRunError(400, "insufficient diagnostics: bind at least one reviewed recording or screenshot of a non-passing chapter");
    // The effective bindings (original plus additions) must still fit the unchanged failure contract that publishers and
    // the controller's evidence readers enforce (100 asset IDs, 20 incident IDs). Overflow refuses; nothing is truncated.
    const effectiveAssets = [...occurrence.failure.assetIds, ...(request.diagnostics?.assets ?? []).map(item => item.assetId)];
    if (!testFailureSchema.shape.assetIds.safeParse(effectiveAssets).success || !testFailureSchema.shape.incidentIds.safeParse(occurrence.failure.incidentIds).success)
      throw new TestRunError(400, "the original plus added diagnostics exceed the failure evidence limits; nothing was changed");
    const { corroborated, asserted } = corroborateCorrectionSource(stored.run, request.source);
    const correction: TestFailureProvenanceCorrection = {
      schemaVersion: 1, correctionId: `tpc_${correctionSha256}`, correctionSha256, revision: 1, environment,
      runId, payloadSha256: stored.payloadSha256, occurrenceId, occurrenceRevision: occurrence.revision, agentRunId: request.agentRunId,
      reason: request.reason, source: request.source, added: request.diagnostics ?? null,
      review: { evidence: request.review.evidence, corroborated, asserted },
      original: { source: null, assetIds: [...occurrence.failure.assetIds], incidentIds: [...occurrence.failure.incidentIds] },
      reviewedBy, reviewedAt: this.now().toISOString(), delivery: { state: "pending" },
    };
    const after = await this.repository.addProvenanceCorrection(correction);
    const saved = after?.provenanceCorrections?.find(item => item.occurrenceId === occurrenceId);
    if (!saved) throw new TestRunError(409, "the result, occurrence or acknowledgement changed; read it again");
    return this.replay(saved, correctionSha256, saved.reviewedAt === correction.reviewedAt && saved.reviewedBy === reviewedBy);
  }

  /** Exact existing identities only: stale or other anchors, payloads and occurrences refuse before any evidence is read. */
  private bind(stored: StoredTestRun, occurrence: TestFailureOccurrence, request: TestFailureProvenanceCorrectionRequest) {
    if (request.payloadSha256 !== stored.payloadSha256) throw new TestRunError(409, "correction names a different accepted payload");
    if (request.occurrenceRevision !== occurrence.revision) throw new TestRunError(409, "correction names a different occurrence revision");
    if (stored.run.source) throw new TestRunError(409, "the accepted result already records its source; a correction only adds a missing one");
    if (occurrence.delivery.state !== "acknowledged") throw new TestRunError(409, "the occurrence has no acknowledged controller anchor yet");
    if (occurrence.delivery.agentRunId !== request.agentRunId) throw new TestRunError(409, "correction names a different acknowledged anchor");
  }

  private replay(existing: TestFailureProvenanceCorrection, correctionSha256: string, created = false) {
    if (existing.correctionSha256 !== correctionSha256)
      throw new TestRunError(409, "this occurrence already has a different provenance correction");
    return { correction: existing, created };
  }
}

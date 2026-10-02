import {routineIdentitySchema} from "./routine-definition.types";
import { z } from "zod";
import { testFailureOccurrenceIdSchema, testFailureSchema, testFailureSourceSchema } from "./test-failure.types";

export const testRunIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/);
// Routine step names are labels, not run or asset path segments.
export const testRunChapterIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/);
const text = z.string().min(1).max(2000);
const verdict = z.enum(["passed", "failed", "blocked", "not-run"]);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
export const MAX_TEST_ASSET_BYTES = 128 * 1024 * 1024;
export const testAssetSchema = z.object({
  assetId: testRunIdSchema,
  kind: z.enum(["video", "screenshot", "log", "metadata"]),
  contentType: z.enum(["video/mp4", "video/webm", "image/png", "image/jpeg", "image/webp", "application/json", "text/plain"]),
  filename: z.string().min(1).max(200),
  sizeBytes: z.number().int().min(1).max(MAX_TEST_ASSET_BYTES),
  sha256,
}).strict().superRefine((asset, ctx) => {
  const matches = asset.kind === "video" ? asset.contentType.startsWith("video/")
    : asset.kind === "screenshot" ? asset.contentType.startsWith("image/")
    : ["application/json", "text/plain"].includes(asset.contentType);
  if (!matches) ctx.addIssue({ code: "custom", message: "asset kind/contentType mismatch" });
});

/** The only backend this first producer observes: the Notes production deployment. */
export const NOTES_BACKEND_DEPLOYMENT = { repository: "Mentra-Community/Mentra-Notes-Miniapp",
  origin: "https://mentra-notes-miniapp-prod.mentraglass.com" } as const;
/**
 * Optional projection of the backend deployment a claimed worker observed around its replay. Only
 * the claimed Notes Phone worker's reviewed observation path produces it; its normal metadata asset
 * holds the two authenticated observations. Absent means unknown, never a failure of the test.
 */
export const testRunBackendDeploymentSchema = z.object({
  schemaVersion: z.literal(1),
  repository: z.literal(NOTES_BACKEND_DEPLOYMENT.repository),
  origin: z.literal(NOTES_BACKEND_DEPLOYMENT.origin),
  runId: testRunIdSchema,
  requestId: testRunIdSchema,
  claimSha256: sha256,
  commitSha: z.string().regex(/^[a-f0-9]{40}$/),
  imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  deployment: z.object({ uid: z.string().min(1).max(200), generation: z.number().int().positive().safe() }).strict(),
  observedBefore: z.string().datetime({ offset: true }),
  exerciseStartedAt: z.string().datetime({ offset: true }),
  exerciseFinishedAt: z.string().datetime({ offset: true }),
  observedAfter: z.string().datetime({ offset: true }),
  evidence: z.object({ assetId: testRunIdSchema, sha256 }).strict(),
}).strict();
export type TestRunBackendDeployment = z.infer<typeof testRunBackendDeploymentSchema>;
type BackendDeploymentRun = { runId: string; requestId: string; startedAt: string; finishedAt: string;
  provenance: Record<string, string | undefined>; assets: { assetId: string; kind: string; sha256: string }[]; backendDeployment?: unknown };
/**
 * The projection bound to its own run: the same run and request, the claim document hash that the
 * run's provenance carries (`provenance.claimSha256`), exactly one declared metadata asset with the evidence hash, and
 * run start <= observedBefore <= exerciseStartedAt <= exerciseFinishedAt <= observedAfter <= run finish.
 * Null when absent. Ingestion and the existing-work verdict both use this one check.
 */
export function boundBackendDeployment(run: BackendDeploymentRun): { proof: TestRunBackendDeployment } | { problem: string } | null {
  if (run.backendDeployment === undefined) return null;
  const parsed = testRunBackendDeploymentSchema.safeParse(run.backendDeployment);
  if (!parsed.success) return { problem: "backend deployment projection is malformed" };
  const proof = parsed.data;
  if (proof.runId !== run.runId || proof.requestId !== run.requestId) return { problem: "backend deployment projection belongs to another run or request" };
  // The worker's immutable claim document hash, as its exporter records it. The request hash is
  // a different value and never stands in for a missing document hash.
  if (!run.provenance.claimSha256 || proof.claimSha256 !== run.provenance.claimSha256)
    return { problem: "backend deployment projection belongs to another claim" };
  const assets = run.assets.filter(asset => asset.assetId === proof.evidence.assetId);
  if (assets.length !== 1 || assets[0]!.kind !== "metadata" || assets[0]!.sha256 !== proof.evidence.sha256)
    return { problem: "backend deployment evidence is not this run's declared metadata asset" };
  const times = [run.startedAt, proof.observedBefore, proof.exerciseStartedAt, proof.exerciseFinishedAt, proof.observedAfter, run.finishedAt].map(Date.parse);
  if (times.some((time, index) => !Number.isFinite(time) || (index > 0 && time < times[index - 1]!)))
    return { problem: "backend deployment observations do not enclose the exercise within the run" };
  return { proof };
}

export const testRunSchema = z.object({
  runId: testRunIdSchema,
  requestId: testRunIdSchema,
  routineId: routineIdentitySchema,
  routineVersion: text,
  platform: z.enum(["ios-mac", "ios", "android"]),
  channel: z.enum(["pr", "dev", "staging", "local"]),
  prNumber: z.number().int().positive().optional(),
  release: text.optional(),
  startedAt: z.string().datetime({ offset: true }),
  finishedAt: z.string().datetime({ offset: true }),
  // Completed lifecycle phase intervals, measured by the producer's monotonic clock.
  // Missing timing is unknown; it does not mean zero or imply a phase verdict.
  phaseDurationsMs: z.object({
    setup: z.number().finite().nonnegative().optional(),
    teardown: z.number().finite().nonnegative().optional(),
  }).strict().optional(),
  outcome: z.enum(["passed", "failed", "blocked", "aborted"]),
  outcomes: z.object({
    test: verdict, teardown: verdict,
    fixture: z.enum(["ready", "unavailable", "unknown"]),
    evidence: z.enum(["complete", "incomplete"]),
  }).strict(),
  provenance: z.object({ repository: text }).catchall(z.string().max(2000)),
  source: testFailureSourceSchema.optional(),
  failures: z.array(testFailureSchema).min(1).max(30).optional(),
  fixture: z.object({ alias: text }).strict(),
  firmwareAssertions: z.array(z.object({
    component: text, expected: text, actual: text, status: verdict,
    phase: z.enum(["preflight", "setup", "test", "final-assertions", "teardown", "return-verification", "evidence"]).optional(),
  }).strict()).max(100),
  chapters: z.array(z.object({
    id: testRunChapterIdSchema, instruction: text, expected: text.optional(), status: verdict,
    phase: z.enum(["setup", "test", "verify", "teardown"]),
    videoAssetId: testRunIdSchema.optional(), videoStart: z.number().finite().nonnegative().optional(),
    videoEnd: z.number().finite().nonnegative().optional(), screenshotAssetId: testRunIdSchema.optional(),
  }).strict()).max(2000),
  assets: z.array(testAssetSchema).max(2000),
  notes: z.string().max(20000).optional(),
  backendDeployment: testRunBackendDeploymentSchema.optional(),
}).strict().superRefine((run, ctx) => {
  const problem = (message: string) => ctx.addIssue({ code: "custom", message });
  const backend = boundBackendDeployment(run);
  if (backend && "problem" in backend) problem(backend.problem);
  if (Date.parse(run.finishedAt) < Date.parse(run.startedAt)) problem("finishedAt precedes startedAt");
  if (run.channel === "pr" && !run.prNumber) problem("PR run requires prNumber");
  if (run.failures && run.outcome === "passed") problem("passed result cannot contain failures");
  if (run.source) {
    if (run.source.channel !== run.channel || run.source.repository !== run.provenance.repository
      || (run.provenance.headSha && run.source.headSha !== run.provenance.headSha)
      || (run.source.pullRequest && run.source.pullRequest.number !== run.prNumber)) problem("source contradicts immutable run provenance");
    if (run.source.pullRequest && run.provenance.baseSha && run.source.pullRequest.baseSha !== run.provenance.baseSha)
      problem("source base contradicts immutable run provenance");
  }
  if (run.outcome === "passed" && (run.outcomes.test !== "passed" || run.outcomes.fixture !== "ready"
      || run.outcomes.teardown !== "passed" || run.outcomes.evidence !== "complete"
      || run.firmwareAssertions.some(assertion => assertion.status !== "passed")
      || run.chapters.some(chapter => chapter.status !== "passed"))) problem("passed contradicts required verification/evidence");
  const assets = new Map(run.assets.map(asset => [asset.assetId, asset]));
  if (assets.size !== run.assets.length) problem("duplicate assetId");
  const failureKeys = new Set<string>();
  for (const failure of run.failures ?? []) {
    const key = JSON.stringify([failure.phase, failure.step?.id ?? null]);
    if (failureKeys.has(key)) problem("duplicate failure phase/step");
    failureKeys.add(key);
    if (new Set(failure.assetIds).size !== failure.assetIds.length) problem("duplicate failure assetId");
    for (const assetId of failure.assetIds) if (!assets.has(assetId)) problem("failure asset does not exist");
  }
  if (new Set(run.chapters.map(chapter => chapter.id)).size !== run.chapters.length) problem("duplicate chapter id");
  for (const chapter of run.chapters) {
    if (chapter.videoAssetId && assets.get(chapter.videoAssetId)?.kind !== "video") problem("chapter video does not exist");
    if (chapter.screenshotAssetId && assets.get(chapter.screenshotAssetId)?.kind !== "screenshot") problem("chapter screenshot does not exist");
    if ((chapter.videoStart !== undefined || chapter.videoEnd !== undefined) && !chapter.videoAssetId) problem("video time requires video asset");
    if (chapter.videoEnd !== undefined && chapter.videoEnd < (chapter.videoStart ?? 0)) problem("video end precedes start");
  }
});

export const testRunQuerySchema = z.object({
  occurrenceId: testFailureOccurrenceIdSchema.optional(),
  pr: z.coerce.number().int().positive().optional(),
  repository: z.string().max(200).regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/).optional(),
  headSha: z.string().regex(/^[a-f0-9]{40}$/).optional(),
  archiveSha256: sha256.optional(),
  channel: z.enum(["pr", "dev", "staging", "local"]).optional(),
  outcome: z.enum(["passed", "failed", "blocked", "aborted"]).optional(),
  routineId: routineIdentitySchema.optional(),
  platform: z.enum(["ios-mac", "ios", "android"]).optional(),
  fixtureAlias: text.optional(),
  startedAfter: z.string().datetime({ offset: true }).optional(),
  startedBefore: z.string().datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(1000).optional(),
}).strict();

export type TestRun = z.infer<typeof testRunSchema>;
export type TestAsset = z.infer<typeof testAssetSchema>;
export type TestRunQuery = z.infer<typeof testRunQuerySchema>;

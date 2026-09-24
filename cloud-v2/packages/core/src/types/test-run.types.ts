import { z } from "zod";

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

export const testRunSchema = z.object({
  runId: testRunIdSchema,
  requestId: testRunIdSchema,
  routineId: testRunIdSchema,
  routineVersion: text,
  platform: z.enum(["ios-mac", "ios", "android"]),
  channel: z.enum(["pr", "dev", "staging", "local"]),
  prNumber: z.number().int().positive().optional(),
  release: text.optional(),
  startedAt: z.string().datetime({ offset: true }),
  finishedAt: z.string().datetime({ offset: true }),
  outcome: z.enum(["passed", "failed", "blocked", "aborted"]),
  outcomes: z.object({
    test: verdict, teardown: verdict,
    fixture: z.enum(["ready", "unavailable", "unknown"]),
    evidence: z.enum(["complete", "incomplete"]),
  }).strict(),
  provenance: z.object({ repository: text }).catchall(z.string().max(2000)),
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
}).strict().superRefine((run, ctx) => {
  const problem = (message: string) => ctx.addIssue({ code: "custom", message });
  if (Date.parse(run.finishedAt) < Date.parse(run.startedAt)) problem("finishedAt precedes startedAt");
  if (run.channel === "pr" && !run.prNumber) problem("PR run requires prNumber");
  if (run.outcome === "passed" && (run.outcomes.test !== "passed" || run.outcomes.fixture !== "ready"
      || run.outcomes.teardown !== "passed" || run.outcomes.evidence !== "complete"
      || run.firmwareAssertions.some(assertion => assertion.status !== "passed")
      || run.chapters.some(chapter => chapter.status !== "passed"))) problem("passed contradicts required verification/evidence");
  const assets = new Map(run.assets.map(asset => [asset.assetId, asset]));
  if (assets.size !== run.assets.length) problem("duplicate assetId");
  if (new Set(run.chapters.map(chapter => chapter.id)).size !== run.chapters.length) problem("duplicate chapter id");
  for (const chapter of run.chapters) {
    if (chapter.videoAssetId && assets.get(chapter.videoAssetId)?.kind !== "video") problem("chapter video does not exist");
    if (chapter.screenshotAssetId && assets.get(chapter.screenshotAssetId)?.kind !== "screenshot") problem("chapter screenshot does not exist");
    if ((chapter.videoStart !== undefined || chapter.videoEnd !== undefined) && !chapter.videoAssetId) problem("video time requires video asset");
    if (chapter.videoEnd !== undefined && chapter.videoEnd < (chapter.videoStart ?? 0)) problem("video end precedes start");
  }
});

export const testRunQuerySchema = z.object({
  pr: z.coerce.number().int().positive().optional(),
  repository: z.string().max(200).regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/).optional(),
  headSha: z.string().regex(/^[a-f0-9]{40}$/).optional(),
  archiveSha256: sha256.optional(),
  channel: z.enum(["pr", "dev", "staging", "local"]).optional(),
  outcome: z.enum(["passed", "failed", "blocked", "aborted"]).optional(),
  routineId: testRunIdSchema.optional(),
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

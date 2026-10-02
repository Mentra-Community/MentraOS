import {z} from "zod";
import {frameworkBuildSchema, frameworkIdentitySchema} from "./framework-request.types";
import {routinePlatformSchema} from "./routine-definition.types";

export const frameworkRunIdSchema = frameworkIdentitySchema;
const id = frameworkRunIdSchema;
const ms = z.number().finite().nonnegative();
const failure = z.object({phase: z.enum(["setup", "test", "teardown", "evidence"]),
  actionId: id, message: z.string().min(1).max(20000)}).strict();
const json: z.ZodType<unknown> = z.lazy(() => z.union([z.null(), z.boolean(), z.string(),
  z.number().finite(), z.array(json), z.record(json)]));
const cleanupOutcome = z.discriminatedUnion("state", [
  z.object({state: z.literal("cleaned"), resourceId: id, evidence: z.array(z.string())}).strict(),
  z.object({state: z.literal("still-active"), resourceId: id, writer: json, evidence: z.array(z.string())}).strict(),
  z.object({state: z.literal("failed"), resourceId: id, failure}).strict(),
]);
export const frameworkRunSchema = z.object({
  schemaVersion: z.literal(1), requestId: id, routineId: id,
  definitionRevision: z.string().regex(/^[a-f0-9]{40}$/), platform: routinePlatformSchema,
  laneId: id, build: frameworkBuildSchema, startedAt: z.string().datetime({offset: true}), finishedAt: z.string().datetime({offset: true}),
  recordingAssetId: id.optional(),
  assets: z.array(z.object({id, kind: z.enum(["recording", "screenshot", "diagnostic", "report"]), path: z.string().min(1).max(500), sha256: z.string().regex(/^[a-f0-9]{64}$/),
    size: z.number().int().positive().max(128 * 1024 * 1024),
    mimeType: z.enum(["video/mp4", "video/webm", "image/png", "image/jpeg", "application/json", "text/plain"])}).strict()).max(2000),
  result: z.object({runId: id, finishedAt: z.string().datetime({offset: true}), test: z.enum(["passed", "failed", "not-run", "cancelled"]),
    setup: z.object({status: z.enum(["passed", "failed", "cancelled"]), actionId: id.optional()}).strict(),
    steps: z.array(z.object({id, status: z.enum(["passed", "failed", "not-run"]), durationMs: ms, causedBy: id.optional()}).strict()).max(2000),
    teardown: z.object({ready: z.boolean(), outcomes: z.array(cleanupOutcome), errors: z.array(failure),
      unavailableResources: z.array(z.object({resource: id, cause: z.string(), nextAction: z.string()}).strict())}).strict(),
    failures: z.array(failure), evidence: z.array(id),
    timing: z.object({startedAt: z.string().datetime({offset: true}), setupMs: ms, testMs: ms, teardownMs: ms}).strict(),
  }).strict(),
}).strict().superRefine((run, ctx) => {
  const problem = (message: string) => ctx.addIssue({code: "custom", message});
  if (run.result.runId !== run.requestId || run.startedAt !== run.result.timing.startedAt
    || run.finishedAt !== run.result.finishedAt
    || Date.parse(run.finishedAt) < Date.parse(run.startedAt)) problem("Run identity or timing contradicts its result");
  const assets = new Map(run.assets.map(asset => [asset.id, asset]));
  if (assets.size !== run.assets.length) problem("Duplicate asset identity");
  for (const asset of run.assets) if (asset.path.startsWith("/") || asset.path.split("/").some(part => !part || part === "." || part === ".."))
    problem("Asset path must be relative and contained");
  if (run.recordingAssetId && (assets.get(run.recordingAssetId)?.kind !== "recording"
    || assets.get(run.recordingAssetId)?.mimeType !== "video/mp4")) problem("Recording is not a declared MP4 recording");
  if (run.result.evidence.some(assetId => !assets.has(assetId))) problem("Evidence identity is not declared");
  if (new Set(run.result.steps.map(step => step.id)).size !== run.result.steps.length) problem("Duplicate step identity");
  if (run.result.test === "passed" && (run.result.setup.status !== "passed" || run.result.steps.length === 0 || run.result.failures.some(failure => failure.phase === "setup" || failure.phase === "test") || run.result.steps.some(step => step.status !== "passed")))
    problem("Passing test contradicts setup or steps");
  if (run.result.teardown.ready && (run.result.teardown.errors.length || run.result.teardown.unavailableResources.length
    || run.result.teardown.outcomes.some(outcome => outcome.state !== "cleaned"))) problem("Ready teardown contradicts cleanup outcomes");
});
export type FrameworkRun = z.infer<typeof frameworkRunSchema>;

export function frameworkRunOutcome(run: FrameworkRun) {
  if (run.result.setup.status === "failed") return "setup-failed";
  if (run.result.test === "failed") return "failed";
  if (run.result.setup.status === "cancelled" || run.result.test === "cancelled") return "cancelled";
  if (run.result.failures.some(failure => failure.phase === "evidence")) return "evidence-failed";
  if (!run.result.teardown.ready) return "teardown-failed";
  return run.result.test === "passed" ? "pass" : "not-run";
}

import {z} from "zod";
import {frameworkBuildSchema, frameworkIdentitySchema} from "./framework-request.types";
import {routineIdentitySchema, routinePlatformSchema} from "./routine-definition.types";

export const frameworkRunIdSchema = frameworkIdentitySchema;
/** Opaque manifest selectors may contain nested segments; they are never storage paths. */
export const frameworkAssetIdSchema = z.string().min(1).max(500)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*(?:\/[A-Za-z0-9][A-Za-z0-9_.:-]*)*$/);
const id = frameworkRunIdSchema;
const ms = z.number().finite().nonnegative();
const lifecycleAction = z.object({id, instruction: z.string().min(1).max(2000), expected: z.string().min(1).max(2000),
  scope: z.enum(["shared", "routine"]), status: z.enum(["passed", "failed", "cancelled", "not-run"]), durationMs: ms,
  startedAt: z.string().datetime({offset: true}).optional(), finishedAt: z.string().datetime({offset: true}).optional(),
  causedBy: id.optional()}).strict();
const failure = z.object({phase: z.enum(["setup", "test", "teardown", "evidence"]),
  actionId: id, message: z.string().min(1).max(20000)}).strict();
const json: z.ZodType<unknown> = z.lazy(() => z.union([z.null(), z.boolean(), z.string(),
  z.number().finite(), z.array(json), z.record(json)]));
const cleanupOutcome = z.discriminatedUnion("state", [
  z.object({state: z.literal("cleaned"), resourceId: id, evidence: z.array(z.string()), errors: z.array(failure).optional()}).strict(),
  z.object({state: z.literal("still-active"), resourceId: id, writer: json, evidence: z.array(z.string())}).strict(),
  z.object({state: z.literal("failed"), resourceId: id, failure}).strict(),
]);
export const frameworkRunSchema = z.object({
  schemaVersion: z.literal(1), requestId: id, hostId: id, routineId: routineIdentitySchema,
  definitionRevision: z.string().regex(/^[a-f0-9]{40}$/), platform: routinePlatformSchema,
  laneId: id, build: frameworkBuildSchema, startedAt: z.string().datetime({offset: true}), finishedAt: z.string().datetime({offset: true}),
  recordingAssetId: frameworkAssetIdSchema.optional(),
  assets: z.array(z.object({id: frameworkAssetIdSchema, kind: z.enum(["recording", "screenshot", "diagnostic", "report"]), path: z.string().min(1).max(500), sha256: z.string().regex(/^[a-f0-9]{64}$/),
    size: z.number().int().positive().max(2 * 1024 * 1024 * 1024),
    mimeType: z.enum(["video/mp4", "video/webm", "image/png", "image/jpeg", "application/json", "text/plain"])}).strict()).max(2000),
  result: z.object({runId: id, finishedAt: z.string().datetime({offset: true}), test: z.enum(["passed", "failed", "not-run", "cancelled"]),
    setup: z.object({status: z.enum(["passed", "failed", "cancelled"]), actionId: id.optional(),
      actions: z.array(lifecycleAction).max(1000).optional()}).strict(),
    steps: z.array(z.object({id, status: z.enum(["passed", "failed", "not-run"]), durationMs: ms, causedBy: id.optional(),
      startedAt: z.string().datetime({offset: true}).optional(), finishedAt: z.string().datetime({offset: true}).optional(),
      recordingLocation: z.object({assetId: frameworkAssetIdSchema, startOffsetMs: ms, endOffsetMs: ms.optional()}).strict().optional()}).strict()).max(2000),
    teardown: z.object({ready: z.boolean(), actions: z.array(lifecycleAction).max(1000).optional(),
      outcomes: z.array(cleanupOutcome), errors: z.array(failure),
      unavailableResources: z.array(z.object({resource: id, cause: z.string(), nextAction: z.string()}).strict())}).strict(),
    failures: z.array(failure), evidence: z.array(frameworkAssetIdSchema),
    timing: z.object({startedAt: z.string().datetime({offset: true}), setupMs: ms, testMs: ms, teardownMs: ms}).strict(),
  }).strict(),
}).strict().superRefine((run, ctx) => {
  const problem = (message: string) => ctx.addIssue({code: "custom", message});
  if (run.result.runId !== run.requestId || run.startedAt !== run.result.timing.startedAt
    || run.finishedAt !== run.result.finishedAt
    || Date.parse(run.finishedAt) < Date.parse(run.startedAt)) problem("Run identity or timing contradicts its result");
  const assets = new Map(run.assets.map(asset => [asset.id, asset]));
  if (assets.size !== run.assets.length) problem("Duplicate asset identity");
  for (const asset of run.assets) if (asset.kind !== "recording" && asset.size > 128 * 1024 * 1024)
    problem("Non-recording asset exceeds 128 MiB");
  for (const asset of run.assets) if (asset.path.startsWith("/") || asset.path.split("/").some(part => !part || part === "." || part === ".."))
    problem("Asset path must be relative and contained");
  if (run.recordingAssetId && (assets.get(run.recordingAssetId)?.kind !== "recording"
    || assets.get(run.recordingAssetId)?.mimeType !== "video/mp4")) problem("Recording is not a declared MP4 recording");
  if (run.result.evidence.some(assetId => !assets.has(assetId))) problem("Evidence identity is not declared");
  for (const step of run.result.steps) {
    if (step.status === "not-run" && (step.startedAt || step.finishedAt || step.recordingLocation))
      problem("Unexecuted step cannot have execution or recording timing");
    if (step.finishedAt && (!step.startedAt || Date.parse(step.finishedAt) < Date.parse(step.startedAt)))
      problem("Step finish precedes its execution start");
    if (step.recordingLocation && (assets.get(step.recordingLocation.assetId)?.kind !== "recording"
      || (step.recordingLocation.endOffsetMs !== undefined && step.recordingLocation.endOffsetMs < step.recordingLocation.startOffsetMs)))
      problem("Step recording location is invalid or undeclared");
  }
  if (new Set(run.result.steps.map(step => step.id)).size !== run.result.steps.length) problem("Duplicate step identity");
  for (const phase of ["setup", "teardown"] as const) {
    const actions = run.result[phase].actions ?? [];
    if (new Set(actions.map(action => action.id)).size !== actions.length) problem(`Duplicate ${phase} action identity`);
    for (const action of actions) {
      if (action.status === "not-run" && (action.durationMs !== 0 || action.startedAt || action.finishedAt))
        problem(`Unexecuted ${phase} action cannot have execution timing`);
      if (action.finishedAt && (!action.startedAt || Date.parse(action.finishedAt) < Date.parse(action.startedAt)))
        problem(`${phase} action finish precedes its execution start`);
      for (const timestamp of [action.startedAt, action.finishedAt]) if (timestamp
        && (Date.parse(timestamp) < Date.parse(run.startedAt) || Date.parse(timestamp) > Date.parse(run.finishedAt)))
        problem(`${phase} action timing is outside the run`);
    }
  }
  if (run.result.setup.status === "passed" && run.result.setup.actions?.some(action => action.status !== "passed"))
    problem("Passing setup contradicts setup actions");
  if (run.result.teardown.ready && run.result.teardown.actions?.some(action => action.scope === "routine" && action.status !== "passed"
    && !(action.status === "not-run" && run.result.setup.status !== "passed")))
    problem("Ready teardown contradicts routine teardown actions");
  if (run.result.test === "passed" && (run.result.setup.status !== "passed" || run.result.steps.length === 0 || run.result.failures.some(failure => failure.phase === "setup" || failure.phase === "test") || run.result.steps.some(step => step.status !== "passed")))
    problem("Passing test contradicts setup or steps");
  const sameFailure = (left: z.infer<typeof failure>, right: z.infer<typeof failure>) =>
    left.phase === right.phase && left.actionId === right.actionId && left.message === right.message;
  const reportedCleanupFailure = (error: z.infer<typeof failure>) => (error.phase === "teardown" || error.phase === "evidence")
    && run.result.teardown.errors.some(flattened => sameFailure(error, flattened))
    && run.result.failures.some(flattened => sameFailure(error, flattened));
  for (const action of run.result.teardown.actions ?? []) if (action.scope === "shared" && action.status !== "passed") {
    if (action.status === "not-run") {
      if (run.result.teardown.ready) problem("Ready teardown contradicts unexecuted shared cleanup");
      continue;
    }
    const resourceId = action.id.startsWith("cleanup:") ? action.id.slice("cleanup:".length) : undefined;
    const outcomes = run.result.teardown.outcomes.filter(outcome => outcome.resourceId === resourceId);
    const diagnosed = outcomes.some(outcome => outcome.state === "cleaned"
      ? !!outcome.errors?.length && outcome.errors.every(reportedCleanupFailure)
      : outcome.state === "failed" ? reportedCleanupFailure(outcome.failure)
        : !run.result.teardown.ready && run.result.teardown.unavailableResources.some(item => item.resource === outcome.resourceId));
    if (!diagnosed) problem("Failed shared cleanup must retain its classified diagnostics or active resource outcome");
    if (run.result.teardown.ready && (action.status !== "failed" || !outcomes.some(outcome => outcome.state === "cleaned"
      && !!outcome.errors?.length && outcome.errors.every(error => error.phase === "evidence" && reportedCleanupFailure(error)))))
      problem("Ready teardown may contain failed shared cleanup only for recorded evidence diagnostics on a cleaned resource");
  }
  for (const error of run.result.teardown.errors) if (!run.result.failures.some(flattened => sameFailure(error, flattened)))
    problem("Teardown diagnostics must remain in run failures");
  for (const outcome of run.result.teardown.outcomes) if (outcome.state === "cleaned") for (const error of outcome.errors ?? []) {
    if (!run.result.teardown.errors.some(flattened => sameFailure(error, flattened))
      || !run.result.failures.some(flattened => sameFailure(error, flattened))) problem("Cleanup diagnostics must remain in teardown errors and run failures");
  }
  if (run.result.teardown.ready && (run.result.failures.some(failure => failure.phase === "teardown")
    || run.result.teardown.errors.some(error => error.phase !== "evidence") || run.result.teardown.unavailableResources.length
    || run.result.teardown.outcomes.some(outcome => outcome.state !== "cleaned"))) problem("Ready teardown contradicts cleanup outcomes");
});
export type FrameworkRun = z.infer<typeof frameworkRunSchema>;

export function frameworkRunOutcome(run: FrameworkRun) {
  if (run.result.setup.status === "failed") return "setup-failed";
  if (run.result.test === "failed") return "failed";
  if (run.result.setup.status === "cancelled" || run.result.test === "cancelled") return "cancelled";
  if (!run.result.teardown.ready) return "teardown-failed";
  return run.result.test === "passed" ? "pass" : "not-run";
}

export function frameworkEvidenceComplete(run: FrameworkRun) {
  return !run.result.failures.some(failure => failure.phase === "evidence");
}

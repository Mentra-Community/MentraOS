import {frameworkBindingSchema, routineSourceRefSchema} from './framework-version.types';
import {z} from "zod";
import {frameworkBuildSchema, frameworkIdentitySchema} from "./framework-request.types";
import {routineIdentitySchema, routinePlatformSchema} from "./routine-definition.types";

export const frameworkRunIdSchema = frameworkIdentitySchema;
/** Bounded manifest cardinality; the publication route separately retains its 1 MiB JSON body limit. */
export const FRAMEWORK_RUN_ASSET_LIMIT = 4096;
/** Opaque manifest selectors may contain nested segments; they are never storage paths. */
export const frameworkAssetIdSchema = z.string().min(1).max(500)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*(?:\/[A-Za-z0-9][A-Za-z0-9_.:-]*)*$/);
const id = frameworkRunIdSchema;
const ms = z.number().finite().nonnegative();
export const stepSourceSchema = z.object({id, repository: z.literal("Mentra-Community/Mentra-Automated-Testing"),
  revision: z.string().regex(/^[a-f0-9]{40}$/), path: z.string().max(500).regex(/^(?:routines|framework|tools)\/[\w./-]+\.ts$/)
    .refine(path => path.split("/").every(part => part !== "." && part !== ".." && part !== "")),
  line: z.number().int().positive().safe()}).strict();
const stepSourcesSchema = z.object({setup: z.array(stepSourceSchema).max(500), test: z.array(stepSourceSchema).max(500),
  teardown: z.array(stepSourceSchema).max(500)}).strict();
const lifecycleAction = z.object({id, instruction: z.string().min(1).max(2000), expected: z.string().min(1).max(2000),
  stage: z.enum(["validation", "before-entry", "entry", "after-entry", "recording", "teardown-actions", "resource-cleanup"]).optional(),
  scope: z.enum(["shared", "routine"]), fixtureProvider: routineIdentitySchema.optional(), status: z.enum(["passed", "failed", "cancelled", "not-run"]), durationMs: ms,
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
const frozenFrameworkRunSchema = z.object({
  schemaVersion: z.literal(1), requestId: id, hostId: id, routineId: routineIdentitySchema,
  definitionRevision: z.string().regex(/^[a-f0-9]{40}$/), platform: routinePlatformSchema,
  routineSource: routineSourceRefSchema, frameworkBinding: frameworkBindingSchema,
  laneId: id, build: frameworkBuildSchema, startedAt: z.string().datetime({offset: true}), finishedAt: z.string().datetime({offset: true}),
  recordingAssetId: frameworkAssetIdSchema.optional(),
  assets: z.array(z.object({id: frameworkAssetIdSchema, kind: z.enum(["recording", "screenshot", "diagnostic", "report"]), path: z.string().min(1).max(500), sha256: z.string().regex(/^[a-f0-9]{64}$/),
    size: z.number().int().positive().max(2 * 1024 * 1024 * 1024),
    mimeType: z.enum(["video/mp4", "video/webm", "image/png", "image/jpeg", "application/json", "text/plain"])}).strict()).max(FRAMEWORK_RUN_ASSET_LIMIT),
  result: z.object({stepSources: stepSourcesSchema.optional(), runId: id, finishedAt: z.string().datetime({offset: true}), test: z.enum(["passed", "failed", "not-run", "cancelled"]),
    setup: z.object({status: z.enum(["passed", "failed", "cancelled"]), actionId: id.optional(),
      actions: z.array(lifecycleAction).max(1000).optional()}).strict(),
    steps: z.array(z.object({id, status: z.enum(["passed", "failed", "not-run"]), durationMs: ms, causedBy: id.optional(),
      startedAt: z.string().datetime({offset: true}).optional(), finishedAt: z.string().datetime({offset: true}).optional(),
      recordingLocation: z.object({assetId: frameworkAssetIdSchema, startOffsetMs: ms, endOffsetMs: ms.optional()}).strict().optional()}).strict()).max(2000),
    teardown: z.object({ready: z.boolean(), actions: z.array(lifecycleAction).max(1000).optional(),
      outcomes: z.array(cleanupOutcome), errors: z.array(failure),
      unavailableResources: z.array(z.object({resource: id, cause: z.string(), nextAction: z.string()}).strict())}).strict(),
    failures: z.array(failure), evidence: z.array(frameworkAssetIdSchema).max(FRAMEWORK_RUN_ASSET_LIMIT),
    timing: z.object({startedAt: z.string().datetime({offset: true}), setupMs: ms, testMs: ms, teardownMs: ms}).strict(),
  }).strict(),
}).strict();
type FrozenFrameworkRun = z.infer<typeof frozenFrameworkRunSchema>;
function validateFrozenFrameworkRun(run: Pick<FrozenFrameworkRun, Exclude<keyof FrozenFrameworkRun, 'routineSource' | 'frameworkBinding'>> & {frameworkBinding?: FrozenFrameworkRun['frameworkBinding']}, ctx: z.RefinementCtx) {
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
  // The recorder assigns original step offsets before finalization can reject its public video.
  // Retain those observations when the matching cleaned recorder reports that evidence failure.
  const sameFailure = (left: z.infer<typeof failure>, right: z.infer<typeof failure>) =>
    left.phase === right.phase && left.actionId === right.actionId && left.message === right.message;
  const failedRecordingFinalization = run.result.teardown.actions?.some(action => action.scope === 'shared'
    && action.status === 'failed' && action.id.startsWith('cleanup:')
    && run.result.teardown.outcomes.some(outcome => outcome.state === 'cleaned'
      && outcome.resourceId === action.id.slice('cleanup:'.length) && outcome.errors?.some(error =>
        error.phase === 'evidence' && error.actionId === 'finalize-recording'
        && run.result.teardown.errors.some(flattened => sameFailure(error, flattened))
        && run.result.failures.some(flattened => sameFailure(error, flattened)))));
  for (const [index, step] of run.result.steps.entries()) {
    if (step.status === "not-run" && (step.startedAt || step.finishedAt || step.recordingLocation))
      problem("Unexecuted step cannot have execution or recording timing");
    if (step.finishedAt && (!step.startedAt || Date.parse(step.finishedAt) < Date.parse(step.startedAt)))
      problem("Step finish precedes its execution start");
    const location = step.recordingLocation;
    const diagnosedMissingRecording = location?.assetId === 'recording' && !assets.has(location.assetId)
      && !run.recordingAssetId && failedRecordingFinalization;
    if (location && (assets.get(location.assetId)?.kind !== 'recording' && !diagnosedMissingRecording
      || (location.endOffsetMs !== undefined && location.endOffsetMs < location.startOffsetMs)))
      ctx.addIssue({code: 'custom', message: 'Step recording location is invalid or undeclared',
        path: ['result', 'steps', index, 'recordingLocation']});
  }
  if (run.result.stepSources) for (const phase of ["setup", "test", "teardown"] as const) {
    const actions = phase === "test" ? run.result.steps : run.result[phase].actions ?? [];
    const sources = run.result.stepSources[phase];
    if (new Set(sources.map(source => source.id)).size !== sources.length) problem("Duplicate step source identity");
    for (const source of sources) {
      const action = actions.find(action => action.id === source.id);
      const routine = source.path.startsWith("routines/");
      if (!action || source.revision !== (routine ? run.definitionRevision : run.frameworkBinding?.revision)
        || phase === "test" && !routine) problem("Step source contradicts recorded run provenance");
    }
  }
  if (new Set(run.result.steps.map(step => step.id)).size !== run.result.steps.length) problem("Duplicate step identity");
  for (const phase of ["setup", "teardown"] as const) {
    const actions = run.result[phase].actions ?? [];
    if (new Set(actions.map(action => action.id)).size !== actions.length) problem(`Duplicate ${phase} action identity`);
    for (const action of actions) {
      if (action.stage && !(phase === "setup"
        ? ["validation", "before-entry", "entry", "after-entry", "recording"]
        : ["recording", "teardown-actions", "resource-cleanup"]).includes(action.stage))
        problem(`Invalid ${phase} lifecycle stage`);
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
    // An interrupted provider has not returned an outcome. Preserve its failure
    // and unresolved custody without inventing a cleaned resource or live writer.
    const unresolved = !run.result.teardown.ready && !!resourceId && outcomes.length === 0
      && run.result.teardown.unavailableResources.some(item => item.resource === resourceId)
      && run.result.teardown.errors.some(error => error.phase === "teardown"
        && error.actionId === action.id && reportedCleanupFailure(error));
    const diagnosed = outcomes.some(outcome => outcome.state === "cleaned"
      ? !!outcome.errors?.length && outcome.errors.every(reportedCleanupFailure)
      : outcome.state === "failed" ? reportedCleanupFailure(outcome.failure)
        : !run.result.teardown.ready && run.result.teardown.unavailableResources.some(item => item.resource === outcome.resourceId));
    if (!diagnosed && !unresolved) problem("Failed shared cleanup must retain its classified diagnostics or unresolved resource custody");
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
}
/** New publications always carry actual routine and installed framework provenance. */
export const frameworkRunSchema = frozenFrameworkRunSchema.superRefine(validateFrozenFrameworkRun);
/** Retained cloud records may predate provenance fields; absent values remain unknown without defaults. */
export const recordedFrameworkRunSchema = frozenFrameworkRunSchema.extend({
  routineSource: routineSourceRefSchema.optional(), frameworkBinding: frameworkBindingSchema.optional(),
}).superRefine(validateFrozenFrameworkRun);
export type FrameworkRun = z.infer<typeof frameworkRunSchema>;
export type RecordedFrameworkRun = z.infer<typeof recordedFrameworkRunSchema>;
/** Display-only association read from an original, digest-checked diagnostic; never part of the frozen verdict. */
export interface FrameworkFailureScreen {
  phase: RecordedFrameworkRun['result']['failures'][number]['phase'];
  actionId: string;
  assetId?: string;
  desktopAssetId?: string;
}

export function frameworkRunOutcome(run: RecordedFrameworkRun) {
  if (run.result.setup.status === "failed") return "setup-failed";
  if (run.result.test === "failed") return "failed";
  if (run.result.setup.status === "cancelled" || run.result.test === "cancelled") return "cancelled";
  if (!run.result.teardown.ready) return "teardown-failed";
  return run.result.test === "passed" ? "pass" : "not-run";
}

export function frameworkEvidenceComplete(run: RecordedFrameworkRun) {
  return !run.result.failures.some(failure => failure.phase === "evidence");
}

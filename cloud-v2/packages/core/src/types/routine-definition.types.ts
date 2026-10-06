import {z} from "zod";
import {glassesSoftwareRefSchema} from "./glasses-software.types";
import {candidateVerificationSchema} from './candidate-verification.types';

/** Host audio, fixture data and external windows are validated by their lane providers, not physical glasses. */
export const routineGlassesCapabilities = (requires: readonly string[]) =>
  requires.filter(capability => capability !== "audio" && capability !== "fixture-data" && capability !== "external-window");

const text = z.string().min(1).max(2000);
export const routineIdentitySchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/);
const id = routineIdentitySchema;
export const glassesModelSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,119}$/);
export const routineGlassesRequirementSchema = z.object({models: z.array(glassesModelSchema).min(1).max(30), startSoftware: glassesSoftwareRefSchema.optional()}).strict()
  .refine(value => new Set(value.models).size === value.models.length, "Acceptable glasses models must be unique")
  .refine(value => !value.startSoftware || value.models.includes(value.startSoftware.model), "Starting software must name an accepted glasses model");
const action = z.object({id, instruction: text, expected: text}).strict();
export const routinePlatformSchema = z.enum(["ios-on-mac", "android"]);
/** Serialized source definition; executable functions remain in the harness repository. */
export const publishedRoutineDefinitionSchema = z.object({
  id,
  title: text,
  purpose: text,
  platforms: z.array(routinePlatformSchema).min(1).max(2),
  entry: z.enum(["home", "sign-in"]),
  account: z.enum(["lane", "none"]),
  requires: z.array(id).max(30),
  glasses: routineGlassesRequirementSchema.optional(),
  requirements: z.array(text).max(30),
  fixtures: z.array(z.object({provider: id, description: text}).strict()).max(30),
  setup: z.array(action).max(500).optional(),
  steps: z.array(action).min(1).max(500),
  teardown: z.array(action).max(500).optional(),
  privateEvidenceIntervals: z.array(z.object({startStepId: id, endStepId: id, reason: text}).strict()).max(30).optional(),
  execution: z.object({resourceKinds: z.array(z.enum(["app", "phone", "glasses", "recorder", "audio", "browser", "network", "fixture-data", "workspace"])).min(1),
    policy: z.record(z.unknown()).optional()}).strict().optional(),
  source: z.object({repository: z.string().regex(/^[\w-]+\/[\w.-]+$/),
    revision: z.string().regex(/^[a-f0-9]{40}$/), path: z.string().regex(/^routines\/[\w.-]+\/routine\.ts$/)}).strict(),
}).strict().superRefine((definition, ctx) => {
  const actions = [...(definition.setup ?? []), ...definition.steps, ...(definition.teardown ?? [])];
  if (new Set(actions.map(action => action.id)).size !== actions.length)
    ctx.addIssue({code: "custom", message: "Setup, test and teardown action identities must be unique"});
  let previousEnd = -1;
  for (const interval of definition.privateEvidenceIntervals ?? []) {
    const start = definition.steps.findIndex(step => step.id === interval.startStepId);
    const end = definition.steps.findIndex(step => step.id === interval.endStepId);
    if (start < 0 || end < start || start <= previousEnd)
      ctx.addIssue({code: "custom", message: "Private evidence intervals require ordered, nonoverlapping product-step boundaries"});
    previousEnd = end;
  }
  if (new Set(definition.platforms).size !== definition.platforms.length)
    ctx.addIssue({code: "custom", message: "Platforms must be unique"});
  if (definition.entry === "home" && definition.account !== "lane")
    ctx.addIssue({code: "custom", message: "Home entry requires the lane account"});
  if (definition.execution && Boolean(definition.glasses) !== definition.execution.resourceKinds.includes("glasses"))
    ctx.addIssue({code: "custom", message: "Glasses execution metadata must match the routine model declaration"});
});
export const routineEnrollmentSchema = z.object({
  routineId: id, platform: routinePlatformSchema, definitionRevision: z.string().regex(/^[a-f0-9]{40}$/),
  definitionSha256: z.string().regex(/^[a-f0-9]{64}$/), definition: publishedRoutineDefinitionSchema,
  verification: candidateVerificationSchema.optional(),
}).strict().superRefine((row, ctx) => {
  if (row.routineId !== row.definition.id || row.definitionRevision !== row.definition.source.revision
    || !row.definition.platforms.includes(row.platform))
    ctx.addIssue({code: "custom", message: "Enrollment identity contradicts its definition"});
  if (row.verification && row.verification.sourceRevision !== row.definitionRevision)
    ctx.addIssue({code: 'custom', message: 'Candidate verification source differs from its definition'});
});
export type RoutineEnrollment = z.infer<typeof routineEnrollmentSchema>;

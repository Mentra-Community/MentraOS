import {routineSourceRefSchema} from './framework-version.types';
import {z} from "zod";
import {glassesSoftwareRefSchema} from "./glasses-software.types";
import {candidateVerificationSchema} from './candidate-verification.types';

const text = z.string().min(1).max(2000);
export const routineIdentitySchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/);
const id = routineIdentitySchema;
export const glassesModelSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,119}$/);
export const routineGlassesRequirementSchema = z.object({models: z.array(glassesModelSchema).min(1).max(30), startSoftware: glassesSoftwareRefSchema.optional()}).strict()
  .refine(value => new Set(value.models).size === value.models.length, "Acceptable glasses models must be unique")
  .refine(value => !value.startSoftware || value.models.includes(value.startSoftware.model), "Starting software must name an accepted glasses model");
const action = z.object({id, instruction: text, expected: text}).strict();
export const routinePlatformSchema = z.enum(["ios-on-mac", "android"]);
export const routineResourceKindSchema = z.enum(["app", "phone", "glasses", "recorder", "audio", "browser", "network", "fixture-data", "workspace"]);
export const resourceCapabilityMap = {
  app: ['relaunch'], phone: ['bluetooth-observe', 'bluetooth-toggle', 'trace', 'dialogs'],
  glasses: ['glasses-ble', 'connection', 'software'], recorder: [],
  audio: ['speech', 'witness', 'synthesis', 'recognition'], browser: ['external-window'],
  network: ['independent-uplink'], 'fixture-data': [], workspace: [],
} as const;
export const routineResourceRequirementSchema = z.object({kind: routineResourceKindSchema,
  capabilities: z.array(routineIdentitySchema).max(30)}).strict().refine(value =>
    new Set(value.capabilities).size === value.capabilities.length && value.capabilities.every(capability =>
      (resourceCapabilityMap[value.kind] as readonly string[]).includes(capability)), 'Resource capabilities must be unique implemented public operations');
/** Serialized source definition; executable functions remain in the harness repository. */
export const publishedRoutineDefinitionSchema = z.object({
  id,
  minimumRoutineApiVersion: z.number().int().positive().safe(),
  title: text,
  purpose: text,
  platforms: z.array(routinePlatformSchema).min(1).max(2),
  entry: z.enum(["home", "sign-in"]),
  account: z.enum(["lane", "none"]),
  glasses: routineGlassesRequirementSchema.optional(),
  requirements: z.array(text).max(30),
  resourceRequirements: z.array(routineResourceRequirementSchema).max(9),
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
  const resourceKinds = definition.resourceRequirements.map(value => value.kind);
  const executionKinds = definition.execution?.resourceKinds ?? [];
  if (new Set(resourceKinds).size !== resourceKinds.length || resourceKinds.length !== executionKinds.length ||
    resourceKinds.some(kind => !executionKinds.includes(kind)))
    ctx.addIssue({code: "custom", message: "Resource requirements must uniquely name declared execution resources"});
  if (Boolean(definition.glasses) !== resourceKinds.includes('glasses') || Boolean(definition.fixtures.length) !== resourceKinds.includes('fixture-data'))
    ctx.addIssue({code: 'custom', message: 'Typed resources must match glasses models and fixture declarations'});
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
  routineSource: routineSourceRefSchema,
  verification: candidateVerificationSchema.optional(),
}).strict().superRefine((row, ctx) => {
  const base = ['app', 'recorder', ...(row.platform === 'android' ? ['phone'] : [])]
  if (row.definition.execution && !base.every(kind => row.definition.resourceRequirements.some(resource => resource.kind === kind)))
    ctx.addIssue({code: 'custom', message: 'Executable enrollment omits its platform base resources'})
  if (row.routineId !== row.definition.id || row.definitionRevision !== row.definition.source.revision
    || !row.definition.platforms.includes(row.platform))
    ctx.addIssue({code: "custom", message: "Enrollment identity contradicts its definition"});
  if (row.routineSource.commit !== row.definitionRevision || row.routineSource.minimumRoutineApiVersion !== row.definition.minimumRoutineApiVersion)
    ctx.addIssue({code: 'custom', message: 'Routine bundle contradicts its definition/API requirement'});
  if (row.verification && row.verification.sourceRevision !== row.definitionRevision)
    ctx.addIssue({code: 'custom', message: 'Candidate verification source differs from its definition'});
});
export type RoutineEnrollment = z.infer<typeof routineEnrollmentSchema>;

/** Card metadata only. Full definitions and source verification belong to detail and dispatch. */
export const routineCardDefinitionSchema = z.object({
  routineId: id, platform: routinePlatformSchema, definitionRevision: z.string().regex(/^[a-f0-9]{40}$/),
  definitionSha256: z.string().regex(/^[a-f0-9]{64}$/),
  definition: z.object({title: text, purpose: text,
    glasses: z.object({models: z.array(glassesModelSchema).min(1).max(30)}).strict().optional(),
  }).strict(),
}).strict();
export type RoutineCardDefinition = z.infer<typeof routineCardDefinitionSchema>;

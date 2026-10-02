import {z} from "zod";

const text = z.string().min(1).max(2000);
export const routineIdentitySchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/);
const id = routineIdentitySchema;
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
  requirements: z.array(text).max(30),
  fixtures: z.array(z.object({provider: id, description: text}).strict()).max(30),
  steps: z.array(z.object({id, instruction: text, expected: text}).strict()).min(1).max(500),
  source: z.object({repository: z.string().regex(/^[\w-]+\/[\w.-]+$/),
    revision: z.string().regex(/^[a-f0-9]{40}$/), path: z.string().regex(/^routines\/[\w.-]+\/routine\.ts$/)}).strict(),
}).strict().superRefine((definition, ctx) => {
  if (new Set(definition.steps.map(step => step.id)).size !== definition.steps.length)
    ctx.addIssue({code: "custom", message: "Step identities must be unique"});
  if (new Set(definition.platforms).size !== definition.platforms.length)
    ctx.addIssue({code: "custom", message: "Platforms must be unique"});
  if (definition.entry === "home" && definition.account !== "lane")
    ctx.addIssue({code: "custom", message: "Home entry requires the lane account"});
});
export const routineEnrollmentSchema = z.object({
  routineId: id, platform: routinePlatformSchema, definitionRevision: z.string().regex(/^[a-f0-9]{40}$/),
  definitionSha256: z.string().regex(/^[a-f0-9]{64}$/), definition: publishedRoutineDefinitionSchema,
}).strict().superRefine((row, ctx) => {
  if (row.routineId !== row.definition.id || row.definitionRevision !== row.definition.source.revision
    || !row.definition.platforms.includes(row.platform))
    ctx.addIssue({code: "custom", message: "Enrollment identity contradicts its definition"});
});
export type RoutineEnrollment = z.infer<typeof routineEnrollmentSchema>;

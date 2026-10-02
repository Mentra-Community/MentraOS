import {z} from "zod";
import {routinePlatformSchema} from "./routine-definition.types";

export const frameworkIdentitySchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,239}$/);
export const frameworkBuildSchema = z.object({
  repository: z.string().regex(/^[\w-]+\/[\w.-]+$/),
  headSha: z.string().regex(/^[a-f0-9]{40}$/),
  channel: z.enum(["dev", "staging", "pr", "local"]),
  prNumber: z.number().int().positive().optional(),
}).passthrough().superRefine((build, ctx) => {
  if (build.channel === "pr" && !build.prNumber) ctx.addIssue({code: "custom", message: "PR build requires its PR number"});
});
export const frameworkRequestInputSchema = z.object({
  routineId: frameworkIdentitySchema,
  definitionRevision: z.string().regex(/^[a-f0-9]{40}$/),
  platform: routinePlatformSchema,
  laneId: frameworkIdentitySchema,
  build: frameworkBuildSchema,
}).passthrough();

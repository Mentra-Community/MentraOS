import {z} from "zod";
import {routineIdentitySchema, routinePlatformSchema} from "./routine-definition.types";

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
  routineId: routineIdentitySchema,
  definitionRevision: z.string().regex(/^[a-f0-9]{40}$/),
  platform: routinePlatformSchema,
  laneId: frameworkIdentitySchema,
  build: frameworkBuildSchema,
  resources: z.array(z.object({id: frameworkIdentitySchema, kind: z.enum(["app", "phone", "glasses", "recorder", "audio", "browser", "network", "fixture-data", "workspace"]), laneId: frameworkIdentitySchema.optional()}).strict()),
  policy: z.record(z.unknown()).optional(),
}).passthrough();

/** Admin delivery projection; it describes a request without claiming execution evidence. */
export interface FrameworkRequestDisplay {
  requestId: string; hostId: string; inputSha256: string; routineId: string; platform: string;
  definitionRevision: string; laneId: string; build: z.infer<typeof frameworkBuildSchema>;
  state: "queued" | "accepted" | "running" | "terminal"; terminalStatus?: string;
  createdAt?: string; acceptedAt?: string; reason?: string; reasonAt?: string;
  cancellationRequested?: boolean; cancellationAcknowledged?: boolean;
}

import {z} from "zod";
import {routineIdentitySchema, routinePlatformSchema} from "./routine-definition.types";
import {firmwareManifestSchema, glassesSoftwareRefSchema} from "./glasses-software.types";
import {candidateVerificationSchema} from './candidate-verification.types';

export const frameworkIdentitySchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,239}$/);
export const frameworkBuildSchema = z.object({
  repository: z.string().regex(/^[\w-]+\/[\w.-]+$/),
  headSha: z.string().regex(/^[a-f0-9]{40}$/),
  channel: z.enum(["dev", "staging", "pr", "local"]),
  prNumber: z.number().int().positive().optional(),
  manifest: firmwareManifestSchema.optional(),
  manifestSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
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
  glassesStart: glassesSoftwareRefSchema.optional(),
  glassesReturn: glassesSoftwareRefSchema.optional(),
  verification: candidateVerificationSchema.optional(),
}).passthrough().superRefine((input, ctx) => {
  if (input.verification && input.verification.sourceRevision !== input.definitionRevision)
    ctx.addIssue({code: 'custom', message: 'Candidate verification source differs from the request'});
  const glasses = input.resources.some(resource => resource.kind === "glasses");
  if (glasses !== (input.glassesStart !== undefined && input.glassesReturn !== undefined) ||
    (input.glassesStart === undefined) !== (input.glassesReturn === undefined))
    ctx.addIssue({code: "custom", message: "Selected glasses resource requires frozen start and return software references"});
  if (input.glassesStart && input.glassesReturn) {
    if (input.glassesStart.model !== input.glassesReturn.model)
      ctx.addIssue({code: "custom", message: "Starting and return software must name the same selected glasses model"});
    if (!input.build.manifest || input.build.manifestSha256 !== input.build.manifest.sha256 ||
      JSON.stringify(input.glassesReturn.manifest) !== JSON.stringify(input.build.manifest))
      ctx.addIssue({code: "custom", message: "Return glasses software must match the selected build manifest identity"});
  }
});

/** Admin delivery projection; it describes a request without claiming execution evidence. */
export interface FrameworkRequestDisplay {
  requestId: string; hostId: string; inputSha256: string; routineId: string; platform: string;
  definitionRevision: string; laneId: string; build: z.infer<typeof frameworkBuildSchema>;
  state: "queued" | "accepted" | "running" | "terminal"; terminalStatus?: string;
  createdAt?: string; acceptedAt?: string; reason?: string; reasonAt?: string;
  cancellationRequested?: boolean; cancellationAcknowledged?: boolean;
}

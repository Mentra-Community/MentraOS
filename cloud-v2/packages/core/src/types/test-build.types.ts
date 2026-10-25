import {appRepositorySchema} from './testing-source.types';
import {z} from "zod";
import {routinePlatformSchema} from "./routine-definition.types";
import {firmwareManifestSchema} from "./glasses-software.types";
export {firmwareManifestSchema, glassesSoftwareRefSchema, type GlassesSoftwareRef} from "./glasses-software.types";
const positive = z.number().int().positive().safe();
/** Canonical release producers retain their monorepo head; published apps retain the verified public export. */
export const testBuildArtifactSourceSchema = z.object({repository: z.literal('Mentra-Community/MentraOS'),
  headSha: z.string().regex(/^[a-f0-9]{40}$/)}).strict();
export const testBuildSourceSchema = z.discriminatedUnion("channel", [
  z.object({channel: z.literal("pr"), prNumber: positive, buildRunId: positive, publicationAttempt: positive, repository: appRepositorySchema.optional()}).strict(),
  z.object({channel: z.literal("dev"), buildRunId: positive, publicationAttempt: positive, repository: appRepositorySchema.optional()}).strict(),
  z.object({channel: z.literal("staging"), buildRunId: positive, publicationAttempt: positive, repository: appRepositorySchema.optional()}).strict(),
]);
export const testBuildQuerySchema = z.object({channel: z.enum(["pr", "dev", "staging"]),
  repository: appRepositorySchema.optional(), pr: z.coerce.number().int().positive().safe().optional(), platform: routinePlatformSchema}).strict()
  .refine(value => (value.channel === "pr") === (value.pr !== undefined), "Only PR inventory requires a PR number");
export type TestBuildSource = z.infer<typeof testBuildSourceSchema>;
export type TestBuildQuery = z.infer<typeof testBuildQuerySchema>;
export type TestBuildPlatform = z.infer<typeof routinePlatformSchema>;
export interface TestBuild {
  diagnostic?: "nimo-resource-v1";
  source: TestBuildSource; platform?: TestBuildPlatform; title: string; headSha: string; buildUrl: string; createdAt: string;
  availability: "available" | "unavailable"; producerStatus?: "pending" | "failed"; reason?: string; release?: string;
  artifactSource?: z.infer<typeof testBuildArtifactSourceSchema>;
  archive?: {name: string; sha256: string; size: number; url: string};
  receipt?: {url: string; sha256: string; size: number};
  manifestSha256?: string;
  manifest?: z.infer<typeof firmwareManifestSchema>;
  app?: {executableSha256: string; javascriptSha256: string};
}

/** Published references are resolved by Core, never caller-local filesystem paths. */
export function selectedBuildInput(build: TestBuild, platform: TestBuildPlatform, diagnosticAuthoring = false) {
  if (build.diagnostic && (!diagnosticAuthoring || platform !== "android" || build.source.channel !== "pr")) throw new Error("Diagnostic APK requires explicit NIMO authoring admission");
  if (!build.archive || !build.receipt) throw new Error("Published build references are incomplete");
  const repository = appRepositorySchema.parse(build.source.repository ?? 'Mentra-Community/MentraOS');
  const artifactSource = build.artifactSource === undefined ? undefined : testBuildArtifactSourceSchema.parse(build.artifactSource);
  if (artifactSource && (repository !== 'Mentra-Community/Mentra' || build.source.channel === 'pr'))
    throw new Error('Exported artifact source requires a canonical coordinated release');
  if (repository === 'Mentra-Community/Mentra' && build.source.channel !== 'pr' && !artifactSource)
    throw new Error('Canonical release requires its verified exported artifact source');
  return {
    kind: platform === "ios-on-mac" ? "mac-ci-package" : "android-apk",
    ...(build.diagnostic ? {diagnostic: build.diagnostic} : {}),
    repository, headSha: build.headSha, channel: build.source.channel,
    ...(artifactSource ? {artifactSource} : {}),
    ...(build.source.channel === "pr" ? {prNumber: build.source.prNumber} : {}),
    ...(build.release ? {releaseIdentity: build.release} : {}),
    source: build.source, archive: build.archive, receipt: build.receipt,
  };
}

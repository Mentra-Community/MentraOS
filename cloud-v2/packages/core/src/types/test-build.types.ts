import {z} from "zod";
import {routinePlatformSchema} from "./routine-definition.types";
const positive = z.number().int().positive().safe();
export const firmwareManifestSchema = z.object({url: z.string().url().refine(value => {
  try {const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password && !value.includes("#");}
  catch {return false;}
}, "Firmware manifest requires an HTTPS URL without credentials or fragment"),
  sha256: z.string().regex(/^[a-f0-9]{64}$/), size: positive}).strict();
export const glassesSoftwareRefSchema = z.object({model: z.literal("mentra-live"), manifest: firmwareManifestSchema}).strict();
export type GlassesSoftwareRef = z.infer<typeof glassesSoftwareRefSchema>;
export const testBuildSourceSchema = z.discriminatedUnion("channel", [
  z.object({channel: z.literal("pr"), prNumber: positive, buildRunId: positive, publicationAttempt: positive}).strict(),
  z.object({channel: z.literal("dev"), buildRunId: positive, publicationAttempt: positive}).strict(),
  z.object({channel: z.literal("staging"), buildRunId: positive, publicationAttempt: positive}).strict(),
]);
export const testBuildQuerySchema = z.object({channel: z.enum(["pr", "dev", "staging"]),
  pr: z.coerce.number().int().positive().safe().optional(), platform: routinePlatformSchema}).strict()
  .refine(value => (value.channel === "pr") === (value.pr !== undefined), "Only PR inventory requires a PR number");
export type TestBuildSource = z.infer<typeof testBuildSourceSchema>;
export type TestBuildQuery = z.infer<typeof testBuildQuerySchema>;
export type TestBuildPlatform = z.infer<typeof routinePlatformSchema>;
export interface TestBuild {
  source: TestBuildSource; platform?: TestBuildPlatform; title: string; headSha: string; buildUrl: string; createdAt: string;
  availability: "available" | "unavailable"; reason?: string; release?: string;
  archive?: {name: string; sha256: string; size: number; url: string};
  receipt?: {url: string; sha256: string; size: number};
  manifestSha256?: string;
  manifest?: z.infer<typeof firmwareManifestSchema>;
  app?: {executableSha256: string; javascriptSha256: string};
}

/** Published references are resolved by Core, never caller-local filesystem paths. */
export function selectedBuildInput(build: TestBuild, platform: TestBuildPlatform) {
  if (!build.archive || !build.receipt) throw new Error("Published build references are incomplete");
  return {
    kind: platform === "ios-on-mac" ? "mac-ci-package" : "android-apk",
    repository: "Mentra-Community/MentraOS", headSha: build.headSha, channel: build.source.channel,
    ...(build.source.channel === "pr" ? {prNumber: build.source.prNumber} : {}),
    ...(build.release ? {releaseIdentity: build.release} : {}),
    source: build.source, archive: build.archive, receipt: build.receipt,
  };
}

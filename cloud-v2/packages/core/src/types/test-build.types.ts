import {z} from "zod";
import {routinePlatformSchema} from "./routine-definition.types";
const positive = z.number().int().positive().safe();
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

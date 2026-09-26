import { z } from "zod";

const repository = z.string().max(200).regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/);
const commit = z.string().regex(/^[a-f0-9]{40}$/);
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/);
const assetId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/);
const text = z.string().min(1).max(2000);
// Branch names are metadata, never shell arguments. Keep the Git ref restrictions
// here too so a missing/invalid branch cannot become an automatic fix destination.
export const testFailureBranchSchema = z.string().min(1).max(255).refine(value =>
  !/[\x00-\x20\x7f~^:?*\[\\]/.test(value) && !value.startsWith("-")
  && !value.includes("..") && !value.includes("@{") && value !== "@"
  && value.split("/").every(part => part.length > 0 && !part.startsWith(".") && !part.endsWith(".lock"))
  && !value.endsWith("."), "invalid source branch");

export const testFailureSourceSchema = z.object({
  schemaVersion: z.literal(1),
  // `manual`: an authenticated explicit request for a published build whose Admin/CLI
  // caller was not recorded. Routing uses channel/branch/pullRequest, never the trigger.
  trigger: z.enum(["pr", "dev", "staging", "nightly", "admin", "manual", "local"]),
  repository,
  channel: z.enum(["pr", "dev", "staging", "local"]),
  headSha: commit,
  branch: testFailureBranchSchema,
  pullRequest: z.object({
    number: z.number().int().positive().safe(), headRepository: repository,
    baseBranch: testFailureBranchSchema, baseSha: commit,
  }).strict().optional(),
}).strict().superRefine((source, ctx) => {
  const problem = (message: string) => ctx.addIssue({ code: "custom", message });
  if ((source.channel === "pr") !== Boolean(source.pullRequest)) problem("PR source requires exactly one pull request identity");
  if (["pr", "dev", "staging", "local"].includes(source.trigger) && source.trigger !== source.channel)
    problem("trigger contradicts selected source channel");
  if (source.trigger === "nightly" && !["dev", "staging"].includes(source.channel)) problem("nightly source must be dev or staging");
  if (source.trigger === "admin" && source.channel === "local") problem("Admin source must be a published build");
  if (source.trigger === "manual" && source.channel === "local") problem("manual source must be a published build");
  if (["dev", "staging"].includes(source.channel) && source.branch !== source.channel) problem("coordinated source branch must match channel");
});

export const testFailurePhaseSchema = z.enum([
  "preflight", "setup", "test", "final-assertions", "teardown", "return-verification", "evidence", "unknown",
]);
export const testFailureSchema = z.object({
  phase: testFailurePhaseSchema,
  step: z.object({ id, label: text }).strict().nullable(),
  code: id,
  message: text,
  expected: text.optional(),
  stack: z.string().min(1).max(8000).optional(),
  // Only these reviewed/redacted representations are exposed to the agent.
  assetIds: z.array(assetId).max(100),
  incidentIds: z.array(z.string().regex(/^rep_[A-Za-z0-9]{1,80}$/)).max(20),
  redactionPolicy: z.string().min(1).max(160),
  missingEvidence: z.array(z.object({
    kind: z.enum(["recording", "screenshot", "phone-logs", "glasses-logs", "backend-logs", "symbols", "incident", "source", "failure-details", "other"]),
    reason: text,
  }).strict()).max(30),
}).strict();

export const testFailureOccurrenceIdSchema = z.string().regex(/^tfo_[a-f0-9]{64}$/);
export type TestFailureSource = z.infer<typeof testFailureSourceSchema>;
export type TestFailure = z.infer<typeof testFailureSchema>;
export interface TestFailureOccurrence {
  occurrenceId: string;
  revision: 1;
  failure: TestFailure;
  delivery: { state: "pending"; lastAttemptAt?: string } | { state: "acknowledged"; agentRunId: string; acknowledgedAt: string };
}

export const testFailureDeliveryAckSchema = z.object({
  schemaVersion: z.literal(1), occurrenceId: testFailureOccurrenceIdSchema, revision: z.literal(1),
  agentRunId: z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/), status: z.literal("accepted"),
}).strict();

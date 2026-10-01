import {z} from "zod";
import {testRunIdSchema} from "./test-run.types";

/** One dispatched job, with its expected members declared before execution. */
export const testSuiteSchema = z.object({
  suiteId: testRunIdSchema,
  channel: z.enum(["dev", "staging", "pr", "local"]),
  trigger: z.enum(["nightly", "manual", "pr", "build"]),
  startedAt: z.string().datetime({offset: true}),
  build: z.object({headSha: z.string().regex(/^[a-f0-9]{40}$/),
    release: z.string().min(1).max(200).optional(),
    producerUrl: z.string().url().max(2000).refine(value => /^https:\/\/github\.com\/Mentra-Community\//.test(value)).optional(),
  }).strict(),
  members: z.array(z.object({memberId: testRunIdSchema, requestId: testRunIdSchema.optional(), headSha: z.string().regex(/^[a-f0-9]{40}$/).optional(), routineId: testRunIdSchema,
    platform: z.enum(["ios-mac", "ios", "android"]),
  }).strict()).min(1).max(100),
}).strict().superRefine((suite, ctx) => {
  if (new Set(suite.members.map(member => member.memberId)).size !== suite.members.length
    || new Set(suite.members.flatMap(member => member.requestId ? [member.requestId] : [])).size !== suite.members.filter(member => member.requestId).length)
    ctx.addIssue({code: "custom", message: "duplicate suite member or requestId"});
});
export const testSuiteCompletionSchema = z.object({finishedAt: z.string().datetime({offset: true})}).strict();
export type TestSuite = z.infer<typeof testSuiteSchema>;
export type SuiteRun = {runId: string; requestId: string; routineId: string; platform: string;
  channel: string; provenance: {headSha?: string}; outcome: string; startedAt: string; finishedAt: string};

/** Missing, mismatched, or ambiguous results never count as a pass. */
export function summarizeSuite(suite: TestSuite, runs: SuiteRun[], finishedAt?: string) {
  const members = suite.members.map(member => {
    const matches = runs.filter(run => !!member.requestId && run.requestId === member.requestId && run.routineId === member.routineId
      && run.platform === member.platform && run.channel === suite.channel && run.provenance.headSha === (member.headSha ?? suite.build.headSha));
    const run = matches.length === 1 ? matches[0] : undefined;
    return {...member, status: run?.outcome ?? (finishedAt ? "not-run" : "waiting"),
      ...(run ? {runId: run.runId, startedAt: run.startedAt, finishedAt: run.finishedAt} : {})};
  });
  const passed = members.filter(member => member.status === "passed").length;
  const failed = members.filter(member => !["passed", "waiting"].includes(member.status));
  return {...suite, ...(finishedAt ? {finishedAt} : {}), members, passed,
    outcome: !finishedAt ? "running" : passed === members.length ? "passed" : "failed",
    failedRoutines: failed.map(member => member.routineId)};
}

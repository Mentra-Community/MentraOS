/** One-time archival completion for cancelled/expired input-based nightlies. Dry-run unless --apply. */
import mongoose from "mongoose";
import {z} from "zod";
import {TestSuiteModel} from "../packages/core/src/models/test-suite.model";
import {testWriteConcern} from "../packages/core/src/models/test-write-concern";
import {recordedFrameworkRequestInputSchema, frameworkIdentitySchema} from "../packages/core/src/types/framework-request.types";
import {testSuiteSchema} from "../packages/core/src/types/test-suite.types";
import {FrameworkResultService} from "../packages/core/src/services/framework-result.service";
import {nightlyOccurrenceSchema, nightlySuiteId} from "../packages/core/src/services/nightly-routine.service";
import {requestInputDigest, TestRequestService, isExecutableRequest, type StoredRequest} from "../packages/core/src/services/test-request.service";
import {TestRunError} from "../packages/core/src/services/test-result-error";

const memberSchema = z.object({memberId: frameworkIdentitySchema, requestId: frameworkIdentitySchema,
  routineId: z.string(), platform: z.enum(["android", "ios-on-mac"]), definitionRevision: z.string().regex(/^[a-f0-9]{40}$/),
  definitionSha256: z.string().regex(/^[a-f0-9]{64}$/), hostId: frameworkIdentitySchema, build: z.record(z.unknown()),
  input: recordedFrameworkRequestInputSchema}).passthrough();
const cancellationSchema = z.object({requestedAt: z.string().datetime({offset: true}), reason: z.string().min(1).max(2000)}).strict();
const planSchema = nightlyOccurrenceSchema.extend({suiteId: frameworkIdentitySchema, members: z.array(memberSchema).min(2).max(100),
  suite: testSuiteSchema, publication: z.object({headSha: z.string().regex(/^[a-f0-9]{40}$/)}).passthrough()}).passthrough();
export interface RecordedSuiteRow {suiteId: string; payload: unknown; payloadSha256: string; nightlyPlan: unknown; nightlyCancellation?: unknown; nightlyResult?: unknown}
interface Dependencies {getSuite(id: string): Promise<RecordedSuiteRow | null>; getRequest(id: string): Promise<StoredRequest | null>;
  summary(id: string): ReturnType<FrameworkResultService["summary"]>; cancel(id: string, at: string, reason: string): Promise<StoredRequest | null>;
  finish(row: RecordedSuiteRow, result: unknown): Promise<void>}
const defaultDependencies = (): Dependencies => {
  const requests = new TestRequestService(), results = new FrameworkResultService();
  return {getSuite: id => TestSuiteModel.findOne({suiteId: id}).read("primary").readConcern("majority").setOptions({timeoutMS: 10_000}).lean() as Promise<RecordedSuiteRow | null>,
    getRequest: id => requests.get(id), summary: id => results.summary(id), cancel: (id, at, reason) => requests.cancel(id, at, reason),
    async finish(row, result) {await TestSuiteModel.updateOne({suiteId: row.suiteId, payloadSha256: row.payloadSha256,
      payload: row.payload, nightlyPlan: row.nightlyPlan, nightlyResult: {$exists: false},
      nightlyCancellation: row.nightlyCancellation ?? {$exists: false}}, {$set: {nightlyResult: result, finishedAt: (result as {finishedAt: string}).finishedAt}},
    {writeConcern: testWriteConcern, timeoutMS: 10_000});}};
};
/** Validate every original request/result before any cancellation or final write. Never creates a dispatch request. */
export async function finishRecordedNightlySuite(suiteId: string, apply = false, deps = defaultDependencies(), now = Date.now()) {
  const row = await deps.getSuite(frameworkIdentitySchema.parse(suiteId));
  if (!row) throw new Error("Recorded nightly suite was not found");
  const plan = planSchema.parse(row.nightlyPlan), suite = testSuiteSchema.parse(row.payload);
  const cancellation = row.nightlyCancellation === undefined ? undefined : cancellationSchema.parse(row.nightlyCancellation);
  if (plan.suiteId !== row.suiteId || nightlySuiteId(plan.occurrenceId) !== row.suiteId || suite.suiteId !== row.suiteId
    || requestInputDigest(row.payload) !== row.payloadSha256 || requestInputDigest(plan.suite) !== row.payloadSha256
    || plan.startedAt !== suite.startedAt || plan.trigger !== suite.trigger || suite.channel !== "dev"
    || plan.publication.headSha !== suite.build.headSha || plan.members.length !== suite.members.length
    || new Set(plan.members.map(m => m.requestId)).size !== plan.members.length) throw new Error("Recorded nightly plan or suite identity differs");
  const boundary = cancellation?.requestedAt ?? new Date(Date.parse(plan.startedAt) + 3 * 3600_000).toISOString();
  if (Date.parse(boundary) > now) throw new Error("Recorded nightly has not been cancelled or expired");
  if (row.nightlyResult !== undefined) return {suiteId, apply, alreadyFinished: true};
  const originals: Array<{member: z.infer<typeof memberSchema>; request: StoredRequest | null; result: Awaited<ReturnType<FrameworkResultService["summary"]>> | null}> = [];
  for (const member of plan.members) {
    if ("selection" in member || "dispatchIntent" in member || "routineRevision" in member) throw new Error("Current nightly plans are not archival inputs");
    const expected = suite.members.find(m => m.memberId === member.memberId), input = member.input;
    if (!expected || expected.requestId !== member.requestId || expected.routineId !== member.routineId || expected.platform !== member.platform
      || expected.definitionRevision !== member.definitionRevision || expected.headSha !== input.build.headSha
      || input.routineId !== member.routineId || input.platform !== member.platform || input.definitionRevision !== member.definitionRevision
      || input.build.channel !== suite.channel || input.build.headSha !== suite.build.headSha
      // Frozen complete inputs added the selected glasses manifest to the earlier app build selection.
      || Object.entries(member.build).some(([key, value]) => requestInputDigest(value) !== requestInputDigest(input.build[key])))
      throw new Error("Recorded nightly member input differs");
    const request = await deps.getRequest(member.requestId);
    if (request && (!isExecutableRequest(request) || request.requestId !== member.requestId || request.hostId !== member.hostId
      || request.inputSha256 !== requestInputDigest(input) || requestInputDigest(request.input) !== request.inputSha256
      || request.dispatchIntent !== undefined)) throw new Error("Recorded request differs from its frozen input");
    let result: Awaited<ReturnType<FrameworkResultService["summary"]>> | null = null;
    try {result = await deps.summary(member.requestId);} catch (error) {if (!(error instanceof TestRunError) || error.status !== 404) throw error;}
    if (result && (result.requestId !== member.requestId || result.hostId !== member.hostId || result.routineId !== member.routineId
      || result.platform !== member.platform || result.laneId !== input.laneId || result.definitionRevision !== member.definitionRevision
      || requestInputDigest(result.build) !== requestInputDigest(input.build)
      || Date.parse(result.startedAt) < Date.parse(plan.startedAt) || Date.parse(result.finishedAt) > now)) throw new Error("Recorded native result identity differs");
    if (result && !result.uploadsComplete) throw new Error("Recorded native result uploads have not settled");
    originals.push({member, request, result});
  }
  const reason = cancellation ? `Cancelled: ${cancellation.reason}; no original run result was recorded.` : "Nightly deadline expired; no original run result was recorded.";
  const members = originals.map(({member, request, result}) => result ? {...member, status: result.outcome,
    publicationComplete: result.evidenceStatus === "complete", runId: result.runId, runStartedAt: result.startedAt, runFinishedAt: result.finishedAt}
    : {...member, status: "incomplete", publicationComplete: false, unavailableReason: `${reason}${request ? "" : " The original request was never admitted."}`});
  // The recorded boundary and actual run finishes are evidence; this utility's wall time is not a historical finish time.
  const finishedAt = new Date(Math.max(Date.parse(boundary), ...members.flatMap(m => "runFinishedAt" in m ? [Date.parse(m.runFinishedAt)] : []))).toISOString();
  const passed = members.filter(m => m.status === "pass" && m.publicationComplete).length;
  const result = {occurrenceId: plan.occurrenceId, suiteId, startedAt: plan.startedAt, trigger: plan.trigger, members,
    expectedCount: members.length, passed, status: members.some(m => m.status === "incomplete") ? "incomplete" : passed === members.length ? "pass" : "failed",
    finishedAt, resultUrl: `https://admin.dev.mentraglass.com/?testSuite=${encodeURIComponent(suiteId)}`, ...(cancellation ? {cancellation} : {})};
  if (apply) {
    for (const {member, request, result: run} of originals) if (request && !run && request.state !== "terminal") {
      const saved = await deps.cancel(member.requestId, boundary, cancellation?.reason ?? "Nightly deadline expired.");
      if (!saved || !isExecutableRequest(saved) || saved.requestId !== member.requestId || saved.hostId !== member.hostId
        || saved.inputSha256 !== requestInputDigest(member.input)
        || saved.state !== "terminal" && !saved.hostCancellation) throw new Error("Original request cancellation was not retained");
    }
    let failure: unknown;
    try {await deps.finish(row, result);} catch (error) {failure = error;}
    const saved = await deps.getSuite(suiteId);
    if (!saved || requestInputDigest(saved.nightlyPlan) !== requestInputDigest(row.nightlyPlan)
      || requestInputDigest(saved.payload) !== row.payloadSha256 || saved.nightlyResult === undefined
      || requestInputDigest(saved.nightlyResult) !== requestInputDigest(result)) throw failure ?? new Error("Archival completion lost its compare-and-set");
  }
  return {suiteId, apply, expectedCount: members.length, passed, failed: members.filter(m => m.status !== "pass" && m.status !== "incomplete").length,
    incomplete: members.filter(m => m.status === "incomplete").length, status: result.status, finishedAt};
}
if (import.meta.main) {
  const args = process.argv.slice(2), apply = args.includes("--apply"), ids = args.filter(arg => arg !== "--apply");
  if (!ids.length || ids.length > 20 || ids.some(id => id.startsWith("--"))) throw new Error("Usage: bun scripts/finish-recorded-nightly-suites.ts [--apply] SUITE_ID [...]");
  if (!process.env.MONGO_URL) throw new Error("MONGO_URL must identify the existing Core database");
  await mongoose.connect(process.env.MONGO_URL, {serverSelectionTimeoutMS: 10_000});
  try {for (const id of ids) console.log(JSON.stringify(await finishRecordedNightlySuite(id, apply)));} finally {await mongoose.disconnect();}
}

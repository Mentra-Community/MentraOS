import {frameworkEvidenceComplete, frameworkRunOutcome, frameworkRunIdSchema, recordedFrameworkRunSchema} from "../types/framework-run.types";
import {z} from "zod";
import {TestSuiteModel} from "../models/test-suite.model";
import {TestRunModel} from "../models/test-run.model";
import {TestRequestModel} from "../models/test-request.model";
import {summarizeSuite, testSuiteSchema, testSuiteCompletionSchema, type TestSuite, type SuiteRun, type SuiteRejection} from "../types/test-suite.types";
import {TestRunError} from "./test-result-error";
import {hostRejectionSchema, requestInputDigest} from "./test-request.service";
import {recordedFrameworkRequestInputSchema} from "../types/framework-request.types";
import {NightlyRoutineService, type NightlyPlan, type NightlyResult} from "./nightly-routine.service";

const writeConcern = {w: "majority" as const, j: true, wtimeout: 10_000};

/** Project the occurrence's one terminal authority; never take another evidence snapshot. */
export function nightlySuiteProjection(suite: TestSuite, plan: NightlyPlan, result: NightlyResult): ReturnType<typeof summarizeSuite> {
  if (requestInputDigest(suite) !== requestInputDigest(plan.suite) || result.suiteId !== suite.suiteId
    || result.occurrenceId !== plan.occurrenceId || result.startedAt !== plan.startedAt || result.trigger !== plan.trigger
    || result.expectedCount !== suite.members.length || result.members.length !== suite.members.length)
    throw new TestRunError(503, "Nightly suite receipt differs from its frozen plan");
  const members = suite.members.map(member => {
    const expected = plan.members.find(expected => expected.memberId === member.memberId);
    const receipt = result.members.find(receipt => receipt.memberId === member.memberId);
    if (!expected || !receipt || receipt.requestId !== expected.requestId || receipt.routineId !== expected.routineId
      || receipt.platform !== expected.platform || receipt.definitionRevision !== expected.definitionRevision
      || receipt.definitionSha256 !== expected.definitionSha256 || receipt.hostId !== expected.hostId
      || requestInputDigest(receipt.build ?? null) !== requestInputDigest(expected.build ?? null)
      || requestInputDigest(receipt.input ?? null) !== requestInputDigest(expected.input ?? null))
      throw new TestRunError(503, "Nightly member receipt differs from its frozen input");
    return {...member, ...((expected.input?.build ?? expected.build) ? {build: expected.input?.build ?? expected.build} : {}), status: receipt.status === "incomplete" ? "not-run" : receipt.status,
      publicationComplete: receipt.publicationComplete,
      ...(receipt.unavailableReason ? {unavailableReason: receipt.unavailableReason} : {}),
      ...(receipt.runId ? {runId: receipt.runId, startedAt: receipt.runStartedAt, finishedAt: receipt.runFinishedAt} : {})};
  });
  const passed = members.filter(member => member.status === "pass" && member.publicationComplete).length;
  return {...suite, ...(result.finishedAt ? {finishedAt: result.finishedAt} : {}), members, passed,
    outcome: !result.finishedAt ? "running" : passed === members.length ? "passed" : "failed",
    failedRoutines: [...new Set(members.filter(member => (result.finishedAt !== undefined || member.status !== "waiting")
      && (member.status !== "pass" || !member.publicationComplete)).map(member => member.routineId))]};
}
export class TestSuiteService {
  async create(input: unknown) {
    const parsed = testSuiteSchema.safeParse(input);
    if (!parsed.success) throw new TestRunError(400, "invalid test suite");
    const payload = parsed.data;
    const payloadSha256 = requestInputDigest(payload);
    try { await TestSuiteModel.create([{suiteId: payload.suiteId, startedAt: new Date(payload.startedAt), payload, payloadSha256}], {writeConcern}); }
    catch (error) { if ((error as {code?: number}).code !== 11000) throw error; }
    const stored = await TestSuiteModel.findOne({suiteId: payload.suiteId}).read("primary").readConcern("majority").lean();
    if (!stored || stored.payloadSha256 !== payloadSha256) throw new TestRunError(409, "suite ID already has a different plan");
    return this.detail(payload.suiteId);
  }
  async bind(suiteId: string, memberId: string, input: unknown) {
    const parsed = z.object({requestId: frameworkRunIdSchema}).strict().safeParse(input);
    if (!parsed.success) throw new TestRunError(400, "invalid member request binding");
    const suite = await this.detail(suiteId);
    const member = suite.members.find(member => member.memberId === memberId);
    if (!member) throw new TestRunError(404, "suite member not found");
    if (member.requestId && member.requestId !== parsed.data.requestId) throw new TestRunError(409, "member already bound to a different request");
    if (suite.members.some(other => other.memberId !== memberId && other.requestId === parsed.data.requestId))
      throw new TestRunError(409, "request already belongs to another member");
    if (!member.requestId) {
      const updated = await TestSuiteModel.updateOne({suiteId, nightlyPlan: {$exists: false}, finishedAt: {$exists: false}, finalizingAt: {$exists: false},
        "payload.members.requestId": {$ne: parsed.data.requestId},
        "payload.members": {$elemMatch: {memberId, requestId: {$exists: false}}}},
        {$set: {"payload.members.$.requestId": parsed.data.requestId}}, {writeConcern});
      if (!updated.modifiedCount) {
        const current = await this.detail(suiteId);
        if (current.members.find(member => member.memberId === memberId)?.requestId !== parsed.data.requestId)
          throw new TestRunError(409, "suite is finished or member binding changed");
      }
    }
    return this.detail(suiteId);
  }
  async complete(suiteId: string, input: unknown) {
    const parsed = testSuiteCompletionSchema.safeParse(input);
    if (!parsed.success) throw new TestRunError(400, "invalid suite completion");
    const stored = await TestSuiteModel.findOne({suiteId}).read("primary").readConcern("majority").lean();
    if (stored?.nightlyPlan) {
      if (!testSuiteSchema.safeParse(stored.payload).success) throw new TestRunError(404, "Occurrence has no multi-member test suite");
      const plan = stored.nightlyPlan as NightlyPlan;
      if (Date.parse(parsed.data.finishedAt) < Date.parse(plan.startedAt)) throw new TestRunError(400, "suite finish precedes start");
      await new NightlyRoutineService().complete(plan.occurrenceId);
      return this.detail(suiteId);
    }
    const initial = await this.detail(suiteId);
    if (initial.finishedAt) return initial;
    if (Date.parse(parsed.data.finishedAt) < Date.parse(initial.startedAt)) throw new TestRunError(400, "suite finish precedes start");
    // Fence membership before reading evidence. Retries resume the same boundary.
    await TestSuiteModel.updateOne({suiteId, finalizingAt: {$exists: false}, finishedAt: {$exists: false}},
      {$set: {finalizingAt: parsed.data.finishedAt}}, {writeConcern});
    const suite = await this.detail(suiteId);
    if (suite.finishedAt) return suite;
    const row = await TestSuiteModel.findOne({suiteId}).read("primary").readConcern("majority").lean();
    const finishedAt = new Date(Math.max(Date.parse(row!.finalizingAt!),
      ...suite.members.flatMap(member => member.finishedAt ? [Date.parse(member.finishedAt)] : []))).toISOString();
    const completedResult = {...suite, finishedAt,
      outcome: suite.passed === suite.members.length ? "passed" : "failed",
      members: suite.members.map(member => ({...member, status: member.status === "waiting" ? "not-run" : member.status})),
      failedRoutines: [...new Set(suite.members.filter(member => (member.status !== "pass" || !member.publicationComplete)).map(member => member.routineId))],
    };
    await TestSuiteModel.updateOne({suiteId, finishedAt: {$exists: false}},
      {$set: {finishedAt, completedResult}}, {writeConcern});
    return this.detail(suiteId);
  }
  async originalMember(requestId: string) {
    const rows = await TestSuiteModel.find({"payload.members.requestId": requestId}).select({suiteId:1,"payload.members":1})
      .limit(2).read("primary").readConcern("majority").lean();
    if (rows.length > 1) throw new TestRunError(409, "Original request belongs to multiple suites; select an explicit suite member");
    const row = rows[0], member = (row?.payload as TestSuite | undefined)?.members.find(m=>m.requestId===requestId);
    return row && member ? {suiteId:row.suiteId,memberId:member.memberId} : null;
  }
  async detail(suiteId: string) {
    if (!frameworkRunIdSchema.safeParse(suiteId).success) throw new TestRunError(400, "invalid suite ID");
    const row = await TestSuiteModel.findOne({suiteId}).read("primary").readConcern("majority").lean();
    if (!row) throw new TestRunError(404, "test suite not found");
    if (!row.nightlyPlan && row.completedResult) return row.completedResult as ReturnType<typeof summarizeSuite>;
    if (!row.payload) throw new TestRunError(404, "Occurrence has no multi-member test suite");
    const suite = row.payload as TestSuite;
    if (row.nightlyPlan) {
      const plan = row.nightlyPlan as NightlyPlan;
      const result = row.nightlyResult as NightlyResult | undefined ?? await new NightlyRoutineService().detail(plan.occurrenceId);
      return nightlySuiteProjection(suite, plan, result);
    }
    const rows = await TestRunModel.find({requestId: {$in: suite.members.flatMap(member => member.requestId ? [member.requestId] : [])}})
      .select({payload: 1, outcome: 1, uploadsComplete: 1}).limit(201).read("primary").readConcern("majority").lean();
    if (rows.length > 200) throw new TestRunError(503, "suite result history exceeds the query bound; no verdict available");
    const runs: SuiteRun[] = rows.map(row => {
      const framework = recordedFrameworkRunSchema.safeParse(row.payload);
      if (!framework.success) throw new TestRunError(503, "Suite member is not a valid framework result");
      const run = framework.data;
      return {runId: run.result.runId, requestId: run.requestId, routineId: run.routineId, platform: run.platform, definitionRevision: run.definitionRevision,
        channel: run.build.channel, provenance: {headSha: run.build.headSha},
        startedAt: run.startedAt, finishedAt: run.finishedAt, outcome: frameworkRunOutcome(run),
        publicationComplete: row.uploadsComplete === true && frameworkEvidenceComplete(run)};
    });
    const requests = await TestRequestModel.find({requestId: {$in: suite.members.flatMap(member => member.requestId ? [member.requestId] : [])},
      hostRejection: {$exists: true}}).select({requestId: 1, hostId: 1, inputSha256: 1, input: 1, state: 1, terminalStatus: 1, hostRejection: 1})
      .limit(101).read("primary").readConcern("majority").lean();
    if (requests.length > 100) throw new TestRunError(503, "suite rejection history exceeds the query bound; no verdict available");
    const rejections: SuiteRejection[] = requests.map(request => {
      const rejection = hostRejectionSchema.safeParse(request.hostRejection), input = recordedFrameworkRequestInputSchema.safeParse(request.input);
      if (!rejection.success || !input.success || request.state !== "terminal" || request.terminalStatus !== "not-run"
        || rejection.data.requestId !== request.requestId || rejection.data.hostId !== request.hostId
        || rejection.data.inputSha256 !== request.inputSha256 || requestInputDigest(input.data) !== request.inputSha256)
        throw new TestRunError(503, "suite member rejection identity is invalid; no verdict available");
      return {requestId: request.requestId, routineId: input.data.routineId, platform: input.data.platform,
        definitionRevision: input.data.definitionRevision, channel: input.data.build.channel, headSha: input.data.build.headSha,
        rejectedAt: rejection.data.rejectedAt, reason: `${rejection.data.code}: ${rejection.data.reason}`};
    });
    return summarizeSuite(suite, runs, row.finishedAt ?? undefined, rejections);
  }
  async labels(requestIds: string[]) {
    if (requestIds.length > 100 || requestIds.some(id => !frameworkRunIdSchema.safeParse(id).success))
      throw new TestRunError(400, "invalid suite label query");
    const rows = await TestSuiteModel.find({"payload.members.1": {$exists: true},
      "payload.members.requestId": {$in: requestIds}}).select({suiteId: 1, payload: 1}).limit(100).lean();
    return {labels: rows.flatMap(row => {
      const suite = row.payload as TestSuite;
      if (suite.members.length < 2) return [];
      return suite.members.filter(member => !!member.requestId && requestIds.includes(member.requestId)).map(member => ({...member,
        suiteId: suite.suiteId, channel: suite.channel, headSha: member.headSha ?? suite.build.headSha,
        label: `${suite.channel} ${suite.trigger} · ${suite.build.release ?? suite.build.headSha.slice(0, 7)}`}));
    })};
  }
  async list() {
    const rows = await TestSuiteModel.find({"payload.members.1": {$exists: true}}).sort({createdAt: -1})
      .select({suiteId: 1, "payload.members": 1}).limit(20).lean();
    return {suites: await Promise.all(rows.filter(row => (row.payload as TestSuite).members.length >= 2)
      .map(row => this.detail(row.suiteId)))};
  }
}

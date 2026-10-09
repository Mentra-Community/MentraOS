import {frameworkEvidenceComplete, frameworkRunOutcome, frameworkRunIdSchema, recordedFrameworkRunSchema} from "../types/framework-run.types";
import type {PipelineStage} from "mongoose";
import {createLogger} from "@mentra/cloud-shared";
import {z} from "zod";
import {TestSuiteModel} from "../models/test-suite.model";
import {TestRunModel} from "../models/test-run.model";
import {TestRequestModel} from "../models/test-request.model";
import {summarizeSuite, testSuiteSchema, testSuiteCompletionSchema, type TestSuite, type SuiteRun, type SuiteRejection} from "../types/test-suite.types";
import {TestRunError} from "./test-result-error";
import {hostRejectionSchema, requestInputDigest, type HostAcceptance, type StoredRequest} from "./test-request.service";
import {frameworkBuildSchema, frameworkIdentitySchema, recordedFrameworkRequestInputSchema} from "../types/framework-request.types";
import {routineDispatchIntentSchema} from "../types/routine-dispatch.types";
import {routineJobBindingSchema, routinePublicationFailureSchema} from "../types/routine-job.types";
import {NightlyRoutineService, nightlyPreparedInput, type NightlyPlan, type NightlyResult} from "./nightly-routine.service";
import {nightlyUnassignedReason} from "./nightly-deadline-reason";
import {frameworkResultSummaryFields, readFrameworkResultSummary} from "./framework-result.service";
import {nativeRunFilter} from "./framework-run-summary.service";
import {LaneRestorationService} from "./lane-restoration.service";
import {restorationHostIsFresh, type LaneOverviewList} from "../types/lane-restoration.types";

const writeConcern = {w: "majority" as const, j: true, wtimeout: 10_000};
const logger = createLogger("core").child({component: "test-suite"});

type RecordedInput = z.infer<typeof recordedFrameworkRequestInputSchema>;
type InputNightlyMember = Omit<NightlyPlan["members"][number], "routineRevision" | "dispatchIntent"> & {
  definitionSha256: string; input?: RecordedInput;
};
type RecordedNightlyPlan = Omit<NightlyPlan, "members"> & {members: (NightlyPlan["members"][number] | InputNightlyMember)[]};
type RecordedNightlyResult = Omit<NightlyResult, "members"> & {members: (NightlyResult["members"][number] |
  (InputNightlyMember & Omit<NightlyResult["members"][number], "routineRevision" | "dispatchIntent" | "input" | "inputSha256">))[]};

/** Project the occurrence's one terminal authority; never take another evidence snapshot. */
export function nightlySuiteProjection(suite: TestSuite, plan: RecordedNightlyPlan, result: RecordedNightlyResult): ReturnType<typeof summarizeSuite> {
  if (requestInputDigest(suite) !== requestInputDigest(plan.suite) || result.suiteId !== suite.suiteId
    || result.occurrenceId !== plan.occurrenceId || result.startedAt !== plan.startedAt || result.trigger !== plan.trigger
    || result.expectedCount !== suite.members.length || result.members.length !== suite.members.length)
    throw new TestRunError(503, "Nightly suite receipt differs from its frozen plan");
  const members = suite.members.map(member => {
    const expected = plan.members.find(expected => expected.memberId === member.memberId);
    const receipt = result.members.find(receipt => receipt.memberId === member.memberId);
    if (!expected || !receipt || receipt.requestId !== expected.requestId || receipt.routineId !== expected.routineId
      || receipt.platform !== expected.platform || receipt.definitionRevision !== expected.definitionRevision
      || expected.hostId !== undefined && receipt.hostId !== expected.hostId
      || requestInputDigest(receipt.build ?? null) !== requestInputDigest(expected.build ?? null))
      throw new TestRunError(503, "Nightly member receipt differs from its frozen input");
    let input: RecordedInput | undefined;
    if ("routineRevision" in expected) {
      if (!("routineRevision" in receipt) || receipt.routineRevision !== expected.routineRevision
        || requestInputDigest(receipt.selection ?? null) !== requestInputDigest(expected.selection ?? null)
        || !expected.selection && requestInputDigest(receipt.dispatchIntent ?? null) !== requestInputDigest(expected.dispatchIntent ?? null)
        || (receipt.input === undefined) !== (receipt.inputSha256 === undefined)
        || receipt.publicationComplete && !receipt.input)
        throw new TestRunError(503, "Nightly member receipt differs from its frozen input");
      if (expected.selection && receipt.binding) {
        const binding = routineJobBindingSchema.safeParse(receipt.binding), intent = routineDispatchIntentSchema.safeParse(receipt.dispatchIntent);
        if (!binding.success || !intent.success || binding.data.jobId !== expected.requestId || binding.data.requestId !== expected.requestId
          || binding.data.hostId !== receipt.hostId || binding.data.laneId !== intent.data.laneId)
          throw new TestRunError(503, "Nightly member binding differs from its recorded owner");
        const {laneId: _lane, routineSource: boundSource, ...boundSelection} = intent.data;
        const {routineSource: frozenSource, ...frozenSelection} = expected.selection;
        if (requestInputDigest(boundSelection) !== requestInputDigest(frozenSelection) || frozenSource && requestInputDigest(boundSource) !== requestInputDigest(frozenSource))
          throw new TestRunError(503, "Nightly bound receipt differs from its frozen selection");
      }
      if (expected.selection && receipt.input && !receipt.binding) throw new TestRunError(503, "Nightly prepared receipt has no recorded binding");
      input = receipt.input ? nightlyPreparedInput({...expected, binding: receipt.binding, dispatchIntent: receipt.dispatchIntent}, receipt.input, receipt.inputSha256) : undefined;
    } else {
      // Historical occurrences froze the complete input in both plan and receipt.
      // Validate those original bytes; never manufacture a new dispatch intent.
      if ("routineRevision" in receipt || "dispatchIntent" in expected || "dispatchIntent" in receipt || "inputSha256" in receipt
        || receipt.definitionSha256 !== expected.definitionSha256
        || requestInputDigest(receipt.input ?? null) !== requestInputDigest(expected.input ?? null))
        throw new TestRunError(503, "Nightly member receipt differs from its frozen input");
      if (expected.input) {
        const parsed = recordedFrameworkRequestInputSchema.safeParse(expected.input);
        if (!parsed.success || parsed.data.routineId !== expected.routineId || parsed.data.platform !== expected.platform
          || parsed.data.definitionRevision !== expected.definitionRevision)
          throw new TestRunError(503, "Recorded nightly input provenance is unavailable");
        input = parsed.data;
      }
    }
    const build = input?.build ?? expected.build;
    const unavailableReason = nightlyUnassignedReason({reason: receipt.unavailableReason, startedAt: result.startedAt,
      observedAt: result.finishedAt, unassigned: "selection" in expected && !!expected.selection
        && !receipt.binding && !receipt.hostId && !receipt.runId && ["incomplete", "not-run"].includes(receipt.status)});
    return {...member, requestId: expected.requestId, routineRevision: "routineRevision" in expected ? expected.routineRevision : expected.definitionRevision,
      hostId: receipt.hostId ?? expected.hostId,
      ...(input?.laneId ? {laneId: input.laneId} : "dispatchIntent" in receipt && receipt.dispatchIntent ? {laneId: receipt.dispatchIntent.laneId}
        : "dispatchIntent" in expected && expected.dispatchIntent ? {laneId: expected.dispatchIntent.laneId} : {}),
      ...("dispatchIntent" in receipt && receipt.dispatchIntent ? {dispatchIntent: receipt.dispatchIntent} : {}),
      ...(input?.routineSource ? {routineSource: input.routineSource} : {}), ...(build ? {build} : {}), status: receipt.status === "incomplete" ? "not-run" : receipt.status,
      publicationComplete: receipt.publicationComplete,
      ...(unavailableReason ? {unavailableReason} : {}),
      ...(receipt.runId ? {runId: receipt.runId, startedAt: receipt.runStartedAt, finishedAt: receipt.runFinishedAt} : {})};
  });
  const passed = members.filter(member => member.status === "pass" && member.publicationComplete).length;
  return {...suite, ...(result.finishedAt ? {finishedAt: result.finishedAt} : {}), members, passed,
    outcome: !result.finishedAt ? "running" : passed === members.length ? "passed" : "failed",
    failedRoutines: [...new Set(members.filter(member => (result.finishedAt !== undefined || member.status !== "waiting")
      && (member.status !== "pass" || !member.publicationComplete)).map(member => member.routineId))]};
}
type BoundRequest = {requestId: string; hostId?: string | null; input?: unknown; inputSha256?: string | null;
  dispatchIntent?: unknown; dispatchIntentSha256?: string | null; state?: string; terminalStatus?: string | null; hostRejection?: unknown;
  hostReceipt?: HostAcceptance; publicationFailure?: unknown};

async function boundSuiteRequests(requestIds: string[]): Promise<BoundRequest[]> {
  if (!requestIds.length) return [];
  const requests = await TestRequestModel.find({requestId: {$in: requestIds}})
    .select({requestId: 1, hostId: 1, inputSha256: 1, input: 1, dispatchIntent: 1, dispatchIntentSha256: 1,
      state: 1, terminalStatus: 1, hostRejection: 1, hostReceipt: 1, publicationFailure: 1}).limit(101).read("primary").readConcern("majority").lean();
  if (requests.length > 100) throw new TestRunError(503, "suite request history exceeds the query bound; no verdict available");
  return requests as BoundRequest[];
}

/** Add known request location only; a frozen verdict never rereads later run evidence. */
function withRequestLanes(suite: ReturnType<typeof summarizeSuite>, requests: BoundRequest[]): ReturnType<typeof summarizeSuite> {
  return {...suite, members: suite.members.map(member => {
    if (!member.requestId || member.hostId && member.laneId) return member;
    const request = requests.find(request => request.requestId === member.requestId);
    if (!request || typeof request.hostId !== "string" || !frameworkIdentitySchema.safeParse(request.hostId).success) return member;
    let location: {routineId: string; platform: string; revision: string; laneId: string; channel: string; headSha: string} | undefined;
    if (request.input !== undefined) {
      const input = recordedFrameworkRequestInputSchema.safeParse(request.input);
      if (input.success && requestInputDigest(input.data) === request.inputSha256)
        location = {routineId: input.data.routineId, platform: input.data.platform, revision: input.data.definitionRevision,
          laneId: input.data.laneId, channel: input.data.build.channel, headSha: input.data.build.headSha};
    } else {
      const intent = routineDispatchIntentSchema.safeParse(request.dispatchIntent);
      if (intent.success && intent.data.requestId === request.requestId && requestInputDigest(intent.data) === request.dispatchIntentSha256)
        location = {routineId: intent.data.routineId, platform: intent.data.platform, revision: intent.data.routineRevision,
          laneId: intent.data.laneId, channel: intent.data.build.channel, headSha: intent.data.build.headSha};
    }
    if (!location || location.routineId !== member.routineId || location.platform !== member.platform
      || member.definitionRevision && location.revision !== member.definitionRevision
      || location.channel !== suite.channel || location.headSha !== (member.headSha ?? suite.build.headSha)
      || member.hostId && member.hostId !== request.hostId || member.laneId && member.laneId !== location.laneId) return member;
    return {...member, hostId: request.hostId, laneId: location.laneId};
  })};
}

function suiteRejections(requests: BoundRequest[]): SuiteRejection[] {
  return requests.filter(request => request.hostRejection !== undefined || request.publicationFailure !== undefined).map(request => {
    const input = recordedFrameworkRequestInputSchema.safeParse(request.input);
    if (request.publicationFailure !== undefined) {
      const failure = routinePublicationFailureSchema.safeParse(request.publicationFailure);
      if (!failure.success || !input.success || request.state !== "terminal"
        || failure.data.entityId !== request.requestId || request.hostReceipt?.requestId !== request.requestId
        || request.hostReceipt.hostId !== request.hostId || request.hostReceipt.inputSha256 !== request.inputSha256
        || requestInputDigest(input.data) !== request.inputSha256)
        throw new TestRunError(503, "suite member publication failure identity is invalid; no verdict available");
      return {requestId: request.requestId, routineId: input.data.routineId, platform: input.data.platform,
        definitionRevision: input.data.definitionRevision, channel: input.data.build.channel, headSha: input.data.build.headSha,
        rejectedAt: failure.data.rejectedAt, reason: `Publication failed: ${failure.data.message}`};
    }
    const rejection = hostRejectionSchema.safeParse(request.hostRejection);
    if (!rejection.success || !input.success || request.state !== "terminal" || request.terminalStatus !== "not-run"
      || rejection.data.requestId !== request.requestId || rejection.data.hostId !== request.hostId
      || rejection.data.inputSha256 !== request.inputSha256 || requestInputDigest(input.data) !== request.inputSha256)
      throw new TestRunError(503, "suite member rejection identity is invalid; no verdict available");
    return {requestId: request.requestId, routineId: input.data.routineId, platform: input.data.platform,
      definitionRevision: input.data.definitionRevision, channel: input.data.build.channel, headSha: input.data.build.headSha,
      rejectedAt: rejection.data.rejectedAt, reason: `${rejection.data.code}: ${rejection.data.reason}`};
  });
}

type SuiteSummary = ReturnType<typeof summarizeSuite>;
export type SuiteSummaryRead = SuiteSummary | Error;

/** Active execution comes from fresh controller custody, never from admission alone. */
function withLiveLaneActivity(suite: SuiteSummary, overview: LaneOverviewList, now: number): SuiteSummary {
  if (suite.finishedAt) return suite;
  return {...suite, members: suite.members.map(member => {
    if (member.status !== "waiting" || !member.requestId || !member.hostId || !member.laneId) return member;
    const host = overview.hosts.find(host => host.hostId === member.hostId);
    if (!host || !restorationHostIsFresh(host, now, overview.freshForMs)) return member;
    const lane = host.lanes.find(lane => lane.id === member.laneId && lane.platform === member.platform);
    return lane?.state === "running" && lane.activity?.owner.kind === "run"
      && lane.activity.owner.requestId === member.requestId && lane.activity.owner.id === member.requestId
      ? {...member, status: "running"} : member;
  })};
}

const compactNightlyMember = {
  memberId: "$$member.memberId", requestId: "$$member.requestId", routineId: "$$member.routineId",
  platform: "$$member.platform", definitionRevision: "$$member.definitionRevision", routineRevision: "$$member.routineRevision",
  hostId: "$$member.hostId", binding: "$$member.binding", portable: {$ne: [{$ifNull: ["$$member.selection", null]}, null]}, laneId: {$ifNull: ["$$member.dispatchIntent.laneId", "$$member.input.laneId"]},
  unavailableReason: "$$member.unavailableReason", rejectedAt: "$$member.rejectedAt",
  preparedLaneId: "$$member.input.laneId", status: "$$member.status", publicationComplete: "$$member.publicationComplete",
  runId: "$$member.runId", runStartedAt: "$$member.runStartedAt", runFinishedAt: "$$member.runFinishedAt",
  build: {$let: {vars: {build: {$ifNull: ["$$member.build", "$$member.input.build"]}},
    in: {$cond: [{$eq: [{$ifNull: ["$$build", null]}, null]}, "$$REMOVE",
      {repository: "$$build.repository", channel: "$$build.channel", headSha: "$$build.headSha", prNumber: "$$build.prNumber"}]}}},
};
const compactNightly = (field: string, open = false) => ({suiteId: `$${field}.suiteId`, occurrenceId: `$${field}.occurrenceId`,
  startedAt: `$${field}.startedAt`, trigger: `$${field}.trigger`, finishedAt: `$${field}.finishedAt`,
  expectedCount: `$${field}.expectedCount`, members: {$map: {input: `$${field}.members`, as: "member", in: {...compactNightlyMember, ...(open ? {dispatchIntent: "$$member.dispatchIntent", selection: "$$member.selection"} : {})}}}});
export const suiteHistoryProjection: PipelineStage.Project = {$project: {suiteId: 1, payload: 1, finishedAt: 1, completedResult: 1,
  nightlyPlan: {$cond: [{$eq: [{$ifNull: ["$nightlyPlan", null]}, null]}, "$$REMOVE",
    {$cond: [{$ne: [{$ifNull: ["$nightlyResult", null]}, null]}, compactNightly("nightlyPlan"), compactNightly("nightlyPlan", true)]}]},
  nightlyResult: {$cond: [{$ne: [{$ifNull: ["$nightlyResult", null]}, null]}, compactNightly("nightlyResult"), "$$REMOVE"]},
}};
interface CompactNightlyMember {
  memberId: string; requestId: string; routineId: string; platform: string; definitionRevision: string; routineRevision?: string;
  hostId?: string; laneId?: string; portable?: boolean; binding?: NightlyPlan["members"][number]["binding"]; preparedLaneId?: string; build?: {repository?: string; channel?: string; headSha?: string; prNumber?: number};
  status?: string; publicationComplete?: boolean; runId?: string; runStartedAt?: string; runFinishedAt?: string; unavailableReason?: string; rejectedAt?: string;
}
interface CompactNightlyReceipt {suiteId: string; occurrenceId: string; startedAt: string; trigger: string;
  finishedAt?: string; expectedCount?: number; members: CompactNightlyMember[]}

/** List integrity covers displayed bindings and verdicts; the detail reader verifies complete artifact/input digests. */
export function terminalNightlySummary(suite: TestSuite, plan: CompactNightlyReceipt, result: CompactNightlyReceipt): SuiteSummary {
  if (!result.finishedAt) throw new TestRunError(503, "Nightly summary has no terminal receipt");
  return nightlyHistorySummary(suite, plan, result);
}

function nightlyHistorySummary(suite: TestSuite, plan: CompactNightlyReceipt, result: CompactNightlyReceipt): SuiteSummary {
  const invalid = () => {throw new TestRunError(503, "Nightly summary differs from its frozen membership or receipt");};
  if (!testSuiteSchema.safeParse(suite).success || plan.suiteId !== suite.suiteId || result.suiteId !== suite.suiteId
    || plan.occurrenceId !== result.occurrenceId || plan.startedAt !== suite.startedAt || result.startedAt !== suite.startedAt
    || plan.trigger !== suite.trigger || result.trigger !== suite.trigger || result.expectedCount !== suite.members.length
    || plan.members.length !== suite.members.length || result.members.length !== suite.members.length
    || result.finishedAt !== undefined && (!Number.isFinite(Date.parse(result.finishedAt)) || Date.parse(result.finishedAt) < Date.parse(suite.startedAt))
    || new Set(plan.members.map(member => member.memberId)).size !== plan.members.length
    || new Set(result.members.map(member => member.memberId)).size !== result.members.length) invalid();
  const members = suite.members.map(member => {
    const expected = plan.members.find(row => row.memberId === member.memberId), receipt = result.members.find(row => row.memberId === member.memberId);
    if (!expected || !receipt || member.requestId !== undefined && expected.requestId !== member.requestId || receipt.requestId !== expected.requestId
      || expected.routineId !== member.routineId || receipt.routineId !== expected.routineId
      || expected.platform !== member.platform || receipt.platform !== expected.platform
      || !frameworkRunIdSchema.safeParse(expected.requestId).success || !/^[a-f0-9]{40}$/.test(expected.definitionRevision)
      || expected.hostId !== undefined && !frameworkIdentitySchema.safeParse(expected.hostId).success
      || expected.laneId !== undefined && !frameworkIdentitySchema.safeParse(expected.laneId).success
      || expected.build && !frameworkBuildSchema.safeParse(expected.build).success
      || expected.definitionRevision !== receipt.definitionRevision || member.definitionRevision && member.definitionRevision !== expected.definitionRevision
      || expected.routineRevision !== receipt.routineRevision || !expected.portable && expected.hostId !== receipt.hostId
      || requestInputDigest(JSON.parse(JSON.stringify(expected.build ?? null))) !== requestInputDigest(JSON.parse(JSON.stringify(receipt.build ?? null)))
      || expected.build?.headSha && expected.build.headSha !== (member.headSha ?? suite.build.headSha)
      || expected.build?.channel && expected.build.channel !== suite.channel
      || !expected.portable && expected.laneId !== receipt.laneId || receipt.preparedLaneId && receipt.preparedLaneId !== (expected.portable ? receipt.binding?.laneId : expected.laneId)
      || !["pass", "failed", "setup-failed", "teardown-failed", "cancelled", "incomplete", "not-run", ...(!result.finishedAt ? ["waiting"] : [])].includes(receipt.status ?? "")
      || typeof receipt.publicationComplete !== "boolean"
      || ["pass", "failed", "setup-failed", "teardown-failed", "cancelled"].includes(receipt.status ?? "") && !receipt.runId
      || receipt.runId && (!expected.build || !(expected.portable ? receipt.binding?.hostId : expected.hostId) || !(expected.portable ? receipt.binding?.laneId : expected.laneId))
      || expected.portable && receipt.binding && (!routineJobBindingSchema.safeParse(receipt.binding).success || receipt.binding.jobId !== expected.requestId || receipt.binding.requestId !== expected.requestId
        || receipt.binding.hostId !== receipt.hostId || receipt.binding.laneId !== receipt.laneId)
      || receipt.publicationComplete && (!receipt.runId || !receipt.preparedLaneId)
      || receipt.runId && (receipt.runId !== receipt.requestId || !receipt.runStartedAt || !receipt.runFinishedAt
        || !Number.isFinite(Date.parse(receipt.runStartedAt)) || !Number.isFinite(Date.parse(receipt.runFinishedAt))
        || Date.parse(receipt.runFinishedAt) < Date.parse(receipt.runStartedAt))) invalid();
    const unavailableReason = nightlyUnassignedReason({reason: receipt!.unavailableReason, startedAt: result.startedAt,
      observedAt: result.finishedAt, unassigned: !!expected!.portable && !receipt!.binding && !receipt!.hostId
        && !receipt!.runId && ["incomplete", "not-run"].includes(receipt!.status!)});
    return {...member, requestId: expected!.requestId, status: receipt!.status === "incomplete" ? "not-run" : receipt!.status!,
      publicationComplete: receipt!.publicationComplete, ...(unavailableReason ? {unavailableReason} : {}),
      ...(receipt!.rejectedAt ? {rejectedAt: receipt!.rejectedAt} : {}), ...((receipt!.hostId ?? expected!.hostId) ? {hostId: receipt!.hostId ?? expected!.hostId} : {}),
      ...((receipt!.laneId ?? expected!.laneId) ? {laneId: receipt!.laneId ?? expected!.laneId} : {}),
      ...(receipt!.runId ? {runId: receipt!.runId, startedAt: receipt!.runStartedAt, finishedAt: receipt!.runFinishedAt} : {})};
  });
  const passed = members.filter(member => member.status === "pass" && member.publicationComplete).length;
  return {...suite, ...(result.finishedAt ? {finishedAt: result.finishedAt} : {}), members, passed,
    outcome: !result.finishedAt ? "running" : passed === members.length ? "passed" : "failed",
    failedRoutines: [...new Set(members.filter(member => member.status !== "waiting"
      && (member.status !== "pass" || !member.publicationComplete)).map(member => member.routineId))]};
}

export class TestSuiteService {
  constructor(private readonly lanes: Pick<LaneRestorationService, "overview"> = new LaneRestorationService()) {}

  private async liveActivity(summaries: Map<string, SuiteSummaryRead>, deadline: number) {
    const hasActiveCandidate = [...summaries.values()].some(suite => !(suite instanceof Error) && !suite.finishedAt
      && suite.members.some(member => member.status === "waiting" && member.requestId && member.hostId && member.laneId));
    if (!hasActiveCandidate || deadline <= Date.now()) return summaries;
    try {
      const overview = await this.lanes.overview(deadline), now = Date.now();
      for (const [id, suite] of summaries) if (!(suite instanceof Error)) summaries.set(id, withLiveLaneActivity(suite, overview, now));
    } catch (error) {
      logger.warn({err: error}, "Optional suite lane activity unavailable");
    }
    return summaries;
  }

  /** One page reads existing frozen receipts and batches live inputs and verified summaries. */
  async summaries(suiteIds: string[], deadline: number): Promise<Map<string, SuiteSummaryRead>> {
    if (suiteIds.length > 100 || suiteIds.some(id => !frameworkRunIdSchema.safeParse(id).success))
      throw new TestRunError(400, "invalid suite summary query");
    if (!suiteIds.length) return new Map();
    const remaining = () => {
      const timeoutMS = deadline - Date.now();
      if (timeoutMS <= 0) throw new TestRunError(503, "Test history query timed out. Try again.");
      return {timeoutMS};
    };
    const rows = await TestSuiteModel.aggregate<{suiteId: string; payload?: TestSuite; nightlyPlan?: NightlyPlan | CompactNightlyReceipt;
      nightlyResult?: CompactNightlyReceipt; completedResult?: SuiteSummary; finishedAt?: string}>([
      {$match: {suiteId: {$in: suiteIds}}}, {$limit: suiteIds.length + 1}, suiteHistoryProjection,
    ]).read("primary").readConcern("majority").option(remaining()).exec();
    if (rows.length > suiteIds.length) throw new TestRunError(503, "Suite identity is ambiguous");
    const membersToRead = (row: typeof rows[number]) => {
      const members = row.nightlyPlan ? (row.nightlyPlan as NightlyPlan).members : row.payload?.members;
      return Array.isArray(members) ? members.filter(member => !row.nightlyPlan || "selection" in member && member.selection
        || "dispatchIntent" in member && member.dispatchIntent) : [];
    };
    const requestIds = [...new Set(rows.flatMap(row => {
      if (row.nightlyPlan && row.nightlyResult) return [];
      const suite = row.completedResult as SuiteSummary | undefined;
      if (suite) return Array.isArray(suite.members) ? suite.members.flatMap(member => member.requestId && (!member.hostId || !member.laneId) ? [member.requestId] : []) : [];
      return membersToRead(row).flatMap(member => member.requestId ? [member.requestId] : []);
    }))];
    if (requestIds.length > 10_000) throw new TestRunError(503, "Suite summary member count exceeds the query bound");
    const liveRequestIds = [...new Set(rows.filter(row => !row.completedResult && (!row.nightlyPlan || !row.nightlyResult))
      .flatMap(row => membersToRead(row).flatMap(member => member.requestId ? [member.requestId] : [])))];
    const [requests, results] = await Promise.all([
      requestIds.length ? TestRequestModel.find({requestId: {$in: requestIds}})
        .select({requestId: 1, hostId: 1, input: 1, inputSha256: 1, dispatchIntent: 1, dispatchIntentSha256: 1,
          state: 1, terminalStatus: 1, hostRejection: 1, hostReceipt: 1, publicationFailure: 1, preparation: 1, preparationCancellation: 1, preparationRejection: 1,
          fleetSelection: 1, fleetSelectionSha256: 1, fleetBinding: 1, fleetCancellation: 1, fleetDispatch: 1})
        .limit(requestIds.length + 1).read("primary").readConcern("majority").setOptions(remaining()).lean() : [],
      liveRequestIds.length ? TestRunModel.find({...nativeRunFilter, requestId: {$in: liveRequestIds}})
        .select(frameworkResultSummaryFields).limit(liveRequestIds.length + 1).read("primary").readConcern("majority")
        .setOptions(remaining()).lean() : [],
    ]);
    if (requests.length > requestIds.length || new Set(requests.map(row => row.requestId)).size !== requests.length
      || results.length > liveRequestIds.length || new Set(results.map(row => row.requestId)).size !== results.length)
      throw new TestRunError(503, "Suite member identity is ambiguous");
    const byRequest = new Map(requests.map(row => [row.requestId, row as StoredRequest]));
    const byResult = new Map(results.map(row => [row.requestId, row]));
    const readers = {requests: {get: async (id: string) => byRequest.get(id) ?? null}, results: {
      summary: async (id: string) => {
        const row = byResult.get(id);
        if (!row) throw new TestRunError(404, "Framework run was not found");
        return readFrameworkResultSummary(row, deadline);
      },
    }};
    const summaries = new Map<string, SuiteSummaryRead>();
    for (const row of rows) {
      try {
        if (!row.nightlyPlan && row.completedResult) {
          summaries.set(row.suiteId, withRequestLanes(row.completedResult as SuiteSummary, requests));
          continue;
        }
        const suite = row.payload as TestSuite | undefined;
        if (!suite) throw new TestRunError(404, "Occurrence has no multi-member test suite");
        if (row.nightlyPlan) {
          if (row.nightlyResult) summaries.set(row.suiteId, terminalNightlySummary(suite, row.nightlyPlan as CompactNightlyReceipt, row.nightlyResult));
          else {
            const plan = row.nightlyPlan as NightlyPlan;
            const snapshot = await new NightlyRoutineService().snapshot(plan, readers);
            const result = {...snapshot, members: snapshot.members.map(member => ({...member, portable: !!member.selection,
              laneId: (member as unknown as CompactNightlyMember).laneId ?? member.dispatchIntent?.laneId ?? member.input?.laneId,
              preparedLaneId: member.input?.laneId,
              ...(member.build ? {build: {repository: member.build.repository, channel: member.build.channel,
                headSha: member.build.headSha, ...(member.build.prNumber !== undefined ? {prNumber: member.build.prNumber} : {})}} : {})}))};
            summaries.set(row.suiteId, nightlyHistorySummary(suite, {...plan, members: plan.members.map(member => ({...member, portable: !!member.selection}))} as unknown as CompactNightlyReceipt, result));
          }
          continue;
        }
        const ids = new Set(suite.members.flatMap(member => member.requestId ? [member.requestId] : []));
        const runs: SuiteRun[] = await Promise.all(results.filter(row => ids.has(row.requestId!)).map(async row => {
          const run = await readFrameworkResultSummary(row, deadline);
          return {...run, channel: run.build.channel, provenance: {headSha: run.build.headSha},
            publicationComplete: run.uploadsComplete && run.evidenceStatus === "complete"};
        }));
        const bound = requests.filter(row => ids.has(row.requestId));
        summaries.set(row.suiteId, withRequestLanes(summarizeSuite(suite, runs, row.finishedAt ?? undefined, suiteRejections(bound)), bound));
      } catch (error) {summaries.set(row.suiteId, error instanceof Error ? error : new TestRunError(503, "Suite summary is unavailable"));}
    }
    return this.liveActivity(summaries, deadline);
  }
  /** Read-only presentation uses the same bounded summaries as test history. */
  async summary(suiteId: string, deadline = Date.now() + 10_000): Promise<SuiteSummary> {
    const summary = (await this.summaries([suiteId], deadline)).get(suiteId);
    if (summary instanceof Error) throw summary;
    if (!summary) throw new TestRunError(404, "Test suite was not found");
    return summary;
  }
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
    if (!row.nightlyPlan && row.completedResult) {
      const frozen = row.completedResult as ReturnType<typeof summarizeSuite>;
      const requestIds = frozen.members.flatMap(member => member.requestId && (!member.hostId || !member.laneId) ? [member.requestId] : []);
      return withRequestLanes(frozen, await boundSuiteRequests(requestIds));
    }
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
        hostId: run.hostId, laneId: run.laneId,
        channel: run.build.channel, provenance: {headSha: run.build.headSha},
        startedAt: run.startedAt, finishedAt: run.finishedAt, outcome: frameworkRunOutcome(run),
        publicationComplete: row.uploadsComplete === true && frameworkEvidenceComplete(run)};
    });
    const requests = await boundSuiteRequests(suite.members.flatMap(member => member.requestId ? [member.requestId] : []));
    const rejections = suiteRejections(requests);
    return withRequestLanes(summarizeSuite(suite, runs, row.finishedAt ?? undefined, rejections), requests);
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

import {createHash} from "node:crypto";
import {z} from "zod";
import {createLogger} from "@mentra/cloud-shared";
import {TestSuiteModel} from "../models/test-suite.model";
import {testWriteConcern} from "../models/test-write-concern";
import {frameworkIdentitySchema, frameworkRequestInputSchema} from "../types/framework-request.types";
import type {RoutineEnrollment} from "../types/routine-definition.types";
import {selectedBuildInput, type TestBuild, type TestBuildPlatform} from "../types/test-build.types";
import {testSuiteSchema, type TestSuite} from "../types/test-suite.types";
import {RoutineCatalogService} from "./routine-catalog.service";
import {GithubTestBuildGateway, TestDispatchError} from "./test-builds.service";
import {TestHostStateService, type ReceivedTestHostState} from "./test-host-state.service";
import {TestRequestService, requestInputDigest} from "./test-request.service";
import {FrameworkResultService} from "./framework-result.service";
import {TestRunError} from "./test-result-error";
import {configuredRoutineLanes, routineAdmissionInput, type RoutineLaneBindings} from "./routine-admission.service";

export const nightlyOccurrenceSchema = z.object({occurrenceId: frameworkIdentitySchema,
  startedAt: z.string().datetime({offset: true}), trigger: z.enum(["nightly", "manual"])}).strict();
type Occurrence = z.infer<typeof nightlyOccurrenceSchema>;
type RequestInput = z.infer<typeof frameworkRequestInputSchema>;
export interface NightlySelectionError {stage: "build" | "host" | "admission"; status?: number; message: string}
type PlatformSelection = {build?: TestBuild; host?: ReceivedTestHostState | null; errors: NightlySelectionError[]};
const logger = createLogger("core").child({service: "nightly-routine"});
export interface NightlyMember {
  memberId: string; routineId: string; platform: TestBuildPlatform; definitionRevision: string; definitionSha256: string;
  build?: ReturnType<typeof selectedBuildInput>;
  requestId: string; hostId?: string; input?: RequestInput; unavailableReason?: string; selectionErrors?: NightlySelectionError[];
}
export interface NightlyPlan extends Occurrence {suiteId: string; members: NightlyMember[]; suite?: TestSuite;
  publication?: {source: TestBuild["source"]; headSha: string; release?: string}}
export interface NightlyPlanRepository {
  get(suiteId: string): Promise<NightlyPlan | null>;
  freeze(plan: NightlyPlan): Promise<NightlyPlan>;
  completed(suiteId: string): Promise<NightlyResult | null>;
  finish(suiteId: string, result: NightlyResult): Promise<NightlyResult>;
}
export interface NightlyResult {occurrenceId: string; suiteId: string; startedAt: string; trigger: Occurrence["trigger"];
  members: (NightlyMember & {status: string; publicationComplete: boolean; runId?: string; runStartedAt?: string; runFinishedAt?: string})[];
  expectedCount: number; passed: number; status: string; resultUrl?: string; finishedAt?: string}
export const nightlyPlanRepository: NightlyPlanRepository = {
  async get(suiteId) {
    const row = await TestSuiteModel.findOne({suiteId}).read("primary").readConcern("majority").lean();
    return row?.nightlyPlan as NightlyPlan ?? null;
  },
  async freeze(plan) {
    try {await TestSuiteModel.create([{suiteId: plan.suiteId, startedAt: new Date(plan.startedAt), nightlyPlan: plan,
      ...(plan.suite ? {payload: plan.suite, payloadSha256: requestInputDigest(plan.suite)} : {})}], {writeConcern: testWriteConcern});}
    catch (error) {if ((error as {code?: number}).code !== 11000) throw error;}
    const saved = await this.get(plan.suiteId);
    if (!saved) throw new TestRunError(409, "Occurrence identity belongs to another suite");
    return saved;
  },
  async completed(suiteId) {
    const row = await TestSuiteModel.findOne({suiteId}).read("primary").readConcern("majority").lean();
    return row?.nightlyResult as NightlyResult ?? null;
  },
  async finish(suiteId, result) {
    await TestSuiteModel.updateOne({suiteId, nightlyResult: {$exists: false}},
      {$set: {nightlyResult: result, finishedAt: result.finishedAt}}, {writeConcern: testWriteConcern});
    const saved = await this.completed(suiteId);
    if (!saved) throw new TestRunError(503, "Nightly terminal receipt was not retained");
    return saved;
  },
};
const digestId = (value: unknown) => createHash("sha256").update(requestInputDigest(value)).digest("hex").slice(0, 32);
export const nightlySuiteId = (occurrenceId: string) => `nightly-${digestId(occurrenceId)}`;
const finite = <T>(value: T): T => JSON.parse(JSON.stringify(value));

/** One immutable occurrence selects the catalog once; host controllers own execution and resource allocation. */
export class NightlyRoutineService {
  constructor(private readonly catalog: Pick<RoutineCatalogService, "list"> = new RoutineCatalogService(),
    private readonly builds: {latestDev(platform: TestBuildPlatform, before: string): Promise<TestBuild | null>;
      resolve(source: TestBuild["source"], platform: TestBuildPlatform): Promise<TestBuild>} = new GithubTestBuildGateway(),
    private readonly hosts: Pick<TestHostStateService, "get"> = new TestHostStateService(),
    private readonly requests: Pick<TestRequestService, "cancel" | "get" | "submit"> = new TestRequestService(),
    private readonly repository: NightlyPlanRepository = nightlyPlanRepository,
    private readonly bindings: () => RoutineLaneBindings = configuredRoutineLanes,
    private readonly results: Pick<FrameworkResultService, "detail"> = new FrameworkResultService(),
    private readonly now: () => number = Date.now,
    private readonly logSelectionError: (error: unknown, context: {occurrenceId: string; platform: TestBuildPlatform; stage: NightlySelectionError["stage"]}) => void
      = (error, context) => logger.error({err: error, ...context}, "Nightly selection failed")) {}

  private selectionError(error: unknown, stage: NightlySelectionError["stage"], occurrenceId: string, platform: TestBuildPlatform): NightlySelectionError {
    if (error instanceof TestRunError || error instanceof TestDispatchError)
      return {stage, status: error.status, message: error.message.slice(0, 2000)};
    this.logSelectionError(error, {occurrenceId, platform, stage});
    return {stage, message: stage === "build" ? "Immutable build resolution is unavailable." : "Configured host observation is unavailable."};
  }

  async start(input: unknown) {
    const parsed = nightlyOccurrenceSchema.safeParse(input);
    if (!parsed.success) throw new TestRunError(400, "Invalid nightly occurrence");
    const occurrence = parsed.data, suiteId = nightlySuiteId(occurrence.occurrenceId);
    let plan = await this.repository.get(suiteId);
    if (!plan) plan = await this.repository.freeze(await this.select(occurrence, suiteId));
    if (requestInputDigest({occurrenceId: plan.occurrenceId, startedAt: plan.startedAt, trigger: plan.trigger}) !== requestInputDigest(occurrence))
      throw new TestRunError(409, "Occurrence retry changed its original trigger or boundary");
    // Each member is independent. A failed queue write is retried with its original immutable request ID/input.
    if (await this.repository.completed(suiteId) || this.now() >= Date.parse(plan.startedAt) + 3 * 3600_000)
      return {plan, admissions: []};
    const admissions = await Promise.all(plan.members.map(async member => {
      if (!member.input || !member.hostId) return {memberId: member.memberId, admitted: false, reason: member.unavailableReason};
      try {
        await this.requests.submit(member.requestId, member.hostId, member.input);
        if (await this.repository.completed(suiteId) || this.now() >= Date.parse(plan!.startedAt) + 3 * 3600_000)
          await this.requests.cancel(member.requestId, new Date(this.now()).toISOString(), "Nightly occurrence reached its completion boundary.");
        return {memberId: member.memberId, admitted: true};
      }
      catch {return {memberId: member.memberId, admitted: false, reason: "Request admission unavailable; retry this occurrence."};}
    }));
    return {plan, admissions};
  }

  private async select(occurrence: Occurrence, suiteId: string): Promise<NightlyPlan> {
    const catalog = (await this.catalog.list()).filter(row => row.nightlyEnabled !== false);
    if (catalog.length > 100) throw new TestRunError(503, "Nightly catalog exceeds the occurrence bound; no members were selected");
    const bindings = this.bindings(), platforms = [...new Set(catalog.map(row => row.platform))].sort();
    const selected = new Map<TestBuildPlatform, PlatformSelection>();
    let anchor: TestBuild | null = null;
    let anchorFailure: {error: unknown} | undefined;
    try {if (platforms[0]) anchor = await this.builds.latestDev(platforms[0], occurrence.startedAt);}
    catch (error) {anchorFailure = {error};}
    await Promise.all(platforms.map(async platform => {
      const binding = bindings[platform];
      const selection: PlatformSelection = {errors: []};
      // Resolve independently so an unavailable observation cannot discard an exact published artifact.
      const [artifact, observation] = await Promise.allSettled([
        anchorFailure ? Promise.reject(anchorFailure.error) : !anchor ? Promise.resolve(null)
          : platform === platforms[0] ? Promise.resolve(anchor) : this.builds.resolve(anchor.source, platform),
        binding ? this.hosts.get(binding.hostId) : Promise.resolve(null),
      ]);
      if (artifact.status === "fulfilled") {
        const build = artifact.value;
        if (anchor && build && (requestInputDigest(build.source) !== requestInputDigest(anchor.source)
          || build.headSha !== anchor.headSha || build.platform !== undefined && build.platform !== platform
          || anchor.release !== undefined && build.release !== undefined && build.release !== anchor.release))
          selection.errors.push({stage: "build", status: 409, message: "Platform artifact differs from the occurrence's frozen dev publication."});
        else if (build) selection.build = build;
      } else selection.errors.push(this.selectionError(artifact.reason, "build", occurrence.occurrenceId, platform));
      if (observation.status === "fulfilled") selection.host = observation.value;
      else selection.errors.push(this.selectionError(observation.reason, "host", occurrence.occurrenceId, platform));
      selected.set(platform, selection);
    }));
    const members = catalog.map(row => this.member(row, suiteId, bindings[row.platform], selected.get(row.platform)!));
    const firstBuild = members.find(member => member.build)?.build;
    const suiteHeadSha = anchor?.headSha ?? firstBuild?.headSha;
    const suiteRelease = anchor?.release ?? firstBuild?.releaseIdentity;
    const suite = members.length >= 2 && suiteHeadSha ? testSuiteSchema.parse({suiteId, channel: "dev", trigger: occurrence.trigger,
      startedAt: occurrence.startedAt, build: {headSha: suiteHeadSha,
        ...(typeof suiteRelease === "string" ? {release: suiteRelease} : {})},
      members: members.map(member => ({memberId: member.memberId, routineId: member.routineId, platform: member.platform,
        definitionRevision: member.definitionRevision, ...(member.input ? {requestId: member.requestId} : {}), ...(member.build ? {headSha: member.build.headSha} : {}),
        ...(member.unavailableReason ? {unavailableReason: member.unavailableReason} : {})}))}) : undefined;
    return finite({...occurrence, suiteId, members, ...(suite ? {suite} : {}),
      ...(anchor ? {publication: {source: anchor.source, headSha: anchor.headSha, ...(anchor.release ? {release: anchor.release} : {})}} : {})});
  }

  private member(row: RoutineEnrollment, suiteId: string, binding: RoutineLaneBindings[TestBuildPlatform],
    selected: PlatformSelection): NightlyMember {
    const memberId = `member-${digestId([row.routineId, row.platform])}`, requestId = `${suiteId}-${memberId}`;
    const buildInput = selected.build?.availability === "available" && selected.build.archive && selected.build.receipt ? selectedBuildInput(selected.build, row.platform) : undefined;
    const base = {memberId, requestId, routineId: row.routineId, platform: row.platform, definitionRevision: row.definitionRevision,
      definitionSha256: row.definitionSha256, ...(buildInput ? {build: buildInput} : {})};
    if (selected.errors.length) return {...base, selectionErrors: selected.errors,
      unavailableReason: selected.errors.map(error => error.message).join(" ").slice(0, 2000)};
    try {return {...base, hostId: binding?.hostId, input: routineAdmissionInput(row, selected.build, binding, selected.host, this.now())};}
    catch (error) {if (error instanceof TestRunError) return {...base, unavailableReason: error.message,
      selectionErrors: [{stage: "admission", status: error.status, message: error.message}]}; throw error;}
  }

  private async plan(occurrenceId: string) {
    if (!frameworkIdentitySchema.safeParse(occurrenceId).success) throw new TestRunError(400, "Invalid occurrence identity");
    const plan = await this.repository.get(nightlySuiteId(occurrenceId));
    if (!plan) throw new TestRunError(404, "Nightly occurrence was not found");
    return plan;
  }

  private unavailableEvidence(member: NightlyMember, error: unknown, source: "Result" | "Request"): NightlyResult["members"][number] {
    logger.error({err: error, requestId: member.requestId}, "Nightly member evidence read failed");
    return {...member, status: "waiting", publicationComplete: false,
      unavailableReason: error instanceof TestRunError
        ? `${source} evidence is unavailable (HTTP ${error.status}): ${error.message}`.slice(0, 2000)
        : `${source} evidence is unavailable.`};
  }

  async detail(occurrenceId: string): Promise<NightlyResult> {
    const plan = await this.plan(occurrenceId);
    const completed = await this.repository.completed(plan.suiteId);
    if (completed) return completed;
    return this.snapshot(plan);
  }

  private async snapshot(plan: NightlyPlan): Promise<NightlyResult> {
    const members: NightlyResult["members"] = await Promise.all(plan.members.map(async member => {
      if (!member.input) return {...member, status: "incomplete", publicationComplete: false};
      try {
        const result = await this.results.detail(member.requestId), run = result.run;
        if (run.routineId !== member.routineId || run.platform !== member.platform || run.definitionRevision !== member.definitionRevision
          || run.hostId !== member.hostId || run.laneId !== member.input.laneId || requestInputDigest(run.build) !== requestInputDigest(member.input.build))
          return {...member, status: "incomplete", publicationComplete: false, unavailableReason: "Result identity differs from the frozen request."};
        return {...member, status: result.outcome, publicationComplete: result.uploadsComplete && result.evidenceStatus === "complete",
          runId: run.result.runId, runStartedAt: run.startedAt, runFinishedAt: run.finishedAt};
      } catch (error) {
        if (!(error instanceof TestRunError) || error.status !== 404) return this.unavailableEvidence(member, error, "Result");
        let request;
        try {request = await this.requests.get(member.requestId);}
        catch (error) {return this.unavailableEvidence(member, error, "Request");}
        if (request?.hostRejection) {
          if (request.hostId !== member.hostId || request.inputSha256 !== requestInputDigest(member.input)
            || request.hostRejection.inputSha256 !== request.inputSha256 || request.hostRejection.hostId !== request.hostId)
            return {...member, status: "incomplete", publicationComplete: false, unavailableReason: "Host rejection identity differs from the frozen request."};
          return {...member, status: "incomplete", publicationComplete: false,
            unavailableReason: `${request.hostRejection.code}: ${request.hostRejection.reason}`};
        }
        return {...member, status: "waiting", publicationComplete: false};
      }
    }));
    const terminal = members.every(member => member.status === "incomplete" || member.status !== "waiting" && member.publicationComplete);
    const single = members.length === 1 ? members[0]! : undefined;
    let singleRequest;
    if (single?.input && !single.runId) {
      try {singleRequest = await this.requests.get(single.requestId);}
      catch (error) {logger.error({err: error, requestId: single.requestId}, "Nightly request link is unavailable");}
    }
    const singleResultId = single?.runId ?? (singleRequest && singleRequest.hostId === single?.hostId
      && singleRequest.inputSha256 === requestInputDigest(single!.input) ? single!.requestId : undefined);
    return {occurrenceId: plan.occurrenceId, suiteId: plan.suiteId, startedAt: plan.startedAt, trigger: plan.trigger,
      members, expectedCount: members.length, passed: members.filter(member => member.status === "pass" && member.publicationComplete).length,
      status: !members.length ? "skipped" : !terminal ? "running" : members.every(member => member.status === "pass" && member.publicationComplete) ? "pass"
        : members.some(member => member.status === "incomplete") ? "incomplete" : members.every(member => member.status === "cancelled") ? "cancelled" : "failed",
      ...(plan.suite ? {resultUrl: `https://admin.dev.mentraglass.com/?testSuite=${encodeURIComponent(plan.suiteId)}`}
        : singleResultId ? {resultUrl: `https://admin.dev.mentraglass.com/?testRun=${encodeURIComponent(singleResultId)}`} : {})};
  }

  async complete(occurrenceId: string) {
    const plan = await this.plan(occurrenceId), completed = await this.repository.completed(plan.suiteId);
    if (completed) return completed;
    const deadline = Date.parse(plan.startedAt) + 3 * 3600_000;
    let deadlineReached = this.now() >= deadline;
    const cancelAtDeadline = async () => {
      // Cancellation custody cannot depend on a result service being available.
      const cancellationAt = new Date(this.now()).toISOString();
      const eligible = plan.members.filter(member => member.input);
      const cancellations = await Promise.allSettled(eligible.map(member =>
        this.requests.cancel(member.requestId, cancellationAt, "Nightly occurrence reached its completion boundary.")));
      cancellations.forEach((result, index) => {
        if (result.status === "rejected") logger.error({err: result.reason, requestId: eligible[index]!.requestId}, "Nightly deadline cancellation failed");
      });
      if (cancellations.some(result => result.status === "rejected"))
        throw new TestRunError(503, "Nightly deadline cancellation is unavailable; retry this occurrence completion.");
    };
    if (deadlineReached) await cancelAtDeadline();
    const detail = await this.snapshot(plan);
    // Reads may cross the deadline. Finish cancellation custody before returning or freezing their snapshot.
    if (!deadlineReached && this.now() >= deadline) {
      deadlineReached = true;
      await cancelAtDeadline();
    }
    if (detail.status === "running" && !deadlineReached) return detail;
    const finishedAt = new Date(this.now()).toISOString();
    // The occurrence receipt is the only frozen verdict. Admin derives its suite projection from it.
    return this.repository.finish(plan.suiteId, finite({...detail, finishedAt,
      status: detail.status === "running" ? "incomplete" : detail.status,
      members: detail.members.map(member => member.status === "waiting" ? {...member, status: "incomplete",
        unavailableReason: member.unavailableReason ?? "No complete result was published before the occurrence deadline."} : member)}));
  }
}

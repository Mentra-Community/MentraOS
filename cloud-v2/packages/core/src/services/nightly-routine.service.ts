import {createHash} from "node:crypto";
import {z} from "zod";
import {createLogger} from "@mentra/cloud-shared";
import {TestSuiteModel} from "../models/test-suite.model";
import {testWriteConcern} from "../models/test-write-concern";
import {frameworkIdentitySchema, frameworkRequestInputSchema} from "../types/framework-request.types";
import type {RoutineEnrollment} from "../types/routine-definition.types";
import {routineDispatchIntentSchema, type RoutineDispatchIntent} from "../types/routine-dispatch.types";
import {GithubRoutineSourceGateway} from "./routine-source-selection.service";
import {selectedBuildInput, type TestBuild, type TestBuildPlatform} from "../types/test-build.types";
import {testSuiteSchema, type TestSuite} from "../types/test-suite.types";
import {RoutineCatalogService} from "./routine-catalog.service";
import {GithubTestBuildGateway, TestDispatchError} from "./test-builds.service";
import {TestRequestService, requestInputDigest, isExecutableRequest, type StoredRequest} from "./test-request.service";
import {FrameworkResultService} from "./framework-result.service";
import {TestRunError} from "./test-result-error";
import {portableRoutineSelectionSchema, routineJobBindingSchema, routinePublicationFailureSchema, type PortableRoutineSelection, type RoutineJobBinding, type StoredRoutineJob} from "../types/routine-job.types";
import {RoutineJobService} from "./routine-job.service";
import {NIGHTLY_COMPLETION_BOUNDARY_REASON, nightlyUnassignedReason} from "./nightly-deadline-reason";

export const nightlyOccurrenceSchema = z.object({occurrenceId: frameworkIdentitySchema,
  startedAt: z.string().datetime({offset: true}), trigger: z.enum(["nightly", "manual"])}).strict();
type Occurrence = z.infer<typeof nightlyOccurrenceSchema>;
const nightlyCancellationSchema = z.object({requestedAt: z.string().datetime({offset: true}), reason: z.string().min(1).max(2000)}).strict();
export type NightlyCancellation = z.infer<typeof nightlyCancellationSchema>;
type RequestInput = z.infer<typeof frameworkRequestInputSchema>;
export interface NightlySelectionError {stage: "build" | "host" | "admission"; status?: number; message: string}
type PlatformSelection = {build?: TestBuild; errors: NightlySelectionError[]};
const logger = createLogger("core").child({service: "nightly-routine"});
export interface NightlyMember {
  memberId: string; routineId: string; platform: TestBuildPlatform; routineRevision: string; definitionRevision: string;
  build?: ReturnType<typeof selectedBuildInput> & {manifest?: TestBuild["manifest"];manifestSha256?: string};
  requestId: string; selection?: PortableRoutineSelection; binding?: RoutineJobBinding; hostId?: string; dispatchIntent?: RoutineDispatchIntent; unavailableReason?: string; selectionErrors?: NightlySelectionError[];
}
export interface NightlyPlan extends Occurrence {suiteId: string; members: NightlyMember[]; suite?: TestSuite;
  publication?: {source: TestBuild["source"]; headSha: string; release?: string}}
export interface NightlyPlanRepository {
  get(suiteId: string): Promise<NightlyPlan | null>;
  freeze(plan: NightlyPlan): Promise<NightlyPlan>;
  completed(suiteId: string): Promise<NightlyResult | null>;
  finish(suiteId: string, result: NightlyResult): Promise<NightlyResult>;
  cancellation(suiteId: string): Promise<NightlyCancellation | null>;
  requestCancellation(suiteId: string, cancellation: NightlyCancellation): Promise<NightlyCancellation>;
}
export interface NightlyResult {occurrenceId: string; suiteId: string; startedAt: string; trigger: Occurrence["trigger"];
  members: (NightlyMember & {input?: RequestInput; inputSha256?: string; status: string; publicationComplete: boolean; runId?: string; runStartedAt?: string; runFinishedAt?: string})[];
  expectedCount: number; passed: number; status: string; resultUrl?: string; finishedAt?: string; cancellation?: NightlyCancellation}
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
  async cancellation(suiteId) {
    const row = await TestSuiteModel.findOne({suiteId}).read("primary").readConcern("majority").lean();
    return row?.nightlyCancellation ? nightlyCancellationSchema.parse(row.nightlyCancellation) : null;
  },
  async requestCancellation(suiteId, cancellation) {
    await TestSuiteModel.updateOne({suiteId, nightlyPlan: {$exists: true}, nightlyCancellation: {$exists: false}},
      {$set: {nightlyCancellation: nightlyCancellationSchema.parse(cancellation)}}, {writeConcern: testWriteConcern});
    const saved = await this.cancellation(suiteId);
    if (!saved) throw new TestRunError(503, "Nightly cancellation intent was not retained");
    return saved;
  },
};
const digestId = (value: unknown) => createHash("sha256").update(requestInputDigest(value)).digest("hex").slice(0, 32);
export const nightlySuiteId = (occurrenceId: string) => `nightly-${digestId(occurrenceId)}`;
const finite = <T>(value: T): T => JSON.parse(JSON.stringify(value));

/** A prepared request may add source/resources, but cannot change the frozen source or app selection. */
export function nightlyPreparedInput(member: NightlyMember, value: unknown, digest: string | undefined): RequestInput {
  const input = frameworkRequestInputSchema.safeParse(value), intent = member.dispatchIntent ?? member.selection;
  if (!input.success || !intent || digest !== requestInputDigest(input.data) || input.data.routineId !== intent.routineId
    || input.data.platform !== intent.platform || input.data.definitionRevision !== intent.routineRevision
    || member.dispatchIntent && input.data.laneId !== member.dispatchIntent.laneId
    || member.binding && input.data.laneId !== member.binding.laneId || input.data.minimumFrameworkVersion !== intent.minimumFrameworkVersion
    || requestInputDigest(input.data.build) !== requestInputDigest(intent.build)
    || intent.routineSource && requestInputDigest(input.data.routineSource) !== requestInputDigest(intent.routineSource))
    throw new TestRunError(503, "Nightly member receipt differs from its frozen input");
  return input.data;
}

/** One immutable occurrence selects the catalog once; host controllers own execution and resource allocation. */
export class NightlyRoutineService {
  private completionCursor?: {startedAt: Date; suiteId: string};

  constructor(private readonly catalog: Pick<RoutineCatalogService, "list"> = new RoutineCatalogService(),
    private readonly builds: {latestDev(platform: TestBuildPlatform, before: string): Promise<TestBuild | null>;
      resolve(source: TestBuild["source"], platform: TestBuildPlatform): Promise<TestBuild>} = new GithubTestBuildGateway(),
    private readonly requests: Pick<TestRequestService, "get"> = new TestRequestService(),
    private readonly repository: NightlyPlanRepository = nightlyPlanRepository,
    private readonly results: Pick<FrameworkResultService, "summary"> = new FrameworkResultService(),
    private readonly now: () => number = Date.now,
    private readonly logSelectionError: (error: unknown, context: {occurrenceId: string; platform: TestBuildPlatform; stage: NightlySelectionError["stage"]}) => void
      = (error, context) => logger.error({err: error, ...context}, "Nightly selection failed"),
    private readonly sources: Pick<GithubRoutineSourceGateway, "resolve"> = new GithubRoutineSourceGateway(),
    private readonly jobs: Pick<RoutineJobService, "submitFrozen" | "cancelFrozen" | "cancel"> = new RoutineJobService()) {}

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
    // Each member is independent. A failed queue write is retried with its original immutable request ID/intent.
    const cancellation = await this.repository.cancellation(suiteId);
    if (cancellation || await this.repository.completed(suiteId) || this.now() >= Date.parse(plan.startedAt) + 3 * 3600_000) {
      await this.cancelAdmissions(plan, cancellation);
      return {plan, admissions: []};
    }
    const deadline = new Date(Date.parse(plan.startedAt) + 3 * 3600_000).toISOString();
    const admissions = await Promise.all(plan.members.map(async member => {
      if (!member.selection) return {memberId: member.memberId, admitted: false, reason: member.unavailableReason};
      try {
        await this.jobs.submitFrozen(member.selection, deadline);
        // Fence a lost admission acknowledgement after occurrence cancellation/deadline.
        const cancellation = await this.repository.cancellation(suiteId);
        if (cancellation || await this.repository.completed(suiteId) || this.now() >= Date.parse(deadline))
          await this.jobs.cancel(member.requestId, {reason: cancellation?.reason ?? NIGHTLY_COMPLETION_BOUNDARY_REASON});
        return {memberId: member.memberId, admitted: true};
      } catch {
        return {memberId: member.memberId, admitted: false, reason: "Request admission unavailable; retry this occurrence."};
      }
    }));
    return {plan, admissions};
  }

  private async select(occurrence: Occurrence, suiteId: string): Promise<NightlyPlan> {
    const catalog = (await this.catalog.list()).filter(row => row.nightlyEnabled !== false)
      .map(row => ({routineId: row.routineId, platform: row.platform}));
    if (catalog.length > 100) throw new TestRunError(503, "Nightly catalog exceeds the occurrence bound; no members were selected");
    const routineRevision = catalog.length ? await this.sources.resolve() : undefined;
    const platforms = [...new Set(catalog.map(row => row.platform))].sort();
    const selected = new Map<TestBuildPlatform, PlatformSelection>();
    let anchor: TestBuild | null = null;
    let anchorFailure: {error: unknown} | undefined;
    try {if (platforms[0]) anchor = await this.builds.latestDev(platforms[0], occurrence.startedAt);}
    catch (error) {anchorFailure = {error};}
    await Promise.all(platforms.map(async platform => {
      const selection: PlatformSelection = {errors: []};
      // Resolve independently so an unavailable observation cannot discard an exact published artifact.
      const [artifact] = await Promise.allSettled([
        anchorFailure ? Promise.reject(anchorFailure.error) : !anchor ? Promise.resolve(null)
          : platform === platforms[0] ? Promise.resolve(anchor) : this.builds.resolve(anchor.source, platform),
      ]);
      if (artifact.status === "fulfilled") {
        const build = artifact.value;
        if (anchor && build && (requestInputDigest(build.source) !== requestInputDigest(anchor.source)
          || build.headSha !== anchor.headSha || build.platform !== undefined && build.platform !== platform
          || anchor.release !== undefined && build.release !== undefined && build.release !== anchor.release))
          selection.errors.push({stage: "build", status: 409, message: "Platform artifact differs from the occurrence's frozen dev publication."});
        else if (build) selection.build = build;
      } else selection.errors.push(this.selectionError(artifact.reason, "build", occurrence.occurrenceId, platform));
      selected.set(platform, selection);
    }));
    const members = catalog.map(row => this.member(row, routineRevision!, suiteId, selected.get(row.platform)!));
    const firstBuild = members.find(member => member.build)?.build;
    const suiteHeadSha = anchor?.headSha ?? firstBuild?.headSha;
    const suiteRelease = anchor?.release ?? firstBuild?.releaseIdentity;
    const suite = members.length >= 2 && suiteHeadSha ? testSuiteSchema.parse({suiteId, channel: "dev", trigger: occurrence.trigger,
      startedAt: occurrence.startedAt, build: {headSha: suiteHeadSha,
        ...(typeof suiteRelease === "string" ? {release: suiteRelease} : {})},
      members: members.map(member => ({memberId: member.memberId, routineId: member.routineId, platform: member.platform,
        definitionRevision: member.definitionRevision, ...(member.selection ? {requestId: member.requestId} : {}), ...(member.build ? {headSha: member.build.headSha} : {}),
        ...(member.unavailableReason ? {unavailableReason: member.unavailableReason} : {})}))}) : undefined;
    return finite({...occurrence, suiteId, members, ...(suite ? {suite} : {}),
      ...(anchor ? {publication: {source: anchor.source, headSha: anchor.headSha, ...(anchor.release ? {release: anchor.release} : {})}} : {})});
  }

  private member(row: Pick<RoutineEnrollment, "routineId" | "platform">, routineRevision: string, suiteId: string, selected: PlatformSelection): NightlyMember {
    const memberId = `member-${digestId([row.routineId, row.platform])}`, requestId = `${suiteId}-${memberId}`;
    const buildInput = selected.build?.availability === "available" && selected.build.archive && selected.build.receipt ? {...selectedBuildInput(selected.build, row.platform), ...(selected.build.manifest ? {manifest:selected.build.manifest,manifestSha256:selected.build.manifestSha256} : {})} : undefined;
    const base = {memberId, requestId, routineId: row.routineId, platform: row.platform, routineRevision, definitionRevision: routineRevision, ...(buildInput ? {build: buildInput} : {})};
    if (selected.errors.length) return {...base, selectionErrors: selected.errors,
      unavailableReason: selected.errors.map(error => error.message).join(" ").slice(0, 2000)};
    try {
      if (!buildInput) throw new TestRunError(409, selected.build?.reason ?? "No immutable artifact is available for this platform.");
      const selection = portableRoutineSelectionSchema.parse({requestId, routineId: row.routineId, platform: row.platform,
        routineRevision, source: selected.build!.source, build: buildInput});
      return {...base, selection};
    }
    catch (error) {if (error instanceof TestRunError) return {...base, unavailableReason: error.message,
      selectionErrors: [{stage: "admission", status: error.status, message: error.message}]}; throw error;}
  }

  private async plan(occurrenceId: string) {
    if (!frameworkIdentitySchema.safeParse(occurrenceId).success) throw new TestRunError(400, "Invalid occurrence identity");
    const plan = await this.repository.get(nightlySuiteId(occurrenceId));
    if (!plan) throw new TestRunError(404, "Nightly occurrence was not found");
    return plan;
  }

  async cancel(occurrenceId: string, input: unknown) {
    const parsed = z.object({reason: z.string().min(1).max(2000)}).strict().safeParse(input);
    if (!parsed.success) throw new TestRunError(400, "Invalid nightly cancellation");
    const plan = await this.plan(occurrenceId);
    // Persist the occurrence fence before any member writes. A lost acknowledgement or process restart retries the same intent.
    const cancellation = await this.repository.requestCancellation(plan.suiteId,
      {requestedAt: new Date(this.now()).toISOString(), reason: parsed.data.reason});
    await this.cancelAdmissions(plan, cancellation);
    // Custody acknowledges cooperative cancellation; actual executor/writer settlement remains the controller's responsibility.
    return {occurrenceId: plan.occurrenceId, suiteId: plan.suiteId, cancellation, requestsCancellationRecorded: true};
  }

  private async cancelAdmissions(plan: NightlyPlan, cancellation?: NightlyCancellation | null) {
    // Retain a cancellation record for absent and uncertain admissions before freezing the occurrence.
    const eligible = plan.members.filter(member => member.selection);
    const deadline = new Date(Date.parse(plan.startedAt) + 3 * 3600_000).toISOString();
    const cancellations = await Promise.allSettled(eligible.map(async member => {
      await this.jobs.cancelFrozen(member.selection!, deadline,
        {reason: cancellation?.reason ?? NIGHTLY_COMPLETION_BOUNDARY_REASON});
    }));
    cancellations.forEach((result, index) => {
      if (result.status === "rejected") logger.error({err: result.reason, requestId: eligible[index]!.requestId}, "Nightly deadline cancellation failed");
    });
    if (cancellations.some(result => result.status === "rejected"))
      throw new TestRunError(503, cancellation ? "Nightly cancellation is unavailable; retry this occurrence cancellation."
        : "Nightly deadline cancellation is unavailable; retry this occurrence completion.");
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
    const detail = await this.snapshot(plan), cancellation = await this.repository.cancellation(plan.suiteId);
    return cancellation ? {...detail, cancellation} : detail;
  }

  /** Canonical live verdict; list readers may supply page-scoped batch lookups. */
  async snapshot(plan: NightlyPlan, readers: {requests: Pick<TestRequestService, "get">; results: Pick<FrameworkResultService, "summary">}
    = {requests: this.requests, results: this.results}): Promise<NightlyResult> {
    const settledUploads = new Set<string>();
    const members: NightlyResult["members"] = await Promise.all(plan.members.map(async member => {
      if (!member.selection && !member.dispatchIntent) return {...member, status: "incomplete", publicationComplete: false};
      let request: StoredRequest | null;
      try {request = await readers.requests.get(member.requestId);}
      catch (error) {return this.unavailableEvidence(member, error, "Request");}
      if (!request) return {...member, status: "waiting", publicationComplete: false};
      let boundMember = member;
      if (member.selection) {
        const job = request as unknown as StoredRoutineJob;
        if (request.requestId !== member.requestId || !portableRoutineSelectionSchema.safeParse(job.fleetSelection).success || requestInputDigest(job.fleetSelection) !== job.fleetSelectionSha256
          || requestInputDigest(job.fleetSelection) !== requestInputDigest(member.selection))
          return {...member, status: "incomplete", publicationComplete: false, unavailableReason: "Request identity differs from the frozen selection."};
        if (!job.fleetBinding) {
          const recordedWaitingReason = job.preparation?.reason ?? job.fleetDispatch?.error;
          return {...member, status: job.fleetCancellation ? "incomplete" : "waiting", publicationComplete: false,
            unavailableReason: nightlyUnassignedReason({reason: job.fleetCancellation?.reason ?? recordedWaitingReason
              ?? (job.state === "awaiting-source" ? "Awaiting exact routine source preparation." : "Awaiting compatible runner."),
              startedAt: plan.startedAt, observedAt: job.fleetCancellation?.requestedAt, unassigned: true, recordedWaitingReason})};
        }
        const binding = routineJobBindingSchema.safeParse(job.fleetBinding), intent = routineDispatchIntentSchema.safeParse(request.dispatchIntent);
        if (!binding.success || !intent.success || binding.data.jobId !== member.requestId || binding.data.requestId !== member.requestId || request.hostId !== binding.data.hostId || intent.data.laneId !== binding.data.laneId
          || request.dispatchIntentSha256 !== requestInputDigest(intent.data) || job.fleetPreparation && requestInputDigest(intent.data.routineSource) !== requestInputDigest(job.fleetPreparation.routineSource))
          return {...member, status: "incomplete", publicationComplete: false, unavailableReason: "Bound request identity differs from its assignment."};
        const {laneId: _lane, routineSource: _source, ...boundSelection} = intent.data;
        const {routineSource: selectedSource, ...expectedSelection} = member.selection;
        if (requestInputDigest(boundSelection) !== requestInputDigest(expectedSelection) || selectedSource && requestInputDigest(_source) !== requestInputDigest(selectedSource))
          return {...member, status: "incomplete", publicationComplete: false, unavailableReason: "Bound request source differs from the frozen selection."};
        boundMember = {...member, hostId: binding.data.hostId, binding: binding.data, dispatchIntent: intent.data};
      } else if (request.requestId !== member.requestId || request.hostId !== member.hostId || request.dispatchIntentSha256 !== requestInputDigest(member.dispatchIntent)
        || !request.dispatchIntent || requestInputDigest(request.dispatchIntent) !== request.dispatchIntentSha256)
        return {...member, status: "incomplete", publicationComplete: false, unavailableReason: "Request identity differs from the frozen intent."};
      if (!isExecutableRequest(request)) return {...boundMember, status: request.state === "terminal" ? "incomplete" : "waiting", publicationComplete: false,
        ...(request.preparationRejection ? {unavailableReason: `${request.preparationRejection.code}: ${request.preparationRejection.reason}`}
          : request.preparationCancellation ? {unavailableReason: request.preparationCancellation.reason}
          : request.preparation ? {unavailableReason: `${request.preparation.code}: ${request.preparation.reason}`} : {})};
      let input: RequestInput;
      try {input = nightlyPreparedInput(boundMember, request.input, request.inputSha256);}
      catch {return {...boundMember, status: "incomplete", publicationComplete: false, unavailableReason: "Prepared input differs from the frozen intent."};}
      const prepared = {...boundMember, input, inputSha256: request.inputSha256};
      try {
        const result = await readers.results.summary(member.requestId), run = result;
        if (run.requestId !== member.requestId || run.routineId !== input.routineId || run.platform !== input.platform || run.definitionRevision !== input.definitionRevision
          || run.hostId !== boundMember.hostId || run.laneId !== input.laneId || requestInputDigest(run.build) !== requestInputDigest(input.build)
          || !run.routineSource || requestInputDigest(run.routineSource) !== requestInputDigest(input.routineSource))
          return {...prepared, status: "incomplete", publicationComplete: false, unavailableReason: "Result identity differs from the frozen request."};
        if (result.uploadsComplete) settledUploads.add(member.requestId);
        return {...prepared, status: result.outcome, publicationComplete: result.uploadsComplete && result.evidenceStatus === "complete",
          runId: run.runId, runStartedAt: run.startedAt, runFinishedAt: run.finishedAt};
      } catch (error) {
        if (!(error instanceof TestRunError) || error.status !== 404) return {...this.unavailableEvidence(boundMember, error, "Result"), input, inputSha256: request.inputSha256};
        if (request.publicationFailure) {
          const failure = routinePublicationFailureSchema.safeParse(request.publicationFailure);
          if (!failure.success || failure.data.entityId !== member.requestId || request.hostReceipt?.requestId !== member.requestId
            || request.hostReceipt.hostId !== request.hostId || request.hostReceipt.inputSha256 !== request.inputSha256)
            return {...prepared, status: "incomplete", publicationComplete: false,
              unavailableReason: "Publication failure identity differs from the frozen request."};
          return {...prepared, status: "incomplete", publicationComplete: false,
            unavailableReason: `Publication failed: ${failure.data.message}`};
        }
        if (request.hostRejection) {
          if (request.hostRejection.inputSha256 !== request.inputSha256 || request.hostRejection.hostId !== request.hostId)
            return {...prepared, status: "incomplete", publicationComplete: false, unavailableReason: "Host rejection identity differs from the frozen request."};
          return {...prepared, status: "incomplete", publicationComplete: false,
            unavailableReason: `${request.hostRejection.code}: ${request.hostRejection.reason}`};
        }
        return {...prepared, status: "waiting", publicationComplete: false};
      }
    }));
    // A failed recording cannot become complete; acknowledged uploads still settle that member.
    // Pass eligibility still requires complete evidence; terminality only requires upload settlement.
    const terminal = members.every(member => member.status === "incomplete" || member.status !== "waiting" && settledUploads.has(member.requestId));
    const single = members.length === 1 ? members[0]! : undefined;
    const singleResultId = single?.runId ?? (single?.selection || single?.dispatchIntent ? single.requestId : undefined);
    return {occurrenceId: plan.occurrenceId, suiteId: plan.suiteId, startedAt: plan.startedAt, trigger: plan.trigger,
      members, expectedCount: members.length, passed: members.filter(member => member.status === "pass" && member.publicationComplete).length,
      status: !members.length ? "skipped" : !terminal ? "running" : members.every(member => member.status === "pass" && member.publicationComplete) ? "pass"
        : members.some(member => member.status === "incomplete") ? "incomplete" : members.every(member => member.status === "cancelled") ? "cancelled" : "failed",
      ...(plan.suite ? {resultUrl: `https://admin.dev.mentraglass.com/?testSuite=${encodeURIComponent(plan.suiteId)}`}
        : singleResultId ? {resultUrl: `https://admin.dev.mentraglass.com/?testRun=${encodeURIComponent(singleResultId)}`} : {})};
  }

  /** Cancelled or expired occurrences finish even if their initiating CI process stopped. */
  async reconcilePending() {
    const filter = {nightlyPlan: {$exists: true}, nightlyResult: {$exists: false},
      // Input-based historical occurrences are finalized once from their original receipts.
      "nightlyPlan.members.input": {$exists: false},
      $or: [{nightlyCancellation: {$exists: true}}, {startedAt: {$lte: new Date(this.now() - 3 * 3600_000)}}]};
    const readBatch = () => TestSuiteModel.find(this.completionCursor ? {...filter, $and: [{$or: [
      {startedAt: {$gt: this.completionCursor.startedAt}},
      {startedAt: this.completionCursor.startedAt, suiteId: {$gt: this.completionCursor.suiteId}},
    ]}]} : filter)
      .select({"nightlyPlan.occurrenceId": 1, suiteId: 1, startedAt: 1}).sort({startedAt: 1, suiteId: 1}).limit(20)
      .read("primary").readConcern("majority").setOptions({timeoutMS: 10_000}).lean();
    let rows = await readBatch();
    if (!rows.length && this.completionCursor) {this.completionCursor = undefined; rows = await readBatch();}
    // Advance even when an occurrence fails; it is retried after the bounded scan wraps.
    const last = rows.at(-1);
    if (last) this.completionCursor = {startedAt: last.startedAt!, suiteId: last.suiteId};
    await Promise.allSettled(rows.map(async row => {
      try {await this.complete(row.nightlyPlan.occurrenceId);}
      catch (error) {logger.error({err: error, suiteId: row.suiteId}, "Nightly completion will retry");}
    }));
  }

  async complete(occurrenceId: string) {
    const plan = await this.plan(occurrenceId), completed = await this.repository.completed(plan.suiteId),
      cancellation = await this.repository.cancellation(plan.suiteId);
    if (completed) {await this.cancelAdmissions(plan, cancellation); return completed;}
    const deadline = Date.parse(plan.startedAt) + 3 * 3600_000;
    let deadlineReached = this.now() >= deadline;
    if (deadlineReached || cancellation) await this.cancelAdmissions(plan, cancellation);
    const detail = await this.snapshot(plan);
    // Reads may cross the deadline. Finish cancellation custody before returning or freezing their snapshot.
    if (!deadlineReached && this.now() >= deadline) {
      deadlineReached = true;
      await this.cancelAdmissions(plan, cancellation);
    }
    if (detail.status === "running" && !deadlineReached) return cancellation ? {...detail, cancellation} : detail;
    if (!deadlineReached && !cancellation) await this.cancelAdmissions(plan);
    const finishedAt = new Date(this.now()).toISOString();
    // The occurrence receipt is the only frozen verdict. Admin derives its suite projection from it.
    return this.repository.finish(plan.suiteId, finite({...detail, finishedAt, ...(cancellation ? {cancellation} : {}),
      status: detail.status === "running" ? "incomplete" : detail.status,
      members: detail.members.map(member => member.status === "waiting" ? {...member, status: "incomplete",
        unavailableReason: member.unavailableReason ?? "No complete result was published before the occurrence deadline."} : member)}));
  }
}

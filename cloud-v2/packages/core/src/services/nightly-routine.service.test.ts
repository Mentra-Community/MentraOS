import {testRoutineSource, testFrameworkBinding} from "../testing/framework-fixtures"
import {expect, spyOn, test} from "bun:test";
import {NightlyRoutineService as ActualNightlyRoutineService, nightlyPlanRepository, type NightlyPlan, type NightlyResult, type NightlyPlanRepository, type NightlyCancellation} from "./nightly-routine.service";
import {TestSuiteModel} from "../models/test-suite.model";
import {TestRequestModel} from "../models/test-request.model";
import type {RoutineCatalogService} from "./routine-catalog.service";
import {routineEnrollmentSchema} from "../types/routine-definition.types";
import type {TestBuild} from "../types/test-build.types";
import type {ReceivedTestHostState} from "./test-host-state.service";
import {TestRunError} from "./test-result-error";
import {TestSuiteService} from "./test-suite.service";
import {requestInputDigest, TestRequestService, type StoredRequest, type StoredPreparingRequest, type TestRequestRepository} from "./test-request.service";
import {routineDispatchIntentSchema} from "../types/routine-dispatch.types";
import {TestDispatchError} from "./test-builds.service";
import {RoutineJobService, routineLaneDescriptorRevision, type RoutineJobRepository} from './routine-job.service';
import type {StoredRoutineJob} from '../types/routine-job.types';

const mainRevision = "7".repeat(40);
// Old targeted test inputs are adapted into portable submission at the test boundary.
class NightlyRoutineService extends ActualNightlyRoutineService {
  constructor(...legacy: [catalog?: Pick<RoutineCatalogService, 'list'>,
    builds?: {latestDev(platform: 'android' | 'ios-on-mac', before: string): Promise<TestBuild | null>; resolve(source: TestBuild['source'], platform: 'android' | 'ios-on-mac'): Promise<TestBuild>},
    hosts?: Pick<import('./test-host-state.service').TestHostStateService, 'get'>,
    requests?: Pick<TestRequestService, 'cancelPreparationSubmission' | 'get' | 'prepare'>,
    repository?: NightlyPlanRepository, bindings?: () => import('./routine-admission.service').RoutineLaneBindings,
    results?: Pick<import('./framework-result.service').FrameworkResultService, 'summary'>,
    now?: () => number, log?: ConstructorParameters<typeof ActualNightlyRoutineService>[6],
    sources?: ConstructorParameters<typeof ActualNightlyRoutineService>[7]]) {
    const [catalog, builds, _hosts, requests, repository, _bindings, results, now, log, sources] = legacy;
    const admitted = new Map<string, any>();
    const jobs = {async cancelFrozen(selection: any, _deadline: string, value: {reason: string}) {
      return this.cancel(selection.requestId, value);
    }, async submitFrozen(selection: any) {
      if (admitted.has(selection.requestId)) return admitted.get(selection.requestId);
      const intent = routineDispatchIntentSchema.parse({...selection, laneId: selection.platform});
      const row = await requests!.prepare('mini', intent);
      Object.assign(row, {fleetSelection: selection, fleetSelectionSha256: requestInputDigest(selection),
        fleetBinding: {jobId: selection.requestId, requestId: selection.requestId, hostId: 'mini', laneId: selection.platform,
          descriptorRevision: 'f'.repeat(64), actionsRunId: '1', actionsJobId: '2', boundAt: startedAt}});
      admitted.set(selection.requestId, row);
      return row;
    }, async cancel(id: string, value: {reason: string}) {
      const plan = await repository!.get(''), member = plan?.members.find((member: any) => member.requestId === id);
      return requests!.cancelPreparationSubmission(id, 'mini', member && {...member.selection, laneId: member.platform},
        new Date((now ?? Date.now)()).toISOString(), value.reason);
    }};
    super(catalog, builds, requests, repository, results, now, log, sources ?? {async resolve() {return mainRevision;}}, jobs as unknown as ConstructorParameters<typeof ActualNightlyRoutineService>[8]);
  }
}
function preparedRequest(hostId: string, intent: any) {
  const input = {routineId: intent.routineId, platform: intent.platform, definitionRevision: intent.routineRevision,
    routineSource: testRoutineSource(intent.routineRevision), laneId: intent.laneId, build: intent.build,
    resources: [{id: `app:${intent.platform}`, kind: "app"}]};
  return {requestId: intent.requestId, hostId, dispatchIntent: intent, dispatchIntentSha256: requestInputDigest(intent),
    input, inputSha256: requestInputDigest(input), state: "queued"};
}
const startedAt = "2026-10-03T11:00:00Z", now = Date.parse(startedAt);
const occurrence = {occurrenceId: "schedule:2026-10-03", startedAt, trigger: "nightly" as const};
function row(id: string, platform: "android" | "ios-on-mac", nightlyEnabled = true) {
  return {
    ...routineEnrollmentSchema.parse({
      routineId: id,
      platform,
      definitionRevision: "a".repeat(40),
      definitionSha256: "b".repeat(64),
      routineSource: testRoutineSource(),
      definition: {
        minimumRoutineApiVersion: 1,
        id,
        title: id,
        purpose: "Check the saved routine",
        platforms: [platform],
        entry: "home",
        account: "lane",
        resourceRequirements: [...(platform === "android" ? [{kind:"phone",capabilities:[]}] : []), {kind:"app",capabilities:[]}, {kind:"recorder",capabilities:[]}],
        requirements: [],
        fixtures: [],
        steps: [{id: "check", instruction: "Check", expected: "Checked"}],
        execution: {resourceKinds: [...(platform === "android" ? ["phone"] : []), "app", "recorder"]},
        source: {repository: "Mentra-Community/Mentra-Automated-Testing", revision: "a".repeat(40), path: `routines/${id}/routine.ts`},
      },
    }),
    nightlyEnabled,
    example: {runId: `example-${id}`, startedAt, finishedAt: startedAt, recordingAssetId: "video", definitionRevision: "c".repeat(40), build: {repository: "Mentra-Community/MentraOS", channel: "dev" as const, headSha: "d".repeat(40)}},
  }
}
const build = (platform: "android" | "ios-on-mac"): TestBuild => ({source: {channel: "dev", buildRunId: 21, publicationAttempt: 2}, platform,
  title: "dev", headSha: "e".repeat(40), buildUrl: "https://github.com/Mentra-Community/MentraOS/actions/runs/21", createdAt: startedAt,
  availability: "available", archive: {name: "app", size: 100, sha256: "f".repeat(64), url: "https://artifactscdn.mentraglass.com/app"},
  receipt: {size: 10, sha256: "1".repeat(64), url: "https://artifactscdn.mentraglass.com/receipt"}});
const host: ReceivedTestHostState = {hostId: "mini", incarnation: "one", incarnationGeneration: 1, sequence: 1, observedAt: startedAt, receivedAt: startedAt,
  lanes: ["android", "ios-on-mac"].map(platform => ({id: platform, platform: platform as "android" | "ios-on-mac", dispatchMode: "automatic", state: "running",
    resources: [{id: `app:${platform}`, kind: "app"}]}))};
function cancellationRepository() {
  let saved: NightlyCancellation | null = null;
  return {async cancellation() {return saved;}, async requestCancellation(_id: string, value: NightlyCancellation) {saved ??= structuredClone(value); return saved;}};
}
function fixture(
  initial = [row("a-new-routine", "android"), row("different.routine", "ios-on-mac"), row("disabled-routine", "android", false)],
  repository?: NightlyPlanRepository,
) {
  let catalog = initial, plan: NightlyPlan | null = null, finished: NightlyResult | null = null, reads = 0;
  let failId: string | undefined, cancelFailId: string | undefined, clock = now, selectedMain = mainRevision, sourceReads = 0, autoPrepare = true;
  const admitted: {requestId: string; hostId: string; input: any}[] = [];
  const cancelled: string[] = [], buildReads: string[] = [];
  const completionEvents: string[] = [];
  const resultRows = new Map<string, any>();
  const requestRows = new Map<string, any>();
  const requestErrors = new Map<string, Error>();
  const service = new NightlyRoutineService(
    {async list() {reads++; return catalog;}} as Pick<RoutineCatalogService, "list">,
    {async latestDev(platform, before) {buildReads.push("latest:" + platform); expect(before).toBe(startedAt); return build(platform);},
      async resolve(source, platform) {buildReads.push("resolve:" + platform); expect(source).toEqual(build(platform).source); return build(platform);}},
    {async get(id) {expect(id).toBe("mini"); return host;}},
    {async cancelPreparationSubmission(id) {completionEvents.push("cancel:" + id); cancelled.push(id); if (id === cancelFailId) throw new TestRunError(503, "Cancellation storage unavailable."); return {} as any;}, async get(id) {if (requestErrors.has(id)) throw requestErrors.get(id)!; return requestRows.get(id) ?? null;}, async prepare(hostId, value) {const input = routineDispatchIntentSchema.parse(value), requestId = input.requestId; if (requestId === failId) throw new Error("queue unavailable"); admitted.push({requestId, hostId, input});
      const request = autoPrepare ? preparedRequest(hostId, input) : {requestId, hostId, dispatchIntent: input, dispatchIntentSha256: requestInputDigest(input), state: "preparing"};
      requestRows.set(requestId, request); return request as any;}},
    repository ?? {...cancellationRepository(), async get() {return plan;}, async freeze(next) {plan ??= next; return plan;}, async completed() {return finished;}, async finish(_id, result) {finished ??= result; return finished;}},
    () => ({"android": {hostId: "mini", laneId: "android"}, "ios-on-mac": {hostId: "mini", laneId: "ios-on-mac"}}),
    {async summary(id) {completionEvents.push("evidence:" + id); const result = resultRows.get(id); if (typeof result === "function") return result(); if (result instanceof Error) throw result; if (!result) throw new TestRunError(404, "missing"); return result;}},
    () => clock,
    undefined,
    {async resolve() {sourceReads++; return selectedMain;}},
  )
  return {service, admitted, get sourceReads() {return sourceReads;}, set main(value: string) {selectedMain = value;}, set autoPrepare(value: boolean) {autoPrepare = value;}, cancelled, completionEvents, buildReads, resultRows, requestRows, requestErrors, get plan() {return plan!;}, get reads() {return reads;}, set clock(value: number) {clock = value;}, set catalog(next: typeof initial) {catalog = next;}, set failId(value: string | undefined) {failId = value;}, set cancelFailId(value: string | undefined) {cancelFailId = value;}};
}
test("nightly pins fresh main for every enabled routine and freezes exact app artifacts", async () => {
  const state = fixture(), result = await state.service.start(occurrence);
  expect(result.plan.members.map(row => row.routineId)).toEqual(["a-new-routine", "different.routine"]);
  expect(state.admitted).toHaveLength(2);
  expect(state.admitted[0]!.input.build.kind).toBe("android-apk");
  expect(state.admitted[0]!.input.build.source).toEqual({channel: "dev", buildRunId: 21, publicationAttempt: 2});
  expect(result.plan.suite!.members[0]!.definitionRevision).toBe(mainRevision);
  expect(result.plan.publication).toEqual({source: {channel: "dev", buildRunId: 21, publicationAttempt: 2}, headSha: "e".repeat(40)});
  expect(state.buildReads).toEqual(["latest:android", "resolve:ios-on-mac"]);
  expect(result.plan.members.every(member => member.selection!.build.headSha === "e".repeat(40))).toBe(true);
  expect(result.plan.members.every(member => member.routineRevision === mainRevision && !("routineSource" in member) && !("input" in member))).toBe(true);
  state.main = "8".repeat(40);
  state.catalog = [row("later-routine", "android")];
  const retry = await state.service.start(occurrence);
  expect(retry.plan).toEqual(result.plan);
  expect(state.reads).toBe(1);
  expect(state.sourceReads).toBe(1);
  expect(state.admitted).toHaveLength(2);
  await expect(state.service.start({...occurrence, startedAt: "2026-10-03T12:00:00Z"})).rejects.toThrow("changed");
});
test("one failed admission does not suppress neighboring members and retries the same request", async () => {
  const state = fixture();
  const firstMember = `nightly-a918c9311be01fe1b8bc2eacf2ad92a4-member-6d9a5434359c087fbd65ac4e7bd38aa2`;
  state.failId = firstMember;
  const first = await state.service.start(occurrence);
  expect(first.admissions.map(row => row.admitted)).toEqual([false, true]);
  state.failId = undefined;
  const retry = await state.service.start(occurrence);
  expect(retry.plan).toEqual(first.plan);
  expect(retry.admissions.every(row => row.admitted)).toBe(true);
  expect(state.admitted).toHaveLength(2);
});

test("evidence reads crossing the deadline cancel every member before freezing the occurrence", async () => {
  const state = fixture(), {plan} = await state.service.start(occurrence);
  state.clock = now + 3 * 3600_000 - 1;
  state.resultRows.set(plan.members[0]!.requestId, () => {
    state.clock = now + 3 * 3600_000;
    throw new TestRunError(503, "Evidence unavailable across deadline.");
  });
  const result = await state.service.complete(occurrence.occurrenceId);
  expect(state.cancelled).toEqual(plan.members.map(member => member.requestId));
  expect(result).toMatchObject({status: "incomplete", finishedAt: new Date(now + 3 * 3600_000).toISOString()});
  expect(result.members[0]!.unavailableReason).toContain("Evidence unavailable");
  expect(result.members.every(member => member.status === "incomplete")).toBe(true);
  expect(await state.service.complete(occurrence.occurrenceId)).toEqual(result);
  expect(state.cancelled).toHaveLength(4);
});

test("result matching refuses changed artifact/source identity and terminal receipts fence later changes", async () => {
  const state = fixture([row("single-routine", "android")]);
  const {plan} = await state.service.start(occurrence), member = plan.members[0]!;
  state.resultRows.set(member.requestId, {routineId: member.routineId, platform: member.platform, definitionRevision: member.definitionRevision,
    hostId: "mini", laneId: member.platform, build: {...member.selection!.build, source: {channel: "dev", buildRunId: 22, publicationAttempt: 2}}, runId: member.requestId,
    outcome: "pass", uploadsComplete: true, evidenceStatus: "complete"});
  expect((await state.service.detail(occurrence.occurrenceId)).status).toBe("incomplete");
  const final = await state.service.complete(occurrence.occurrenceId);
  state.resultRows.get(member.requestId).build = member.selection!.build;
  expect(await state.service.detail(occurrence.occurrenceId)).toEqual(final);
  expect(final.resultUrl).toContain("testRun=");
  expect(final.resultUrl).not.toContain("testSuite=");
});

test("nightly summary keeps every frozen identity and complete build field in its result match", async () => {
  const state = fixture([row("single-routine", "android")]);
  const {plan} = await state.service.start(occurrence), member = plan.members[0]!;
  const valid = publishedResult(member, true);
  for (const field of ["requestId", "routineId", "platform", "definitionRevision", "hostId", "laneId"] as const) {
    state.resultRows.set(member.requestId, {...valid, [field]: "foreign"});
    expect((await state.service.detail(occurrence.occurrenceId)).members[0]).toMatchObject({status: "incomplete", publicationComplete: false,
      unavailableReason: "Result identity differs from the frozen request."});
  }
  for (const build of [{...member.selection!.build, archive: {sha256: "2".repeat(64)}},
    {...member.selection!.build, source: {channel: "dev", buildRunId: 21, publicationAttempt: 99}}]) {
    state.resultRows.set(member.requestId, {...valid, build});
    expect((await state.service.detail(occurrence.occurrenceId)).status).toBe("incomplete");
  }
  state.resultRows.set(member.requestId, valid);
  expect(await state.service.detail(occurrence.occurrenceId)).toMatchObject({status: "pass", passed: 1});
});

test("failed evidence settles only after captured uploads finish and freezes an honest failed suite", async () => {
  const state = fixture(), {plan} = await state.service.start(occurrence);
  const [failed, healthy] = plan.members;
  const failedResult = {...publishedResult(failed!, false), evidenceStatus: "failed"};
  state.resultRows.set(failed!.requestId, failedResult);
  state.resultRows.set(healthy!.requestId, publishedResult(healthy!, true));

  state.clock = now + 2 * 60_000;
  const pending = await state.service.complete(occurrence.occurrenceId);
  expect(pending).toMatchObject({status: "running", passed: 1, expectedCount: 2});
  expect(pending.finishedAt).toBeUndefined();
  expect(pending.members[0]).toMatchObject({status: "pass", publicationComplete: false, runId: failed!.requestId});
  expect(state.cancelled).toEqual([]);

  failedResult.uploadsComplete = true;
  state.clock = now + 3 * 60_000;
  const finishedAt = new Date(now + 3 * 60_000).toISOString();
  const terminal = await state.service.complete(occurrence.occurrenceId);
  expect(terminal).toMatchObject({status: "failed", passed: 1, expectedCount: 2, finishedAt});
  expect(terminal.members[0]).toMatchObject({status: "pass", publicationComplete: false, runId: failed!.requestId});
  expect(terminal.members[1]).toMatchObject({status: "pass", publicationComplete: true});
  expect(terminal.members.every(member => !("publicationSettled" in member))).toBe(true);

  // Admin uses the same frozen receipt, including its failed routine and original execution verdict.
  const stored = {payload: plan.suite, nightlyPlan: plan, nightlyResult: terminal};
  const query = {read() {return this;}, readConcern() {return this;}, lean: async () => stored};
  const find = spyOn(TestSuiteModel, "findOne").mockReturnValue(query as any);
  try {
    expect(await new TestSuiteService().detail(plan.suiteId)).toMatchObject({outcome: "failed", passed: 1,
      finishedAt, failedRoutines: [failed!.routineId]});
    failedResult.evidenceStatus = "complete";
    expect(await state.service.detail(occurrence.occurrenceId)).toEqual(terminal);
    expect(await state.service.complete(occurrence.occurrenceId)).toEqual(terminal);
    expect((await new TestSuiteService().detail(plan.suiteId)).outcome).toBe("failed");
  } finally {find.mockRestore();}
});

test("concurrent freeze adopts the first durable occurrence and completion keeps the first receipt", async () => {
  const first = (await fixture().service.start(occurrence)).plan;
  const stored: any = {nightlyPlan: first};
  const query = {read() {return this;}, readConcern() {return this;}, lean: async () => stored};
  const create = spyOn(TestSuiteModel, "create").mockImplementation((async (_rows: unknown, options: any) => {
    expect(options.writeConcern).toEqual({w: "majority", j: true, wtimeout: 10000});
    throw Object.assign(new Error("duplicate"), {code: 11000});
  }) as any);
  const find = spyOn(TestSuiteModel, "findOne").mockReturnValue(query as any);
  const update = spyOn(TestSuiteModel, "updateOne").mockImplementation((async (filter: any, changes: any, options: any) => {
    expect(filter.nightlyResult).toEqual({$exists: false});
    expect(options.writeConcern.w).toBe("majority");
    stored.nightlyResult ??= changes.$set.nightlyResult;
    return {modifiedCount: 1};
  }) as any);
  try {
    expect(await nightlyPlanRepository.freeze({...first, members: []})).toEqual(first);
    const terminal = {occurrenceId: first.occurrenceId, suiteId: first.suiteId, startedAt: first.startedAt, trigger: first.trigger,
      members: [], expectedCount: 0, passed: 0, status: "incomplete"};
    expect(await nightlyPlanRepository.finish(first.suiteId, terminal)).toEqual(terminal);
    expect((await nightlyPlanRepository.finish(first.suiteId, {...terminal, status: "pass"})).status).toBe("incomplete");
  } finally {create.mockRestore(); find.mockRestore(); update.mockRestore();}
});

test("an empty enabled catalog freezes a skipped occurrence without advertising a suite", async () => {
  const state = fixture([row("disabled-routine", "android", false)]);
  const selected = await state.service.start(occurrence);
  expect(selected.plan.members).toEqual([]);
  expect(selected.plan.suite).toBeUndefined();
  expect(state.admitted).toEqual([]);
  expect(await state.service.complete(occurrence.occurrenceId)).toMatchObject({status: "skipped", expectedCount: 0, passed: 0});
});

test("nightly preserves a host's precise rejected-member reason without inventing a run or a pass", async () => {
  const state = fixture([row("rejected-routine", "android")]), {plan} = await state.service.start(occurrence), member = plan.members[0]!;
  const {requestInputDigest} = await import("./test-request.service");
  const prepared = preparedRequest("mini"!, {...member.selection, laneId: member.platform}), inputSha256 = prepared.inputSha256;
  state.requestRows.set(member.requestId, {...state.requestRows.get(member.requestId), ...prepared, state: "terminal", terminalStatus: "not-run", hostRejection: {requestId: member.requestId,
    hostId: "mini", inputSha256, rejectedAt: startedAt, code: "missing-definition", reason: "The requested source is not installed."}});
  const detail = await state.service.detail(occurrence.occurrenceId);
  expect(detail).toMatchObject({status: "incomplete", expectedCount: 1, passed: 0});
  expect(detail.members[0]).toMatchObject({status: "incomplete", publicationComplete: false,
    unavailableReason: "missing-definition: The requested source is not installed."});
  expect(detail.members[0]!.runId).toBeUndefined();
  const terminal = await state.service.complete(occurrence.occurrenceId);
  expect(terminal.finishedAt).toBeDefined();
  state.requestRows.get(member.requestId).hostRejection.reason = "changed later";
  expect(await state.service.detail(occurrence.occurrenceId)).toEqual(terminal);
});

test("deadline cancellation uses the original requests and prevents retrying pending work", async () => {
  const state = fixture(), {plan} = await state.service.start(occurrence);
  expect(state.cancelled).toEqual([]);
  expect((await state.service.complete(occurrence.occurrenceId)).status).toBe("running");
  state.clock = now + 3 * 3600_000;
  const terminal = await state.service.complete(occurrence.occurrenceId);
  expect(terminal.status).toBe("incomplete");
  expect(state.cancelled.sort()).toEqual(plan.members.map(member => member.requestId).sort());
  expect((await state.service.start(occurrence)).admissions).toEqual([]);
  expect(state.admitted).toHaveLength(2);
});

test("deadline cancellation reconciles every request despite a member evidence 503 and freezes each truthful outcome", async () => {
  const state = fixture(), {plan} = await state.service.start(occurrence), [unreadable, healthy] = plan.members;
  state.resultRows.set(unreadable!.requestId, new TestRunError(503, "Result storage temporarily unavailable."));
  state.resultRows.set(healthy!.requestId, publishedResult(healthy!, true));
  const live = await state.service.complete(occurrence.occurrenceId);
  expect(live).toMatchObject({status: "running", expectedCount: 2, passed: 1});
  expect(live.members[0]).toMatchObject({status: "waiting", publicationComplete: false,
    unavailableReason: "Result evidence is unavailable (HTTP 503): Result storage temporarily unavailable."});
  expect(state.cancelled).toEqual([]);
  state.clock = now + 3 * 3600_000;
  state.completionEvents.length = 0;
  const receipt = await state.service.complete(occurrence.occurrenceId);
  expect(state.cancelled).toEqual(plan.members.map(member => member.requestId));
  expect(state.completionEvents).toEqual([...plan.members.map(member => "cancel:" + member.requestId), ...plan.members.map(member => "evidence:" + member.requestId)]);
  expect(receipt).toMatchObject({status: "incomplete", expectedCount: 2, passed: 1, finishedAt: "2026-10-03T14:00:00.000Z"});
  expect(receipt.members[0]).toMatchObject({status: "incomplete", publicationComplete: false,
    unavailableReason: "Result evidence is unavailable (HTTP 503): Result storage temporarily unavailable."});
  expect(receipt.members[0]!.runId).toBeUndefined();
  expect(receipt.members[1]).toMatchObject({status: "pass", publicationComplete: true, runId: healthy!.requestId});
  state.resultRows.set(unreadable!.requestId, publishedResult(unreadable!, true));
  expect(await state.service.complete(occurrence.occurrenceId)).toEqual(receipt);
  expect(state.cancelled).toHaveLength(4);
});

test("a request receipt read failure remains an incomplete member without suppressing cancellation or its neighbor", async () => {
  const state = fixture(), {plan} = await state.service.start(occurrence), [unreadable, healthy] = plan.members;
  state.requestErrors.set(unreadable!.requestId, new TestRunError(503, "Request storage temporarily unavailable."));
  state.resultRows.set(healthy!.requestId, publishedResult(healthy!, true));
  state.clock = now + 3 * 3600_000;
  const receipt = await state.service.complete(occurrence.occurrenceId);
  expect(state.cancelled).toEqual(plan.members.map(member => member.requestId));
  expect(receipt).toMatchObject({status: "incomplete", passed: 1, expectedCount: 2});
  expect(receipt.members[0]).toMatchObject({status: "incomplete", publicationComplete: false,
    unavailableReason: "Request evidence is unavailable (HTTP 503): Request storage temporarily unavailable."});
  expect(receipt.members[1]).toMatchObject({status: "pass", publicationComplete: true});
});

test("one failed cancellation write still reconciles neighboring requests and must retry before terminal freezing", async () => {
  const state = fixture(), {plan} = await state.service.start(occurrence);
  state.clock = now + 3 * 3600_000; state.cancelFailId = plan.members[0]!.requestId;
  await expect(state.service.complete(occurrence.occurrenceId)).rejects.toThrow("deadline cancellation is unavailable");
  expect(state.cancelled).toEqual(plan.members.map(member => member.requestId));
  expect((await state.service.detail(occurrence.occurrenceId)).finishedAt).toBeUndefined();
  state.cancelFailId = undefined;
  expect(await state.service.complete(occurrence.occurrenceId)).toMatchObject({status: "incomplete", expectedCount: 2});
  expect(state.cancelled).toEqual([...plan.members, ...plan.members].map(member => member.requestId));
});

test("early cancellation retains its fence before failed member writes and preserves the exact frozen plan", async () => {
  const state = fixture(), {plan} = await state.service.start(occurrence), digest = requestInputDigest(plan);
  state.clock = now + 60_000; state.cancelFailId = plan.members[0]!.requestId;
  await expect(state.service.cancel(occurrence.occurrenceId, {reason: "Superseded by latest passing build"})).rejects.toThrow("retry this occurrence cancellation");
  expect(state.cancelled).toEqual(plan.members.map(member => member.requestId));
  const detail = await state.service.detail(occurrence.occurrenceId);
  expect(detail.cancellation).toEqual({requestedAt: "2026-10-03T11:01:00.000Z", reason: "Superseded by latest passing build"});
  expect(detail.finishedAt).toBeUndefined();
  state.cancelFailId = undefined; state.clock = now + 120_000;
  const receipt = await state.service.cancel(occurrence.occurrenceId, {reason: "Retry must keep the first reason"});
  expect(receipt).toEqual({occurrenceId: occurrence.occurrenceId, suiteId: plan.suiteId,
    cancellation: detail.cancellation!, requestsCancellationRecorded: true});
  expect((await state.service.start(occurrence)).admissions).toEqual([]);
  expect(state.admitted).toHaveLength(2);
  expect(requestInputDigest(state.plan)).toBe(digest);
  expect((await state.service.complete(occurrence.occurrenceId)).finishedAt).toBeUndefined();
  await expect(state.service.cancel(occurrence.occurrenceId, {reason: "", startedAt})).rejects.toThrow("Invalid nightly cancellation");
});

test("occurrence cancellation survives lost storage acknowledgement without rewriting the plan or completed result", async () => {
  const cancellation = {requestedAt: "2026-10-03T11:01:00Z", reason: "Superseded"};
  const plan = {suiteId: "nightly-test"}, result = {status: "pass", finishedAt: startedAt};
  const stored: any = {nightlyPlan: plan, nightlyResult: result};
  const query = {read() {return this;}, readConcern() {return this;}, lean: async () => stored};
  const find = spyOn(TestSuiteModel, "findOne").mockReturnValue(query as any);
  let ackLost = false;
  const update = spyOn(TestSuiteModel, "updateOne").mockImplementation((async (filter: any, change: any, options: any) => {
    expect(filter).toEqual({suiteId: "nightly-test", nightlyPlan: {$exists: true}, nightlyCancellation: {$exists: false}});
    expect(options.writeConcern).toBeDefined();
    expect(Object.keys(change.$set)).toEqual(["nightlyCancellation"]);
    stored.nightlyCancellation ??= structuredClone(change.$set.nightlyCancellation);
    if (!ackLost) {ackLost = true; throw new Error("Cancellation ACK lost after durable write");}
    return {modifiedCount: 0};
  }) as any);
  try {
    await expect(nightlyPlanRepository.requestCancellation("nightly-test", cancellation)).rejects.toThrow("ACK lost");
    expect(await nightlyPlanRepository.cancellation("nightly-test")).toEqual(cancellation);
    expect(await nightlyPlanRepository.requestCancellation("nightly-test", {...cancellation, reason: "Retry"})).toEqual(cancellation);
    expect(stored.nightlyPlan).toBe(plan); expect(stored.nightlyResult).toBe(result);
  } finally {update.mockRestore(); find.mockRestore();}
});

test("an admission completing across the deadline is cancelled through the ordinary request path", async () => {
  let clock = now, saved: NightlyPlan | null = null;
  const cancelled: string[] = [];
  const service = new NightlyRoutineService({async list() {return [row("late-product", "android")];}} as any,
    {async latestDev(platform) {return build(platform);}, async resolve(source, platform) {return {...build(platform), source};}},
    {async get() {return host;}}, {async get() {return null;}, async prepare() {clock = now + 3 * 3600_000; return {} as any;},
      async cancelPreparationSubmission(id) {cancelled.push(id); return {} as any;}},
    {...cancellationRepository(), async get() {return saved;}, async freeze(plan) {saved = plan; return plan;}, async completed() {return null;}, async finish(_id, result) {return result;}},
    () => ({android: {hostId: "mini", laneId: "android"}}), undefined, () => clock);
  const {plan} = await service.start(occurrence);
  expect(cancelled).toEqual([plan.members[0]!.requestId]);
});



test("a mismatched platform publication remains expected and missing anchor platform does not suppress its neighbor", async () => {
  for (const variant of ["head", "source", "platform", "release", "missing"] as const) {
    const mismatch = variant !== "missing";
    let saved: NightlyPlan | null = null;
    const service = new NightlyRoutineService(
      {async list() {return [row("phone-product", "android"), row("desktop-product", "ios-on-mac")];}} as any,
      {async latestDev(platform) {return mismatch ? {...build(platform), ...(variant === "release" ? {release: "dev.20"} : {})}
          : {...build(platform), availability: "unavailable", archive: undefined, receipt: undefined, reason: "APK missing"};},
        async resolve(source, platform) {return {...build(platform), source,
          ...(variant === "head" ? {headSha: "9".repeat(40)} : variant === "source" ? {source: {...source, publicationAttempt: 3}}
            : variant === "platform" ? {platform: "android" as const} : variant === "release" ? {release: "dev.21"} : {})};}},
      {async get() {return host;}},
      {async cancelPreparationSubmission() {return {} as any;}, async get() {return null;}, async prepare() {return {} as any;}},
      {...cancellationRepository(), async get() {return saved;}, async freeze(plan) {saved = plan; return plan;}, async completed() {return null;}, async finish(_id, result) {return result;}},
      () => ({"android": {hostId: "mini", laneId: "android"}, "ios-on-mac": {hostId: "mini", laneId: "ios-on-mac"}}),
      undefined,
      () => now,
    )
    const {plan} = await service.start(occurrence);
    expect(plan.members).toHaveLength(2);
    expect(plan.members[mismatch ? 1 : 0]!.selection).toBeUndefined();
    expect(plan.members[mismatch ? 0 : 1]!.selection).toBeDefined();
    expect(plan.members[mismatch ? 1 : 0]!.unavailableReason).toBeDefined();
    if (mismatch) {
      expect(plan.members[1]!.build).toBeUndefined();
      expect(plan.suite!.members[1]!.headSha).toBeUndefined();
      expect(plan.suite!.build.headSha).toBe(build("android").headSha);
      expect(plan.publication!.headSha).toBe(build("android").headSha);
    }
  }
})

function publishedResult(member: NightlyPlan["members"][number], uploadsComplete: boolean) {
  return {requestId: member.requestId, routineId: member.routineId, platform: member.platform, definitionRevision: member.definitionRevision,
    routineSource: testRoutineSource(member.routineRevision), hostId: "mini", laneId: member.platform, build: member.selection!.build, runId: member.requestId,
    startedAt, finishedAt: "2026-10-03T11:01:00Z",
    outcome: "pass", uploadsComplete, evidenceStatus: "complete"};
}


test("lane-specific exact-definition availability never disables the healthy sibling or global catalog", async () => {
  for (const unavailable of ["false", "missing", "stale"] as const) {
    const observed = structuredClone(host), submitted: string[] = [];
    observed.lanes[0]!.routineAvailability = unavailable === "missing" ? [] : [{routineId: "phone-product",
      definitionRevision: unavailable === "stale" ? "c".repeat(40) : "a".repeat(40), available: false, reason: "Phone cannot prepare the selected source."}];
    observed.lanes[1]!.routineAvailability = [{routineId: "desktop-product", definitionRevision: "a".repeat(40), available: true}];
    let saved: NightlyPlan | null = null;
    const service = new NightlyRoutineService(
      {async list() {return [row("phone-product", "android"), row("desktop-product", "ios-on-mac")];}} as any,
      {async latestDev(platform) {return build(platform);}, async resolve(source, platform) {return {...build(platform), source};}},
      {async get() {return observed;}},
      {async cancelPreparationSubmission() {return {} as any;}, async get() {return null;}, async prepare(_hostId, input) {submitted.push(routineDispatchIntentSchema.parse(input).requestId); return {} as any;}},
      {...cancellationRepository(), async get() {return saved;}, async freeze(plan) {saved = plan; return plan;}, async completed() {return null;}, async finish(_id, result) {return result;}},
      () => ({"android": {hostId: "mini", laneId: "android"}, "ios-on-mac": {hostId: "mini", laneId: "ios-on-mac"}}),
      undefined,
      () => now,
    )
    const {plan} = await service.start(occurrence);
    expect(plan.members).toHaveLength(2);
    expect(submitted).toEqual(plan.members.map(member => member.requestId))
    expect(plan.members[0]!.selection?.routineRevision).toBe(mainRevision)
    expect(plan.members[0]!.selection?.routineSource).toBeUndefined()
    expect(plan.members[0]!.unavailableReason).toBeUndefined()
    expect(plan.members[1]!.selection).toBeDefined();
    observed.lanes[0]!.routineAvailability = [{routineId: "phone-product", definitionRevision: "a".repeat(40), available: true}];
    const retry = await service.start(occurrence);
    expect(retry.plan).toEqual(plan); // Capability changes cannot silently replace the frozen expected member.
  }
})


test("nightly preparation reads only passed-once IDs and preferences, never old definition metadata", async () => {
  const historical = row("known-product", "android");
  for (const key of ["definition", "definitionRevision", "definitionSha256", "routineSource"])
    Object.defineProperty(historical, key, {get() {throw new Error(`Nightly must not read old ${key}`);}});
  const state = fixture([historical]); state.autoPrepare = false;
  const {plan, admissions} = await state.service.start(occurrence);
  expect(admissions[0]!.admitted).toBe(true);
  expect(plan.members[0]!.selection).toMatchObject({routineId: "known-product", routineRevision: mainRevision, source: build("android").source});
  expect(state.requestRows.get(plan.members[0]!.requestId)).toMatchObject({state: "preparing"});
  expect(state.requestRows.get(plan.members[0]!.requestId).input).toBeUndefined();
});

test("unavailable main source cannot fall back to an old enrolled definition", async () => {
  let plan: NightlyPlan | null = null, available = false, preparations = 0, sourceReads = 0;
  const service = new NightlyRoutineService({async list() {return [row("known-product", "android")];}} as any,
    {async latestDev(platform) {return build(platform);}, async resolve(source, platform) {return {...build(platform), source};}},
    {async get() {return host;}}, {async get() {return null;}, async prepare() {preparations++; return {} as any;}, async cancelPreparationSubmission() {return {} as any;}},
    {...cancellationRepository(), async get() {return plan;}, async freeze(next) {plan ??= next; return plan;}, async completed() {return null;}, async finish(_id, result) {return result;}},
    () => ({android: {hostId: "mini", laneId: "android"}}), undefined, () => now, undefined,
    {async resolve() {sourceReads++; if (!available) throw new TestRunError(503, "Routine main source unavailable"); return mainRevision;}});
  await expect(service.start(occurrence)).rejects.toThrow("main source unavailable");
  expect(plan).toBeNull(); expect(preparations).toBe(0);
  available = true;
  const first = await service.start(occurrence);
  expect(first.plan.members[0]!.routineRevision).toBe(mainRevision);
  available = false;
  expect((await service.start(occurrence)).plan).toEqual(first.plan);
  expect(sourceReads).toBe(2);
});

test("preparing members retain shortage diagnostics and cannot count a result before executable preparation", async () => {
  const state = fixture([row("waiting-product", "android")]); state.autoPrepare = false;
  const {plan} = await state.service.start(occurrence), member = plan.members[0]!;
  const request = state.requestRows.get(member.requestId);
  request.preparation = {code: "routine-api-shortage", reason: "Installed API 1 cannot prepare minimum 2.", observedAt: startedAt};
  state.resultRows.set(member.requestId, publishedResult(member, true));
  const detail = await state.service.detail(occurrence.occurrenceId);
  expect(detail).toMatchObject({status: "running", passed: 0, members: [{status: "waiting", publicationComplete: false,
    unavailableReason: "routine-api-shortage: Installed API 1 cannot prepare minimum 2."}]});
  expect(detail.members[0]!.input).toBeUndefined();
  expect(detail.members[0]!.runId).toBeUndefined();
  expect(state.completionEvents.some(event => event.startsWith("evidence:"))).toBe(false);
  request.state = "terminal";
  request.preparationRejection = {dispatchIntentSha256: request.dispatchIntentSha256, code: "invalid-source",
    reason: "Routine was removed at the requested commit.", rejectedAt: startedAt, disposition: "not-applicable"};
  expect((await state.service.detail(occurrence.occurrenceId)).members[0]).toMatchObject({status: "incomplete",
    unavailableReason: "invalid-source: Routine was removed at the requested commit."});
});

test("prepared input must match the pinned revision and every frozen app reference", async () => {
  const state = fixture([row("prepared-product", "android")]), {plan} = await state.service.start(occurrence), member = plan.members[0]!;
  const request = state.requestRows.get(member.requestId), original = structuredClone(request);
  state.resultRows.set(member.requestId, publishedResult(member, true));
  for (const input of [{...original.input, definitionRevision: "a".repeat(40), routineSource: testRoutineSource("a".repeat(40))},
    {...original.input, build: {...original.input.build, receipt: {...original.input.build.receipt, sha256: "9".repeat(64)}}}]) {
    state.requestRows.set(member.requestId, {...original, input, inputSha256: requestInputDigest(input)});
    expect((await state.service.detail(occurrence.occurrenceId)).members[0]).toMatchObject({status: "incomplete", publicationComplete: false,
      unavailableReason: "Prepared input differs from the frozen intent."});
  }
  state.requestRows.set(member.requestId, {...original, dispatchIntent: {...original.dispatchIntent, routineRevision: "a".repeat(40)}});
  expect((await state.service.detail(occurrence.occurrenceId)).members[0]).toMatchObject({status: "incomplete", publicationComplete: false,
    unavailableReason: "Bound request identity differs from its assignment."});
  state.requestRows.set(member.requestId, original);
  expect((await state.service.detail(occurrence.occurrenceId))).toMatchObject({status: "pass", passed: 1});
});

test('fleet nightly stores every portable member without a host and cancels absent admissions at the suite deadline', async () => {
  let plan: NightlyPlan | null = null, clock = now;
  const requestRows = new Map<string, any>(), submitted: any[] = [], cancelled: string[] = [];
  const jobs = {async submitFrozen(selection: any, deadline: string) {
    submitted.push({selection: structuredClone(selection), deadline});
    if (!requestRows.has(selection.requestId)) requestRows.set(selection.requestId, {requestId: selection.requestId,
      state: 'awaiting-source', fleetSelection: selection, fleetSelectionSha256: requestInputDigest(selection)});
    return requestRows.get(selection.requestId);
  }, async cancelFrozen(selection: any, _deadline: string, value: {reason: string}) {
    cancelled.push(selection.requestId);
    const retained = requestRows.get(selection.requestId) ?? {requestId: selection.requestId, fleetSelection: selection,
      fleetSelectionSha256: requestInputDigest(selection)};
    requestRows.set(selection.requestId, {...retained, state: 'terminal', fleetCancellation: value});
    return {} as any;
  }, async cancel(id: string, value: {reason: string}) {cancelled.push(id); requestRows.get(id).fleetCancellation = value; return {} as any;}};
  const repository = {...cancellationRepository(), async get() {return plan;}, async freeze(value: NightlyPlan) {plan ??= value; return plan;},
    async completed() {return null;}, async finish(_id: string, value: NightlyResult) {return value;}};
  const service = new ActualNightlyRoutineService({async list() {return [row('portable-one', 'android'), row('portable-two', 'ios-on-mac')];}} as any,
    {async latestDev(platform) {return build(platform);}, async resolve(source, platform) {return {...build(platform), source};}},
    {async get(id) {return requestRows.get(id) ?? null;}}, repository, undefined, () => clock, undefined,
    {async resolve() {return mainRevision;}}, jobs);
  const first = await service.start(occurrence);
  expect(first.plan.members.every(member => !!member.selection && !member.hostId && !member.dispatchIntent)).toBe(true);
  expect(first.plan.suite?.members).toHaveLength(2);
  expect(submitted).toHaveLength(2);
  expect(new Set(submitted.map(value => value.deadline))).toEqual(new Set([new Date(now + 3 * 3600_000).toISOString()]));
  expect(await service.detail(occurrence.occurrenceId)).toMatchObject({status: 'running', expectedCount: 2,
    members: [{status: 'waiting', unavailableReason: 'Awaiting exact routine source preparation.'}, {status: 'waiting'}]});
  requestRows.delete(first.plan.members[0]!.requestId);
  clock += 3 * 3600_000;
  const terminal = await service.complete(occurrence.occurrenceId);
  expect(cancelled).toEqual(first.plan.members.map(member => member.requestId));
  expect(submitted).toHaveLength(2);
  expect(terminal).toMatchObject({status: 'incomplete', expectedCount: 2, passed: 0});
  expect(terminal.members.every(member => member.status === 'incomplete' && !member.runId)).toBe(true);
});

test('early suite cancellation retains absent member fences without launching and retries a lost acknowledgement', async () => {
  let plan: NightlyPlan | null = null, launches = 0, loseAcknowledgement = true;
  const requestRows = new Map<string, any>(), cancellations: any[] = [];
  const jobs = {async submitFrozen() {launches++; throw new TestRunError(503, 'Admission unavailable');},
    async cancelFrozen(selection: any, deadline: string, value: {reason: string}) {
      cancellations.push({selection: structuredClone(selection), deadline, reason: value.reason});
      if (!requestRows.has(selection.requestId)) requestRows.set(selection.requestId, {requestId: selection.requestId,
        fleetSelection: selection, fleetSelectionSha256: requestInputDigest(selection), state: 'terminal', fleetCancellation: value});
      if (loseAcknowledgement && selection.requestId === plan!.members[0]!.requestId) {
        loseAcknowledgement = false;
        throw new TestRunError(503, 'Cancellation acknowledgement lost');
      }
      return {} as any;
    }, async cancel() {throw new Error('Must not submit before the cancellation fence');}};
  const repository = {...cancellationRepository(), async get() {return plan;}, async freeze(value: NightlyPlan) {plan ??= value; return plan;},
    async completed() {return null;}, async finish(_id: string, value: NightlyResult) {return value;}};
  const create = () => new ActualNightlyRoutineService({async list() {return [row('cancel-one', 'android'), row('cancel-two', 'ios-on-mac')];}} as any,
    {async latestDev(platform) {return build(platform);}, async resolve(source, platform) {return {...build(platform), source};}},
    {async get(id) {return requestRows.get(id) ?? null;}}, repository, undefined, () => now, undefined,
    {async resolve() {return mainRevision;}}, jobs);
  const first = await create().start(occurrence);
  expect(launches).toBe(2);
  expect(first.admissions.every(admission => !admission.admitted)).toBe(true);
  await expect(create().cancel(occurrence.occurrenceId, {reason: 'Superseded'})).rejects.toThrow('retry this occurrence cancellation');
  expect(requestRows.size).toBe(2);
  expect(await create().start(occurrence)).toMatchObject({admissions: []});
  expect(await create().cancel(occurrence.occurrenceId, {reason: 'Changed retry reason'})).toMatchObject({requestsCancellationRecorded: true});
  expect(launches).toBe(2);
  expect(cancellations.every(value => value.reason === 'Superseded' && value.deadline === new Date(now + 3 * 3600_000).toISOString())).toBe(true);
  expect(cancellations.map(value => requestInputDigest(value.selection))).toEqual([
    ...first.plan.members, ...first.plan.members, ...first.plan.members].map(member => requestInputDigest(member.selection)));
  expect([...requestRows.values()].every(value => value.fleetCancellation.reason === 'Superseded' && !value.fleetBinding)).toBe(true);
});

test('fleet nightly rejects a changed bound app selection before using host result evidence', async () => {
  const state = fixture([row('bound-product', 'android')]), {plan} = await state.service.start(occurrence), member = plan.members[0]!;
  const request = state.requestRows.get(member.requestId), changed = {...request.dispatchIntent, build: {...request.dispatchIntent.build, headSha: '9'.repeat(40)}};
  request.dispatchIntent = changed; request.dispatchIntentSha256 = requestInputDigest(changed);
  expect((await state.service.detail(occurrence.occurrenceId)).members[0]).toMatchObject({status: 'incomplete',
    unavailableReason: 'Bound request source differs from the frozen selection.'});
});

test('terminal fleet suite projects actual assignments and refuses changed binding custody', async () => {
  const state = fixture(), {plan} = await state.service.start(occurrence);
  for (const member of plan.members) state.resultRows.set(member.requestId, publishedResult(member, true));
  const result = await state.service.complete(occurrence.occurrenceId);
  const {nightlySuiteProjection} = await import('./test-suite.service');
  expect(nightlySuiteProjection(plan.suite!, plan, result)).toMatchObject({outcome: 'passed', passed: 2,
    members: [{hostId: 'mini', laneId: 'android'}, {hostId: 'mini', laneId: 'ios-on-mac'}]});
  const corrupt = structuredClone(result);
  corrupt.members[0]!.binding!.hostId = 'another-host';
  expect(() => nightlySuiteProjection(plan.suite!, plan, corrupt)).toThrow('binding');
});

test('result outages preserve validated binding in live and frozen suite projections after restart', async () => {
  const state = fixture(), {plan} = await state.service.start(occurrence);
  const member = plan.members[0]!, request = state.requestRows.get(member.requestId);
  state.resultRows.set(member.requestId, new TestRunError(503, 'Result store unavailable'));
  state.resultRows.set(plan.members[1]!.requestId, publishedResult(plan.members[1]!, true));
  const snapshot = await state.service.snapshot(plan);
  expect(snapshot.members[0]).toMatchObject({status: 'waiting', hostId: request.hostId, binding: request.fleetBinding,
    dispatchIntent: request.dispatchIntent, input: request.input, inputSha256: request.inputSha256});
  const {nightlySuiteProjection} = await import('./test-suite.service');
  expect(nightlySuiteProjection(plan.suite!, plan, snapshot)).toMatchObject({outcome: 'running',
    members: [{hostId: 'mini', laneId: 'android', status: 'waiting'}, {hostId: 'mini', laneId: 'ios-on-mac', status: 'pass'}]});
  state.clock = now + 3 * 3600_000;
  const frozen = await state.service.complete(occurrence.occurrenceId);
  expect(frozen.members[0]).toMatchObject({status: 'incomplete', hostId: request.hostId, binding: request.fleetBinding,
    dispatchIntent: request.dispatchIntent, input: request.input, inputSha256: request.inputSha256});
  const afterRestart = structuredClone(frozen);
  expect(nightlySuiteProjection(structuredClone(plan.suite!), structuredClone(plan), afterRestart)).toMatchObject({outcome: 'failed',
    members: [{hostId: 'mini', laneId: 'android', status: 'not-run'}, {hostId: 'mini', laneId: 'ios-on-mac', status: 'pass'}]});
  expect(await state.service.detail(occurrence.occurrenceId)).toEqual(frozen);
  expect(await state.service.complete(occurrence.occurrenceId)).toEqual(frozen);
});

test('actual fleet service preserves every nightly member through preparation, binding, result outage and frozen restart', async () => {
  let clock = now, plan: NightlyPlan | null = null, finished: NightlyResult | null = null, reads = 0, dispatches = 0;
  const requestRows = new Map<string, StoredRoutineJob>(), results = new Map<string, any>();
  const copy = <T>(value: T): T => structuredClone(value);
  const rows: RoutineJobRepository = {
    async get(id) {return copy(requestRows.get(id) ?? null);},
    async insert(value) {if (requestRows.has(value.requestId)) throw Object.assign(new Error('duplicate'), {code: 11000}); requestRows.set(value.requestId, copy(value));},
    async prepare(id, digest, preparation, inputSha256) {
      const value = requestRows.get(id); if (!value || value.fleetCancellation || value.fleetSelectionSha256 !== digest) return null;
      const next = {...value, state: 'awaiting-runner' as const, fleetPreparation: preparation, fleetInputSha256: inputSha256};
      requestRows.set(id, next); return copy(next);
    },
    async bind(id, digest, binding, intent) {
      const value = requestRows.get(id); if (!value || value.fleetCancellation || value.fleetBinding || value.fleetInputSha256 !== digest) return null;
      const next = {...value, state: 'preparing' as const, hostId: binding.hostId, fleetBinding: binding,
        dispatchIntent: intent, dispatchIntentSha256: requestInputDigest(intent)};
      requestRows.set(id, next); return copy(next);
    },
    async dispatch(id, previous, value) {
      const current = requestRows.get(id); if (!current || current.fleetBinding || current.fleetCancellation || requestInputDigest(current.fleetDispatch ?? null) !== requestInputDigest(previous ?? null)) return null;
      const next = {...current, fleetDispatch: value}; requestRows.set(id, next); return copy(next);
    },
    async cancel(id, digest, cancellation) {
      const value = requestRows.get(id); if (!value || value.fleetSelectionSha256 !== digest || value.fleetCancellation) return null;
      const next = {...value, fleetCancellation: cancellation, ...(!value.fleetBinding ? {state: 'terminal' as const, terminalStatus: 'not-run'} : {})};
      requestRows.set(id, next); return copy(next);
    },
  };
  const lanes = ['android', 'ios-on-mac'].map(platform => {
    const lane = {id: platform, platform: platform as 'android' | 'ios-on-mac', state: 'idle' as const, dispatchMode: 'automatic' as const,
      resources: [...(platform === 'android' ? [{id:`phone:${platform}`,kind:'phone' as const}] : []), {id: `app:${platform}`, kind: 'app' as const}, {id: `recorder:${platform}`, kind: 'recorder' as const}]};
    return {...lane, descriptorRevision: routineLaneDescriptorRevision(lane)};
  });
  const requests = {async get(id: string) {reads++; return copy(requestRows.get(id) ?? null) as any;}, async cancel() {return null;}};
  const summary = {async summary(id: string) {const result = results.get(id); if (result instanceof Error) throw result; if (!result) throw new TestRunError(404, 'No result'); return result;}, async detail() {throw new TestRunError(404, 'No result');}};
  const jobs = new RoutineJobService(rows, undefined, undefined, {async getExact() {return null;}},
    {async get(hostId) {return {hostId, incarnation: 'one', incarnationGeneration: 1, sequence: 1,
      observedAt: new Date(clock).toISOString(), receivedAt: new Date(clock).toISOString(), lanes};}}, requests, summary, () => clock,
    {async dispatch() {dispatches++;}, async cancel() {}});
  const repository = {...cancellationRepository(), async get() {return copy(plan);}, async freeze(value: NightlyPlan) {plan ??= copy(value); return copy(plan);},
    async completed() {return copy(finished);}, async finish(_id: string, value: NightlyResult) {finished ??= copy(value); return copy(finished);}};
  const catalog = [row('lifecycle-one', 'android'), row('lifecycle-two', 'ios-on-mac')];
  const create = () => new ActualNightlyRoutineService({async list() {return catalog;}} as any,
    {async latestDev(platform) {return build(platform);}, async resolve(source, platform) {return {...build(platform), source};}},
    requests, repository, summary, () => clock, undefined, {async resolve() {return mainRevision;}}, jobs);
  const service = create(), first = await service.start(occurrence), frozenPlan = copy(first.plan);
  const {nightlySuiteProjection} = await import('./test-suite.service');
  const project = async () => nightlySuiteProjection(first.plan.suite!, first.plan, await service.detail(occurrence.occurrenceId));
  expect(dispatches).toBe(2); expect((await project()).members.every(member => member.status === 'waiting' && !member.hostId && !member.laneId)).toBe(true);
  for (const member of first.plan.members) {
    const definition = {...row(member.routineId, member.platform).definition, source: {repository: 'Mentra-Community/Mentra-Automated-Testing', revision: mainRevision, path: `routines/${member.routineId}/routine.ts`}};
    await jobs.prepared(member.requestId, {inputSha256: requestRows.get(member.requestId)!.fleetSelectionSha256,
      routineSource: testRoutineSource(mainRevision), definitionSha256: requestInputDigest(definition), definition});
  }
  expect((await service.detail(occurrence.occurrenceId)).members.every(member => member.status === 'waiting' && member.unavailableReason === 'Awaiting compatible runner.')).toBe(true);
  for (const member of first.plan.members) {
    const preparation = await jobs.preparation(member.requestId), lane = lanes.find(lane => lane.id === member.platform)!;
    expect((await jobs.bind(member.requestId, 'real-host', {inputSha256: preparation.inputSha256, laneId: lane.id,
      descriptorRevision: lane.descriptorRevision, actionsRunId: member.platform === 'android' ? '10' : '11', actionsJobId: '20'})).execute).toBe(true);
  }
  expect(await project()).toMatchObject({members: [{hostId: 'real-host', laneId: 'android', status: 'waiting'}, {hostId: 'real-host', laneId: 'ios-on-mac', status: 'waiting'}]});
  for (const member of first.plan.members) {
    const value = requestRows.get(member.requestId)!, intent = value.dispatchIntent as any;
    const input = {...preparedRequest(value.hostId!, intent).input, routineSource: testRoutineSource(mainRevision)};
    requestRows.set(member.requestId, {...value, input, inputSha256: requestInputDigest(input), state: 'accepted'} as any);
  }
  const boundMember = first.plan.members[1]!, bound = requestRows.get(boundMember.requestId)!;
  results.set(boundMember.requestId, {...publishedResult(boundMember, true), hostId: bound.hostId,
    routineSource: testRoutineSource(mainRevision)});
  results.set(first.plan.members[0]!.requestId, new TestRunError(503, 'Temporary result outage'));
  expect(await project()).toMatchObject({passed: 1, members: [{status: 'waiting', hostId: 'real-host', laneId: 'android'}, {status: 'pass', hostId: 'real-host', laneId: 'ios-on-mac'}]});
  clock += 3 * 3600_000;
  const terminal = await service.complete(occurrence.occurrenceId);
  expect(terminal).toMatchObject({status: 'incomplete', expectedCount: 2, passed: 1});
  expect(nightlySuiteProjection(first.plan.suite!, first.plan, terminal)).toMatchObject({outcome: 'failed', members: [{status: 'not-run', laneId: 'android'}, {status: 'pass', laneId: 'ios-on-mac'}]});
  const before = reads; requestRows.clear(); results.clear();
  expect(await create().detail(occurrence.occurrenceId)).toEqual(terminal); expect(reads).toBe(before);
  expect(await repository.get()).toEqual(frozenPlan); expect(dispatches).toBe(2);
});


test("stopped CI occurrences reconcile cancellation and deadlines independently without rewriting terminal receipts", async () => {
  const state = fixture(), {plan} = await state.service.start(occurrence);
  const second = {occurrenceId: "different-stopped-ci", suiteId: "nightly-different-stopped-ci"};
  const rows = [{suiteId: plan.suiteId, nightlyPlan: {occurrenceId: plan.occurrenceId}},
    {suiteId: second.suiteId, nightlyPlan: {occurrenceId: second.occurrenceId}}];
  const query = spyOn(TestSuiteModel, "find").mockImplementation(((filter: any) => {
    expect(filter.nightlyResult).toEqual({$exists: false});
    expect(filter["nightlyPlan.members.input"]).toEqual({$exists: false});
    expect(filter.$or).toEqual([{nightlyCancellation: {$exists: true}},
      {startedAt: {$lte: new Date(now - 3 * 3600_000)}}]);
    return {select(fields: unknown) {expect(fields).toEqual({"nightlyPlan.occurrenceId": 1, suiteId: 1}); return this;},
      sort() {return this;}, limit(value: number) {expect(value).toBe(20); return this;}, read() {return this;},
      setOptions(value: unknown) {expect(value).toEqual({timeoutMS: 10_000}); return this;},
      readConcern() {return this;}, async lean() {return rows;}};
  }) as any);
  const calls: string[] = [];
  const complete = spyOn(state.service, "complete").mockImplementation(async (id: string) => {
    calls.push(id);
    if (id === plan.occurrenceId) throw new TestRunError(503, "Temporary cancellation custody failure");
    return {finishedAt: startedAt} as NightlyResult;
  });
  try {
    await state.service.reconcilePending();
    expect(calls).toEqual([plan.occurrenceId, second.occurrenceId]);
    await state.service.reconcilePending();
    expect(calls).toEqual([plan.occurrenceId, second.occurrenceId, plan.occurrenceId, second.occurrenceId]);
    expect(state.plan).toBe(plan);
  } finally {query.mockRestore(); complete.mockRestore();}
});

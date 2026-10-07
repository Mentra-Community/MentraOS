import {testRoutineSource, testFrameworkBinding} from "../testing/framework-fixtures"
import {expect, spyOn, test} from "bun:test";
import {NightlyRoutineService as ActualNightlyRoutineService, nightlyPlanRepository, type NightlyPlan, type NightlyResult, type NightlyPlanRepository} from "./nightly-routine.service";
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

const mainRevision = "7".repeat(40);
class NightlyRoutineService extends ActualNightlyRoutineService {
  constructor(...args: ConstructorParameters<typeof ActualNightlyRoutineService>) {
    args[9] ??= {async resolve() {return mainRevision;}};
    super(...args);
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
        requires: [],
        requirements: [],
        fixtures: [],
        steps: [{id: "check", instruction: "Check", expected: "Checked"}],
        execution: {resourceKinds: ["app"]},
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
    repository ?? {async get() {return plan;}, async freeze(next) {plan ??= next; return plan;}, async completed() {return finished;}, async finish(_id, result) {finished ??= result; return finished;}},
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
  expect(result.plan.members.every(member => member.dispatchIntent!.build.headSha === "e".repeat(40))).toBe(true);
  expect(result.plan.members.every(member => member.routineRevision === mainRevision && !("routineSource" in member) && !("input" in member))).toBe(true);
  state.main = "8".repeat(40);
  state.catalog = [row("later-routine", "android")];
  const retry = await state.service.start(occurrence);
  expect(retry.plan).toEqual(result.plan);
  expect(state.reads).toBe(1);
  expect(state.sourceReads).toBe(1);
  expect(state.admitted[2]).toEqual(state.admitted[0]);
  await expect(state.service.start({...occurrence, startedAt: "2026-10-03T12:00:00Z"})).rejects.toThrow("changed");
});
test("one failed admission does not suppress neighboring members and retries the same request", async () => {
  const state = fixture(), first = await state.service.start(occurrence);
  state.failId = first.plan.members[0]!.requestId;
  const retry = await state.service.start(occurrence);
  expect(retry.admissions.map(row => row.admitted)).toEqual([false, true]);
  state.failId = undefined;
  expect((await state.service.start(occurrence)).admissions.every(row => row.admitted)).toBe(true);
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
test("a missing platform binding retains its expected member and never creates a false all-pass", async () => {
  let plan: NightlyPlan | null = null;
  const service = new NightlyRoutineService({async list() {return [row("unbound-routine", "android")];}} as any,
    {async latestDev(platform) {return build(platform);}, async resolve(source, platform) {return {...build(platform), source};}}, {async get() {throw new Error("must not look up an unbound fleet");}},
    {async cancelPreparationSubmission() {return {} as any;}, async get() {return null;}, async prepare() {throw new Error("must not submit");}},
    {async get() {return plan;}, async freeze(next) {plan = next; return next;}, async completed() {return null;}, async finish(_id, value) {return value;}},
    () => ({}), undefined, () => now);
  const result = await service.start(occurrence);
  expect(result.plan.members).toHaveLength(1);
  expect(result.plan.members[0]!.unavailableReason).toContain("lane");
  expect(result.plan.suite).toBeUndefined();
  const detail = await service.detail(occurrence.occurrenceId);
  expect(detail.status).toBe("incomplete");
  expect(detail.resultUrl).toBeUndefined();
});
test("result matching refuses changed artifact/source identity and terminal receipts fence later changes", async () => {
  const state = fixture([row("single-routine", "android")]);
  const {plan} = await state.service.start(occurrence), member = plan.members[0]!;
  state.resultRows.set(member.requestId, {routineId: member.routineId, platform: member.platform, definitionRevision: member.definitionRevision,
    hostId: member.hostId, laneId: member.dispatchIntent!.laneId, build: {...member.dispatchIntent!.build, source: {channel: "dev", buildRunId: 22, publicationAttempt: 2}}, runId: member.requestId,
    outcome: "pass", uploadsComplete: true, evidenceStatus: "complete"});
  expect((await state.service.detail(occurrence.occurrenceId)).status).toBe("incomplete");
  const final = await state.service.complete(occurrence.occurrenceId);
  state.resultRows.get(member.requestId).build = member.dispatchIntent!.build;
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
  for (const build of [{...member.dispatchIntent!.build, archive: {sha256: "2".repeat(64)}},
    {...member.dispatchIntent!.build, source: {channel: "dev", buildRunId: 21, publicationAttempt: 99}}]) {
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
  const prepared = preparedRequest(member.hostId!, member.dispatchIntent), inputSha256 = prepared.inputSha256;
  state.requestRows.set(member.requestId, {...prepared, state: "terminal", terminalStatus: "not-run", hostRejection: {requestId: member.requestId,
    hostId: member.hostId, inputSha256, rejectedAt: startedAt, code: "missing-definition", reason: "The requested source is not installed."}});
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

test("an admission completing across the deadline is cancelled through the ordinary request path", async () => {
  let clock = now, saved: NightlyPlan | null = null;
  const cancelled: string[] = [];
  const service = new NightlyRoutineService({async list() {return [row("late-product", "android")];}} as any,
    {async latestDev(platform) {return build(platform);}, async resolve(source, platform) {return {...build(platform), source};}},
    {async get() {return host;}}, {async get() {return null;}, async prepare() {clock = now + 3 * 3600_000; return {} as any;},
      async cancelPreparationSubmission(id) {cancelled.push(id); return {} as any;}},
    {async get() {return saved;}, async freeze(plan) {saved = plan; return plan;}, async completed() {return null;}, async finish(_id, result) {return result;}},
    () => ({android: {hostId: "mini", laneId: "android"}}), undefined, () => clock);
  const {plan} = await service.start(occurrence);
  expect(cancelled).toEqual([plan.members[0]!.requestId]);
});

test("deadline fences a concurrent uncertain admission before completion and across service restart", async () => {
  for (const insertFirst of [false, true]) {
    const rows = new Map<string, StoredRequest>();
    let release!: () => void, entered!: () => void;
    const paused = new Promise<void>(resolve => {release = resolve;}), inserting = new Promise<void>(resolve => {entered = resolve;});
    const commit = (request: StoredPreparingRequest) => {
      if (rows.has(request.requestId)) throw Object.assign(new Error("duplicate"), {code: 11000});
      rows.set(request.requestId, structuredClone(request));
    };
    const requestRepository: TestRequestRepository = {
      async insert() {throw new Error("Must not insert executable input before host preparation");},
      async insertPreparation(request) {
        if (request.state === "preparing") {
          if (insertFirst) commit(request);
          entered();
          await paused;
          if (!insertFirst) commit(request);
          throw new Error("Committed admission acknowledgement lost");
        }
        commit(request);
      },
      async get(id) {return structuredClone(rows.get(id) ?? null);},
      async cancelPreparation(id, digest, value) {
        const request = rows.get(id);
        if (!request || request.dispatchIntentSha256 !== digest || request.state !== "preparing") return null;
        request.state = "terminal"; request.terminalStatus = "cancelled";
        (request as StoredPreparingRequest).preparationCancellation = value;
        return structuredClone(request);
      },
      async cancel() {throw new Error("No executable input exists");},
      async queued() {return [];}, async preparations(hostId) {return [...rows.values()].filter(request => request.hostId === hostId && request.state === "preparing") as StoredPreparingRequest[];},
      async accept() {throw new Error("unused acceptance");}, async reject() {throw new Error("unused rejection");},
      async acknowledgeCancellation() {throw new Error("unused acknowledgement");}, async cancellations() {return [];},
    };
    let saved: NightlyPlan | null = null, completed: NightlyResult | null = null, clock = now;
    const repository: NightlyPlanRepository = {async get() {return saved;}, async freeze(plan) {saved ??= plan; return saved;},
      async completed() {return completed;}, async finish(_id, result) {completed ??= result; return completed;}};
    const makeService = () => new NightlyRoutineService({async list() {return [row("race-product", "android")];}} as any,
      {async latestDev(platform) {return build(platform);}, async resolve(source, platform) {return {...build(platform), source};}},
      {async get() {return host;}}, new TestRequestService(requestRepository), repository,
      () => ({android: {hostId: "mini", laneId: "android"}}), {async summary() {throw new TestRunError(404, "No framework run");}}, () => clock);
    const original = makeService(), admission = original.start(occurrence);
    await inserting;
    clock = now + 3 * 3600_000;
    const terminal = await makeService().complete(occurrence.occurrenceId);
    const member = saved!.members[0]!, cancelled = rows.get(member.requestId)!;
    expect(terminal).toMatchObject({status: "incomplete", expectedCount: 1});
    expect(cancelled).toMatchObject({hostId: member.hostId, dispatchIntent: member.dispatchIntent, dispatchIntentSha256: requestInputDigest(member.dispatchIntent),
      state: "terminal", terminalStatus: "cancelled", preparationCancellation: {requestedAt: "2026-10-03T14:00:00.000Z"}});
    // A replacement process reconciles the retained fence while the original insert is still unacknowledged.
    expect((await makeService().start(occurrence)).admissions).toEqual([]);
    expect(await makeService().complete(occurrence.occurrenceId)).toEqual(terminal);
    release();
    expect((await admission).admissions).toEqual([{memberId: member.memberId, admitted: false,
      reason: "Nightly occurrence reached its completion boundary."}]);
    expect(await makeService().complete(occurrence.occurrenceId)).toEqual(terminal);
    expect(rows.get(member.requestId)).toEqual(cancelled);
    expect((await new TestRequestService(requestRepository).queued("mini", undefined, 100)).requests).toEqual([]);
    expect(cancelled.input).toBeUndefined();
    expect((await new TestRequestService(requestRepository).queued("mini", undefined, 100)).preparations).toEqual([]);
  }
});

test("admission receipts distinguish unexecuted cancellation and rejection from completed execution", async () => {
  for (const status of ["cancelled", "not-run", "pass", "failed"]) {
    let saved: NightlyPlan | null = null;
    const service = new NightlyRoutineService({async list() {return [row("receipt-product", "android")];}} as any,
      {async latestDev(platform) {return build(platform);}, async resolve(source, platform) {return {...build(platform), source};}},
      {async get() {return host;}}, {async get() {return null;}, async cancelPreparationSubmission() {throw new Error("Must not cancel before boundary");},
        async prepare(hostId, intent) {const {requestId, input, inputSha256, ...prepared} = preparedRequest(hostId, intent); return {...prepared, requestId, input, inputSha256, state: "terminal", terminalStatus: status,
          ...(status === "not-run" ? {hostRejection: {requestId, hostId, inputSha256: requestInputDigest(input), rejectedAt: startedAt,
            code: "unavailable-definition", reason: "The enrolled definition is unavailable."}} : {}),
          ...(status === "cancelled" ? {hostCancellation: {requestId, hostId, inputSha256: requestInputDigest(input), requestedAt: startedAt,
            reason: "Cancelled by the occurrence boundary."}} : {}),
          ...(["pass", "failed"].includes(status) ? {runId: requestId} : {})};}},
      {async get() {return saved;}, async freeze(plan) {saved = plan; return plan;}, async completed() {return null;}, async finish(_id, result) {return result;}},
      () => ({android: {hostId: "mini", laneId: "android"}}), undefined, () => now);
    const [admission] = (await service.start(occurrence)).admissions;
    expect(admission!.admitted).toBe(["pass", "failed"].includes(status));
    if (status === "not-run") expect(admission!.reason).toBe("unavailable-definition: The enrolled definition is unavailable.");
    if (status === "cancelled") expect(admission!.reason).toBe("Cancelled by the occurrence boundary.");
  }
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
      {async get() {return saved;}, async freeze(plan) {saved = plan; return plan;}, async completed() {return null;}, async finish(_id, result) {return result;}},
      () => ({"android": {hostId: "mini", laneId: "android"}, "ios-on-mac": {hostId: "mini", laneId: "ios-on-mac"}}),
      undefined,
      () => now,
    )
    const {plan} = await service.start(occurrence);
    expect(plan.members).toHaveLength(2);
    expect(plan.members[mismatch ? 1 : 0]!.dispatchIntent).toBeUndefined();
    expect(plan.members[mismatch ? 0 : 1]!.dispatchIntent).toBeDefined();
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
    routineSource: testRoutineSource(member.routineRevision), hostId: member.hostId, laneId: member.dispatchIntent!.laneId, build: member.dispatchIntent!.build, runId: member.requestId,
    startedAt, finishedAt: "2026-10-03T11:01:00Z",
    outcome: "pass", uploadsComplete, evidenceStatus: "complete"};
}

test("nightly and Admin share one terminal authority across concurrent uploads, completers and a lost write ACK", async () => {
  // Direct Admin completion rechecks cancellation custody through the same default request repository.
  const cancelInsert = spyOn(TestRequestModel, "create").mockImplementation((async (rows: any[]) => rows) as any);
  const stored: any = {};
  const query = {read() {return this;}, readConcern() {return this;}, lean: async () => stored};
  const find = spyOn(TestSuiteModel, "findOne").mockReturnValue(query as any);
  const create = spyOn(TestSuiteModel, "create").mockImplementation((async (rows: any[]) => {
    Object.assign(stored, rows[0]); return rows;
  }) as any);
  let state: ReturnType<typeof fixture>, failedAck = false;
  const changes: any[] = [];
  const update = spyOn(TestSuiteModel, "updateOne").mockImplementation((async (_filter: any, change: any) => {
    changes.push(change.$set);
    // An upload commits after the terminal snapshot was read but before its durable write.
    for (const result of state.resultRows.values()) result.uploadsComplete = true;
    if (!stored.nightlyResult) {
      Object.assign(stored, structuredClone(change.$set));
      if (!failedAck) {failedAck = true; throw new Error("ACK lost after durable commit");}
    }
    return {modifiedCount: 0};
  }) as any);
  try {
    state = fixture(undefined, nightlyPlanRepository);
    const {plan} = await state.service.start(occurrence);
    for (const member of plan.members) state.resultRows.set(member.requestId, publishedResult(member, false));
    state.clock = now + 3 * 3600_000;
    const completions = await Promise.allSettled([state.service.complete(occurrence.occurrenceId), state.service.complete(occurrence.occurrenceId)]);
    expect(completions.some(result => result.status === "rejected")).toBe(true);
    const receipt = await state.service.complete(occurrence.occurrenceId);
    const admin = await new TestSuiteService().detail(plan.suiteId);
    expect(receipt).toEqual(stored.nightlyResult);
    expect(receipt).toMatchObject({status: "incomplete", expectedCount: 2, passed: 0});
    expect(admin).toMatchObject({outcome: "failed", passed: receipt.passed, finishedAt: receipt.finishedAt});
    expect(admin.members.map(member => member.publicationComplete)).toEqual(receipt.members.map(member => member.publicationComplete));
    expect(admin.members.map(member => member.startedAt)).toEqual(receipt.members.map(member => member.runStartedAt));
    expect(admin.members.map(member => member.finishedAt)).toEqual(receipt.members.map(member => member.runFinishedAt));
    expect(admin.failedRoutines.sort()).toEqual(receipt.members.map(member => member.routineId).sort());
    expect(stored.completedResult).toBeUndefined();
    expect(changes.every(change => !change.completedResult)).toBe(true);
    // Direct suite completion resumes the same occurrence authority and never snapshots later uploads.
    expect(await new TestSuiteService().complete(plan.suiteId, {finishedAt: "2026-10-03T16:00:00Z"})).toEqual(admin);
    expect(await state.service.detail(occurrence.occurrenceId)).toEqual(receipt);
    stored.nightlyResult.members[0].input.build.headSha = "8".repeat(40);
    await expect(new TestSuiteService().detail(plan.suiteId)).rejects.toThrow("frozen input");
  } finally {update.mockRestore(); create.mockRestore(); find.mockRestore(); cancelInsert.mockRestore();}
});

test("selection retains independently resolved artifacts and safe original typed diagnostics", async () => {
  for (const stage of ["host", "build", "unknown"] as const) {
    let saved: NightlyPlan | null = null;
    const logged: unknown[] = [];
    const unknown = new Error("private upstream detail");
    const service = new NightlyRoutineService(
      {async list() {return [row("phone-product", "android"), row("desktop-product", "ios-on-mac")];}} as any,
      {async latestDev(platform) {return build(platform);}, async resolve(source, platform) {
        if (stage === "build") throw new TestDispatchError(502, "Immutable receipt SHA does not match publication 21.");
        return {...build(platform), source};
      }},
      {async get(id) {
        if (id === "desktop-host") throw stage === "unknown" ? unknown : new TestRunError(503, "Host observation storage is unavailable.");
        return host;
      }},
      {async cancelPreparationSubmission() {return {} as any;}, async get() {return null;}, async prepare() {return {} as any;}},
      {async get() {return saved;}, async freeze(plan) {saved = plan; return plan;}, async completed() {return null;}, async finish(_id, result) {return result;}},
      () => ({
        "android": {hostId: "mini", laneId: "android"},
        "ios-on-mac": {hostId: "desktop-host", laneId: "ios-on-mac"},
      }),
      undefined,
      () => now,
      (error, context) => logged.push({error, context}),
    )
    const {plan} = await service.start(occurrence), desktop = plan.members[1]!;
    expect(plan.members[0]!.dispatchIntent).toBeDefined();
    expect(desktop.dispatchIntent).toBeUndefined();
    expect(plan.publication!.source).toEqual(build("android").source);
    if (stage === "build") {
      expect(desktop.selectionErrors).toEqual([{stage: "build", status: 502, message: "Immutable receipt SHA does not match publication 21."},
        {stage: "host", status: 503, message: "Host observation storage is unavailable."}]);
      expect(desktop.build).toBeUndefined();
    } else {
      expect(desktop.build!.archive!.sha256).toBe(build("ios-on-mac").archive!.sha256);
      expect(desktop.build!.source).toEqual(build("ios-on-mac").source);
      expect(desktop.selectionErrors).toEqual([{stage: "host", ...(stage === "host" ? {status: 503} : {}),
        message: stage === "host" ? "Host observation storage is unavailable." : "Configured host observation is unavailable."}]);
    }
    if (stage === "unknown") {
      expect(logged).toEqual([{error: unknown, context: {occurrenceId: occurrence.occurrenceId, platform: "ios-on-mac", stage: "host"}}]);
      expect(JSON.stringify(plan)).not.toContain(unknown.message);
    } else expect(logged).toEqual([]);
  }
})

test("automatic lanes prepare through repair/offline states and resource selection waits for the actual definition", async () => {
  for (const laneState of ["in-repair", "out-of-service", "offline", "running"] as const) {
    for (const invalid of [undefined, "mode", "resources"] as const) {
      const observed = structuredClone(host), submitted: string[] = [];
      observed.lanes[0]!.state = laneState;
      if (invalid === "mode") observed.lanes[0]!.dispatchMode = "paused";
      if (invalid === "resources") observed.lanes[0]!.resources = [];
      let saved: NightlyPlan | null = null;
      const service = new NightlyRoutineService(
        {async list() {return [row("phone-product", "android"), row("desktop-product", "ios-on-mac")];}} as any,
        {async latestDev(platform) {return build(platform);}, async resolve(source, platform) {return {...build(platform), source};}},
        {async get() {return observed;}},
        {async cancelPreparationSubmission() {return {} as any;}, async get() {return null;}, async prepare(_hostId, input) {submitted.push(routineDispatchIntentSchema.parse(input).requestId); return {} as any;}},
        {async get() {return saved;}, async freeze(plan) {saved = plan; return plan;}, async completed() {return null;}, async finish(_id, result) {return result;}},
        () => ({"android": {hostId: "mini", laneId: "android"}, "ios-on-mac": {hostId: "mini", laneId: "ios-on-mac"}}),
        undefined,
        () => now,
      )
      const {plan} = await service.start(occurrence);
      expect(plan.members).toHaveLength(2);
      expect(plan.members[1]!.dispatchIntent).toBeDefined();
      expect(submitted).toHaveLength(invalid === "mode" ? 1 : 2);
      if (invalid === "mode") expect(plan.members[0]!.unavailableReason).toBeDefined();
      else expect(plan.members[0]!.dispatchIntent).toBeDefined();
    }
  }
})

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
      {async get() {return saved;}, async freeze(plan) {saved = plan; return plan;}, async completed() {return null;}, async finish(_id, result) {return result;}},
      () => ({"android": {hostId: "mini", laneId: "android"}, "ios-on-mac": {hostId: "mini", laneId: "ios-on-mac"}}),
      undefined,
      () => now,
    )
    const {plan} = await service.start(occurrence);
    expect(plan.members).toHaveLength(2);
    expect(submitted).toEqual(plan.members.map(member => member.requestId))
    expect(plan.members[0]!.dispatchIntent?.routineRevision).toBe(mainRevision)
    expect(plan.members[0]!.dispatchIntent?.routineSource).toBeUndefined()
    expect(plan.members[0]!.unavailableReason).toBeUndefined()
    expect(plan.members[1]!.dispatchIntent).toBeDefined();
    observed.lanes[0]!.routineAvailability = [{routineId: "phone-product", definitionRevision: "a".repeat(40), available: true}];
    const retry = await service.start(occurrence);
    expect(retry.plan).toEqual(plan); // Capability changes cannot silently replace the frozen expected member.
  }
})

test("an unpersisted single admission exposes no dead result link until its stable retry creates the request", async () => {
  const catalog = [row("single-product", "android")];
  const probe = await fixture(catalog).service.start(occurrence), state = fixture(catalog);
  state.failId = probe.plan.members[0]!.requestId;
  const first = await state.service.start(occurrence);
  expect(first.admissions[0]!.admitted).toBe(false);
  expect((await state.service.detail(occurrence.occurrenceId)).resultUrl).toBeUndefined();
  state.failId = undefined;
  await state.service.start(occurrence);
  const detail = await state.service.detail(occurrence.occurrenceId);
  expect(detail.resultUrl).toContain(`testRun=${encodeURIComponent(first.plan.members[0]!.requestId)}`);
  expect(detail.resultUrl).not.toContain("testSuite=");
});

test("nightly preparation reads only passed-once IDs and preferences, never old definition metadata", async () => {
  const historical = row("known-product", "android");
  for (const key of ["definition", "definitionRevision", "definitionSha256", "routineSource"])
    Object.defineProperty(historical, key, {get() {throw new Error(`Nightly must not read old ${key}`);}});
  const state = fixture([historical]); state.autoPrepare = false;
  const {plan, admissions} = await state.service.start(occurrence);
  expect(admissions[0]!.admitted).toBe(true);
  expect(plan.members[0]!.dispatchIntent).toMatchObject({routineId: "known-product", routineRevision: mainRevision,
    laneId: "android", source: build("android").source});
  expect(state.requestRows.get(plan.members[0]!.requestId)).toMatchObject({state: "preparing"});
  expect(state.requestRows.get(plan.members[0]!.requestId).input).toBeUndefined();
});

test("unavailable main source cannot fall back to an old enrolled definition", async () => {
  let plan: NightlyPlan | null = null, available = false, preparations = 0, sourceReads = 0;
  const service = new NightlyRoutineService({async list() {return [row("known-product", "android")];}} as any,
    {async latestDev(platform) {return build(platform);}, async resolve(source, platform) {return {...build(platform), source};}},
    {async get() {return host;}}, {async get() {return null;}, async prepare() {preparations++; return {} as any;}, async cancelPreparationSubmission() {return {} as any;}},
    {async get() {return plan;}, async freeze(next) {plan ??= next; return plan;}, async completed() {return null;}, async finish(_id, result) {return result;}},
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
    unavailableReason: "Request identity differs from the frozen intent."});
  state.requestRows.set(member.requestId, original);
  expect((await state.service.detail(occurrence.occurrenceId))).toMatchObject({status: "pass", passed: 1});
});

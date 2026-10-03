import {expect, spyOn, test} from "bun:test";
import {NightlyRoutineService, nightlyPlanRepository, type NightlyPlan, type NightlyResult} from "./nightly-routine.service";
import {TestSuiteModel} from "../models/test-suite.model";
import type {RoutineCatalogService} from "./routine-catalog.service";
import {routineEnrollmentSchema} from "../types/routine-definition.types";
import type {TestBuild} from "../types/test-build.types";
import type {ReceivedTestHostState} from "./test-host-state.service";
import {TestRunError} from "./test-result-error";

const startedAt = "2026-10-03T11:00:00Z", now = Date.parse(startedAt);
const occurrence = {occurrenceId: "schedule:2026-10-03", startedAt, trigger: "nightly" as const};
function row(id: string, platform: "android" | "ios-on-mac", nightlyEnabled = true) {
  return {...routineEnrollmentSchema.parse({routineId: id, platform, definitionRevision: "a".repeat(40), definitionSha256: "b".repeat(64),
    definition: {id, title: id, purpose: "Check the saved routine", platforms: [platform], entry: "home", account: "lane", requires: [], requirements: [], fixtures: [],
      steps: [{id: "check", instruction: "Check", expected: "Checked"}], execution: {resourceKinds: ["app"]},
      source: {repository: "Mentra-Community/Mentra-Automated-Testing", revision: "a".repeat(40), path: `routines/${id}/routine.ts`}}}), nightlyEnabled,
    example: {runId: `example-${id}`, startedAt, finishedAt: startedAt, recordingAssetId: "video", definitionRevision: "c".repeat(40), build: {repository: "Mentra-Community/MentraOS", channel: "dev" as const, headSha: "d".repeat(40)}}};
}
const build = (platform: "android" | "ios-on-mac"): TestBuild => ({source: {channel: "dev", buildRunId: 21, publicationAttempt: 2}, platform,
  title: "dev", headSha: "e".repeat(40), buildUrl: "https://github.com/Mentra-Community/MentraOS/actions/runs/21", createdAt: startedAt,
  availability: "available", archive: {name: "app", size: 100, sha256: "f".repeat(64), url: "https://artifactscdn.mentraglass.com/app"},
  receipt: {size: 10, sha256: "1".repeat(64), url: "https://artifactscdn.mentraglass.com/receipt"}});
const host: ReceivedTestHostState = {hostId: "mini", incarnation: "one", incarnationGeneration: 1, sequence: 1, observedAt: startedAt, receivedAt: startedAt,
  lanes: ["android", "ios-on-mac"].map(platform => ({id: platform, platform: platform as "android" | "ios-on-mac", dispatchMode: "automatic", state: "running",
    resources: [{id: `app:${platform}`, kind: "app"}]}))};
function fixture(initial = [row("a-new-routine", "android"), row("different.routine", "ios-on-mac"), row("disabled-routine", "android", false)]) {
  let catalog = initial, plan: NightlyPlan | null = null, finished: NightlyResult | null = null, reads = 0;
  let failId: string | undefined, clock = now;
  const admitted: {requestId: string; hostId: string; input: any}[] = [];
  const cancelled: string[] = [], buildReads: string[] = [];
  const resultRows = new Map<string, any>();
  const requestRows = new Map<string, any>();
  const service = new NightlyRoutineService({async list() {reads++; return catalog;}} as Pick<RoutineCatalogService, "list">,
    {async latestDev(platform, before) {buildReads.push("latest:" + platform); expect(before).toBe(startedAt); return build(platform);},
      async resolve(source, platform) {buildReads.push("resolve:" + platform); expect(source).toEqual(build(platform).source); return build(platform);}},
    {async get(id) {expect(id).toBe("mini"); return host;}},
    {async cancel(id) {cancelled.push(id); return null;}, async get(id) {return requestRows.get(id) ?? null;}, async submit(requestId, hostId, input) {if (requestId === failId) throw new Error("queue unavailable"); admitted.push({requestId, hostId, input}); return {} as any;}},
    {async get() {return plan;}, async freeze(next) {plan ??= next; return plan;}, async completed() {return finished;}, async finish(_id, result) {finished ??= result; return finished;}},
    () => ({android: {hostId: "mini", laneId: "android"}, "ios-on-mac": {hostId: "mini", laneId: "ios-on-mac"}}),
    {async detail(id) {const result = resultRows.get(id); if (!result) throw new TestRunError(404, "missing"); return result;}},
    {async detail() {return {} as any;}, async complete() {return {} as any;}}, () => clock);
  return {service, admitted, cancelled, buildReads, resultRows, requestRows, get plan() {return plan!;}, get reads() {return reads;}, set clock(value: number) {clock = value;}, set catalog(next: typeof initial) {catalog = next;}, set failId(value: string | undefined) {failId = value;}};
}
test("nightly freezes the entire enabled catalog, arbitrary IDs and exact current definitions/artifacts", async () => {
  const state = fixture(), result = await state.service.start(occurrence);
  expect(result.plan.members.map(row => row.routineId)).toEqual(["a-new-routine", "different.routine"]);
  expect(state.admitted).toHaveLength(2);
  expect(state.admitted[0]!.input.build.kind).toBe("android-apk");
  expect(state.admitted[0]!.input.build.source).toEqual({channel: "dev", buildRunId: 21, publicationAttempt: 2});
  expect(result.plan.suite!.members[0]!.definitionRevision).toBe("a".repeat(40));
  expect(result.plan.publication).toEqual({source: {channel: "dev", buildRunId: 21, publicationAttempt: 2}, headSha: "e".repeat(40)});
  expect(state.buildReads).toEqual(["latest:android", "resolve:ios-on-mac"]);
  expect(result.plan.members.every(member => member.input!.build.headSha === "e".repeat(40))).toBe(true);
  state.catalog = [row("later-routine", "android")];
  const retry = await state.service.start(occurrence);
  expect(retry.plan).toEqual(result.plan);
  expect(state.reads).toBe(1);
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
test("a missing platform binding retains its expected member and never creates a false all-pass", async () => {
  let plan: NightlyPlan | null = null;
  const service = new NightlyRoutineService({async list() {return [row("unbound-routine", "android")];}} as any,
    {async latestDev(platform) {return build(platform);}, async resolve(source, platform) {return {...build(platform), source};}}, {async get() {throw new Error("must not look up an unbound fleet");}},
    {async cancel() {return null;}, async get() {return null;}, async submit() {throw new Error("must not submit");}},
    {async get() {return plan;}, async freeze(next) {plan = next; return next;}, async completed() {return null;}, async finish(_id, value) {return value;}},
    () => ({}), undefined, undefined, () => now);
  const result = await service.start(occurrence);
  expect(result.plan.members).toHaveLength(1);
  expect(result.plan.members[0]!.unavailableReason).toContain("lane");
  expect(result.plan.suite).toBeUndefined();
  expect((await service.detail(occurrence.occurrenceId)).status).toBe("incomplete");
});
test("result matching refuses changed artifact/source identity and terminal receipts fence later changes", async () => {
  const state = fixture([row("single-routine", "android")]);
  const {plan} = await state.service.start(occurrence), member = plan.members[0]!;
  state.resultRows.set(member.requestId, {run: {routineId: member.routineId, platform: member.platform, definitionRevision: member.definitionRevision,
    hostId: member.hostId, laneId: member.input!.laneId, build: {...member.input!.build, source: {channel: "dev", buildRunId: 22, publicationAttempt: 2}}, result: {runId: member.requestId}},
    outcome: "pass", uploadsComplete: true, evidenceStatus: "complete"});
  expect((await state.service.detail(occurrence.occurrenceId)).status).toBe("incomplete");
  const final = await state.service.complete(occurrence.occurrenceId);
  state.resultRows.get(member.requestId).run.build = member.input!.build;
  expect(await state.service.detail(occurrence.occurrenceId)).toEqual(final);
  expect(final.resultUrl).toContain("testRun=");
  expect(final.resultUrl).not.toContain("testSuite=");
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
  const inputSha256 = requestInputDigest(member.input);
  state.requestRows.set(member.requestId, {hostId: member.hostId, inputSha256, hostRejection: {requestId: member.requestId,
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

test("an admission completing across the deadline is cancelled through the ordinary request path", async () => {
  let clock = now, saved: NightlyPlan | null = null;
  const cancelled: string[] = [];
  const service = new NightlyRoutineService({async list() {return [row("late-product", "android")];}} as any,
    {async latestDev(platform) {return build(platform);}, async resolve(source, platform) {return {...build(platform), source};}},
    {async get() {return host;}}, {async get() {return null;}, async submit() {clock = now + 3 * 3600_000; return {} as any;},
      async cancel(id) {cancelled.push(id); return null;}},
    {async get() {return saved;}, async freeze(plan) {saved = plan; return plan;}, async completed() {return null;}, async finish(_id, result) {return result;}},
    () => ({android: {hostId: "mini", laneId: "android"}}), undefined, undefined, () => clock);
  const {plan} = await service.start(occurrence);
  expect(cancelled).toEqual([plan.members[0]!.requestId]);
});

test("a mismatched platform publication remains expected and missing anchor platform does not suppress its neighbor", async () => {
  for (const mismatch of [true, false]) {
    let saved: NightlyPlan | null = null;
    const service = new NightlyRoutineService({async list() {return [row("phone-product", "android"), row("desktop-product", "ios-on-mac")];}} as any,
      {async latestDev(platform) {return mismatch ? build(platform) : {...build(platform), availability: "unavailable", archive: undefined, receipt: undefined, reason: "APK missing"};},
        async resolve(source, platform) {return {...build(platform), source, ...(mismatch ? {headSha: "9".repeat(40)} : {})};}},
      {async get() {return host;}}, {async cancel() {return null;}, async get() {return null;}, async submit() {return {} as any;}},
      {async get() {return saved;}, async freeze(plan) {saved = plan; return plan;}, async completed() {return null;}, async finish(_id, result) {return result;}},
      () => ({android: {hostId: "mini", laneId: "android"}, "ios-on-mac": {hostId: "mini", laneId: "ios-on-mac"}}), undefined, undefined, () => now);
    const {plan} = await service.start(occurrence);
    expect(plan.members).toHaveLength(2);
    expect(plan.members[mismatch ? 1 : 0]!.input).toBeUndefined();
    expect(plan.members[mismatch ? 0 : 1]!.input).toBeDefined();
    expect(plan.members[mismatch ? 1 : 0]!.unavailableReason).toBeDefined();
  }
});

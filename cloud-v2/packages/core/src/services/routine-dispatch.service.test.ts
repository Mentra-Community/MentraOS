import {testRoutineSource} from "../testing/framework-fixtures";
import {expect, test} from "bun:test";
import {RoutineDispatchService} from "./routine-dispatch.service";
import {routineEnrollmentSchema} from "../types/routine-definition.types";
import {requestInputDigest, TestRequestService, type StoredTestRequest, type TestRequestRepository} from "./test-request.service";
import {TestRunError} from "./test-result-error";

const source = {channel: "pr" as const, prNumber: 12, buildRunId: 55, publicationAttempt: 2};
const selected = {requestId: "pr:12:a-platform", routineId: "arbitrary.new-routine", platform: "android" as const, source};
function fixture(onResolve?: () => Promise<void>) {
  let revision = "a".repeat(40), hostId = "mini", stored: StoredTestRequest | null = null, resolves = 0;
  const admissions: StoredTestRequest[] = [];
  const requests = new TestRequestService({
    async get() {return structuredClone(stored);},
    async insert(row) {
      admissions.push(structuredClone(row));
      if (stored) throw Object.assign(new Error("duplicate"), {code: 11000});
      stored = structuredClone(row);
    },
    async accept() {throw new Error("unused acceptance");}, async reject() {throw new Error("unused rejection");},
    async cancel() {throw new Error("unused cancellation");}, async acknowledgeCancellation() {throw new Error("unused cancellation acknowledgement");},
    async queued() {throw new Error("unused queue read");}, async cancellations() {throw new Error("unused cancellation read");},
  } satisfies TestRequestRepository);
  const definition = () => routineEnrollmentSchema.parse({routineId: selected.routineId, platform: selected.platform, definitionRevision: revision, definitionSha256: "b".repeat(64), routineSource: testRoutineSource(revision),
    definition: {id: selected.routineId, minimumRoutineApiVersion: 1, title: "New routine", purpose: "Check", platforms: ["android"], entry: "home", account: "lane", requires: [], requirements: [], fixtures: [],
      steps: [{id: "check", instruction: "Check", expected: "Checked"}], execution: {resourceKinds: ["app"]}, source: {repository: "Mentra-Community/Mentra-Automated-Testing", revision, path: `routines/${selected.routineId}/routine.ts`}}});
  const service = new RoutineDispatchService({async current() {return [definition()];}, async getCurrent(id, platform) {return id === selected.routineId && platform === selected.platform ? definition() : null;}, async getExact(id, platform, commit) {return id === selected.routineId && platform === selected.platform && /^[a-f0-9]{40}$/.test(commit) ? {...definition(),definitionRevision:commit,routineSource:testRoutineSource(commit),definition:{...definition().definition,source:{...definition().definition.source,revision:commit}}} : null;}},
    {async resolve(value, platform) {resolves++; await onResolve?.(); return {source: value, platform, availability: "available", title: "Candidate", headSha: "c".repeat(40), createdAt: "2026-10-03T11:00:00Z", buildUrl: "https://github.com/Mentra-Community/MentraOS/actions/runs/55",
      archive: {name: "candidate.apk", size: 100, sha256: "d".repeat(64), url: "https://artifactscdn.mentraglass.com/candidate.apk"}, receipt: {size: 10, sha256: "e".repeat(64), url: "https://artifactscdn.mentraglass.com/receipt.json"}};}},
    {async get(hostId) {return {hostId, incarnation: "one", incarnationGeneration: 1, sequence: 1, observedAt: new Date().toISOString(), receivedAt: new Date().toISOString(),
      lanes: [{id: "android-lane", platform: "android", dispatchMode: "automatic", state: "idle", resources: [{id: "app:android", kind: "app"}]}]};}},
    requests, {async detail() {throw new TestRunError(404, "not published");}}, () => ({android: {hostId, laneId: "android-lane"}}));
  return {service, requests, admissions, get resolves() {return resolves;}, set revision(value: string) {revision = value;}, set hostId(value: string) {hostId = value;}};
}
test("exact-source caller discovers arbitrary routines and queues the native frozen build input", async () => {
  const state = fixture();
  expect((await state.service.catalog()).routines[0]!.routineId).toBe(selected.routineId);
  const request = await state.service.submit(selected);
  expect(request.hostId).toBe("mini");
  expect(request.input).toMatchObject({routineId: selected.routineId, platform: "android", definitionRevision: "a".repeat(40),
    laneId: "android-lane", build: {kind: "android-apk", source, headSha: "c".repeat(40)}});
  state.revision = "b".repeat(40);
  expect(await state.service.submit(selected)).toEqual(request);
  expect(state.resolves).toBe(1);
  for (const changed of [{...selected, source: {...source, buildRunId: 56}}, {...selected, routineId: "another-routine"}, {...selected, platform: "ios-on-mac"}])
    await expect(state.service.submit(changed)).rejects.toThrow("changed");
  expect(await state.service.detail(selected.requestId)).toEqual({request, result: null});
});
test("unknown routine/platform and missing explicit platform bindings cannot enter the queue", async () => {
  const state = fixture();
  await expect(state.service.submit({...selected, routineId: "unknown"})).rejects.toThrow("not enrolled");
  const service = new RoutineDispatchService({async current() {return [];}, async getCurrent() {return {} as any;}, async getExact() {return null;}}, undefined, undefined,
    {async get() {return null;}, async submit() {throw new Error("must not queue");}}, undefined, () => ({}));
  await expect(service.submit(selected)).rejects.toThrow("No configured host/lane binding");
});

test("concurrent exact-source retries retain the winning definition and binding while raw queue conflicts remain strict", async () => {
  let release!: () => void, resolving!: () => void;
  const entered = new Promise<void>(resolve => {resolving = resolve;});
  const gate = new Promise<void>(resolve => {release = resolve;});
  const state = fixture(async () => {resolving(); await gate;});
  const first = state.service.submit(selected);
  await entered;
  state.revision = "b".repeat(40); state.hostId = "replacement-mini";
  const second = state.service.submit(selected);
  release();
  const [winner, retry] = await Promise.all([first, second]);
  expect(retry).toEqual(winner);
  expect(winner).toMatchObject({hostId: "mini", input: {definitionRevision: "a".repeat(40)}});
  expect(state.admissions).toHaveLength(2);
  expect(state.admissions[1]).toMatchObject({hostId: "replacement-mini", input: {definitionRevision: "b".repeat(40)}});
  expect(await state.requests.get(selected.requestId)).toEqual(winner);
  expect(winner.inputSha256).toBe(requestInputDigest(winner.input));
  await expect(state.requests.submit(selected.requestId, "replacement-mini", winner.input)).rejects.toThrow("different inputs or host");
});

test("a concurrent changed source cannot borrow the winning request", async () => {
  let release!: () => void, resolving!: () => void;
  const entered = new Promise<void>(resolve => {resolving = resolve;});
  const gate = new Promise<void>(resolve => {release = resolve;});
  const state = fixture(async () => {resolving(); await gate;});
  const first = state.service.submit(selected);
  await entered;
  const changed = state.service.submit({...selected, source: {...source, publicationAttempt: 3}});
  release();
  const results = await Promise.allSettled([first, changed]);
  expect(results[0].status).toBe("fulfilled");
  expect(results[1].status).toBe("rejected");
  if (results[1].status === "rejected") expect(results[1].reason).toMatchObject({status: 409, message: expect.stringContaining("changed")});
  expect((await state.requests.get(selected.requestId))?.input).toMatchObject({build: {source}});
});

test('explicit historical routine source and framework floor are independent immutable selections', async () => {
  const state = fixture(), routineSource = testRoutineSource("d".repeat(40));
  const request = await state.service.submit({...selected, routineSource, minimumFrameworkVersion: 42});
  expect(request.input).toMatchObject({definitionRevision: routineSource.commit, routineSource, minimumFrameworkVersion: 42});
  expect(request.input).not.toHaveProperty('frameworkBinding');
  state.revision = "b".repeat(40);
  expect(await state.service.submit({...selected, routineSource, minimumFrameworkVersion: 42})).toEqual(request);
  await expect(state.service.submit({...selected, routineSource, minimumFrameworkVersion: 43})).rejects.toThrow("changed");
  await expect(state.service.submit({...selected, routineSource: {...routineSource, bundle: {...routineSource.bundle, sha256: "c".repeat(64)}}, minimumFrameworkVersion: 42})).rejects.toThrow("changed");
});

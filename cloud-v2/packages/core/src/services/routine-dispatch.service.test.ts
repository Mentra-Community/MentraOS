import {expect, test} from "bun:test";
import {RoutineDispatchService} from "./routine-dispatch.service";
import {routineEnrollmentSchema} from "../types/routine-definition.types";
import type {StoredTestRequest} from "./test-request.service";
import {TestRunError} from "./test-result-error";

const source = {channel: "pr" as const, prNumber: 12, buildRunId: 55, publicationAttempt: 2};
const selected = {requestId: "pr:12:a-platform", routineId: "arbitrary.new-routine", platform: "android" as const, source};
function fixture() {
  let revision = "a".repeat(40), stored: StoredTestRequest | null = null, resolves = 0;
  const definition = () => routineEnrollmentSchema.parse({routineId: selected.routineId, platform: selected.platform, definitionRevision: revision, definitionSha256: "b".repeat(64),
    definition: {id: selected.routineId, title: "New routine", purpose: "Check", platforms: ["android"], entry: "home", account: "lane", requires: [], requirements: [], fixtures: [],
      steps: [{id: "check", instruction: "Check", expected: "Checked"}], execution: {resourceKinds: ["app"]}, source: {repository: "Mentra-Community/Mentra-Automated-Testing", revision, path: `routines/${selected.routineId}/routine.ts`}}});
  const service = new RoutineDispatchService({async current() {return [definition()];}, async getCurrent(id, platform) {return id === selected.routineId && platform === selected.platform ? definition() : null;}},
    {async resolve(value, platform) {resolves++; expect(value).toEqual(source); return {source, platform, availability: "available", title: "Candidate", headSha: "c".repeat(40), createdAt: "2026-10-03T11:00:00Z", buildUrl: "https://github.com/Mentra-Community/MentraOS/actions/runs/55",
      archive: {name: "candidate.apk", size: 100, sha256: "d".repeat(64), url: "https://artifactscdn.mentraglass.com/candidate.apk"}, receipt: {size: 10, sha256: "e".repeat(64), url: "https://artifactscdn.mentraglass.com/receipt.json"}};}},
    {async get(hostId) {return {hostId, incarnation: "one", incarnationGeneration: 1, sequence: 1, observedAt: new Date().toISOString(), receivedAt: new Date().toISOString(),
      lanes: [{id: "android-lane", platform: "android", dispatchMode: "automatic", state: "idle", resources: [{id: "app:android", kind: "app"}]}]};}},
    {async get() {return stored;}, async submit(requestId, hostId, input) {stored = {requestId, hostId, input, inputSha256: "f".repeat(64), state: "queued"}; return stored;}},
    {async detail() {throw new TestRunError(404, "not published");}}, () => ({android: {hostId: "mini", laneId: "android-lane"}}));
  return {service, get resolves() {return resolves;}, set revision(value: string) {revision = value;}};
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
  await expect(state.service.submit({...selected, source: {...source, buildRunId: 56}})).rejects.toThrow("changed");
  expect(await state.service.detail(selected.requestId)).toEqual({request, result: null});
});
test("unknown routine/platform and missing explicit platform bindings cannot enter the queue", async () => {
  const state = fixture();
  await expect(state.service.submit({...selected, routineId: "unknown"})).rejects.toThrow("not enrolled");
  const service = new RoutineDispatchService({async current() {return [];}, async getCurrent() {return {} as any;}}, undefined, undefined,
    {async get() {return null;}, async submit() {throw new Error("must not queue");}}, undefined, () => ({}));
  await expect(service.submit(selected)).rejects.toThrow("No configured host/lane binding");
});

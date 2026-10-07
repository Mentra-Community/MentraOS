import {testRoutineSource} from "../../testing/framework-fixtures"
import {expect, test} from "bun:test";
import {createTestDispatchAdminApi, HOST_STATE_FRESHNESS_MS} from "./test-dispatches.api";
import {requestInputDigest, TestRequestService, type StoredRequest} from "../../services/test-request.service";
import {RoutineDispatchService} from "../../services/routine-dispatch.service";
import {routineAdmissionInput} from "../../services/routine-admission.service";
import type {RoutineDefinitionService} from "../../services/routine-definition.service";
import type {TestBuildGateway} from "../../services/test-builds.service";
import type {TestHostStateService} from "../../services/test-host-state.service";
const selection = {requestId: "request-1", hostId: "mini", laneId: "mac", routineId: "no-glasses", platform: "ios-on-mac",
 source: {channel: "dev", buildRunId: 15, publicationAttempt: 1}, archiveSha256: "c".repeat(64)};
const resources = [{id: "mac-app", kind: "app"}, {id: "mac-recorder", kind: "recorder"}];
function fixture(changed = false, offline = false, clockSkew = 0, receiptAge = 0) {
  let admitted: StoredRequest | undefined, revision = "a".repeat(40), resolves = 0;
  const service = {get: async (id: string) => admitted?.requestId === id ? admitted : null, prepare: async (hostId: string, dispatchIntent: any) => {
    admitted = {requestId: dispatchIntent.requestId, hostId, dispatchIntent, dispatchIntentSha256: requestInputDigest(dispatchIntent), state: "preparing"}; return admitted;}, submit: async (requestId: string, hostId: string, input: unknown) => {
   admitted = {requestId,hostId,input,inputSha256:requestInputDigest(input),state:"queued"}; return admitted;}} as unknown as TestRequestService;
  const definitions = {
    getCurrent: async () => {throw new Error("Must not select the old published definition");},
    getExact: async () => ({
      routineId: selection.routineId,
      platform: selection.platform,
      definitionRevision: revision,
      routineSource: testRoutineSource(revision),
      definition: {
        minimumRoutineApiVersion: 1,
        execution: {resourceKinds: ["app", "recorder"], policy: {estimatedOutputBytes: 100}},
      },
    }),
  } as unknown as RoutineDefinitionService
  const builds = {resolve: async (source: unknown, platform: unknown) => {expect(source).toEqual(selection.source); expect(platform).toBe("ios-on-mac"); resolves++;
   return {source: selection.source, headSha: "b".repeat(40), availability: "available", release:"3.3.0-dev.5",receipt: {url: "https://artifactscdn.mentraglass.com/receipt.json", sha256: "e".repeat(64), size: 1773}, archive: {name: "app.zip", url: "https://artifactscdn.mentraglass.com/app.zip", size: 100, sha256: (changed ? "d" : "c").repeat(64)}};}} as unknown as TestBuildGateway;
  const hosts = {get: async () => offline ? null : {hostId: "mini", observedAt:new Date(Date.now()+clockSkew).toISOString(),receivedAt:new Date(Date.now()-receiptAge).toISOString(),lanes:[{id:"mac",platform:"ios-on-mac",dispatchMode:"paused",resources}]}} as unknown as TestHostStateService;
  return {
    app: createTestDispatchAdminApi(service, definitions, builds, hosts, new RoutineDispatchService(definitions, builds, hosts, service, undefined, undefined,
      {async resolve(override) {return override ?? revision;}, async inventory(commit) {return {commit, files: [{path: "routines/no-glasses/routine.ts", gitBlobSha1: "f".repeat(40), size: 10}]};}})),
    input: async () => routineAdmissionInput((await definitions.getExact(selection.routineId, selection.platform, revision, true))!,
      await builds.resolve(selection.source as any, selection.platform as any), {hostId: selection.hostId, laneId: selection.laneId},
      await hosts.get(selection.hostId), Date.now(), {requireAutomatic: false}),
    admitted: () => admitted,
    reEnroll: () => (revision="d".repeat(40)),
    resolves:()=>resolves,
  }
}
const post = (app: ReturnType<typeof createTestDispatchAdminApi>, body: unknown, path="/test-dispatches/picker") => app.request(path,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
test("picker freezes fresh main, selected publication and explicit target before host preparation", async () => {
 const f=fixture();expect((await post(f.app,selection)).status).toBe(202);
 expect(f.admitted()).toMatchObject({requestId:"request-1",hostId:"mini",state:"preparing",dispatchIntent:{routineId:"no-glasses",routineRevision:"a".repeat(40),platform:"ios-on-mac",laneId:"mac",build:{headSha:"b".repeat(40),kind:"mac-ci-package",archive:{sha256:"c".repeat(64)}}}});
 expect(f.admitted()!.input).toBeUndefined();
});
test("changed artifact and unavailable host refuse execution admission", async () => {
 for(const f of [fixture(true),fixture(false,true)]) {expect((await post(f.app,selection)).status).toBe(409);expect(f.admitted()).toBeUndefined();}
});
test("lost admission response keeps original definition after re-enrollment", async () => {
 const f=fixture();expect((await post(f.app,selection)).status).toBe(202);const original=f.admitted();f.reEnroll();
 expect((await post(f.app,selection)).status).toBe(202);expect(f.admitted()).toEqual(original);expect(f.resolves()).toBe(1);
 expect((await post(f.app,{...selection,archiveSha256:"d".repeat(64)})).status).toBe(409);
});
test("direct admission cannot bypass immutable build resolver or host bindings", async () => {
  const f=fixture();
  await post(f.app,selection);
  const original = {input: await f.input()};
  const foreign = {
    ...(original.input as object),
    build:{repository:"Mentra-Community/MentraOS",headSha:"b".repeat(40),channel:"dev",source:selection.source,archive:{sha256:"f".repeat(64)}},
  }
  const fresh=fixture();
  expect((await post(fresh.app,{requestId:"other",hostId:"mini",input:foreign},"/test-dispatches")).status).toBe(409);
  expect(fresh.admitted()).toBeUndefined();
})

test("direct admission preserves an explicit framework floor and its immutable retry digest", async () => {
  const selected = fixture();
  expect((await post(selected.app, selection)).status).toBe(202);
  const input = {...await selected.input(), minimumFrameworkVersion: 123};
  const direct = fixture(), request = {requestId: "framework-floor", hostId: "mini", input};
  expect((await post(direct.app, request, "/test-dispatches")).status).toBe(202);
  expect(direct.admitted()!.input).toEqual(input);
  expect(direct.admitted()!.inputSha256).toBe(requestInputDigest(input));
  expect((await post(direct.app, request, "/test-dispatches")).status).toBe(202);
  expect((await post(direct.app, {...request, input: {...input, minimumFrameworkVersion: 124}}, "/test-dispatches")).status).toBe(409);
  const {minimumFrameworkVersion: _minimum, ...noMinimum} = input;
  expect((await post(direct.app, {...request, input: noMinimum}, "/test-dispatches")).status).toBe(409);
});

test("dispatch freshness uses Core receipt time rather than a skewed controller clock", async () => {
 for (const skew of [-180000, 86400000]) {
  const live=fixture(false,false,skew);expect((await post(live.app,selection)).status).toBe(202);
  const stale=fixture(false,false,skew,HOST_STATE_FRESHNESS_MS+1);expect((await post(stale.app,selection)).status).toBe(409);expect(stale.admitted()).toBeUndefined();
 }
});

function glassesFixture(
  capabilities = ["glasses-ble"],
  startSoftware?: {model: "mentra-live"; manifest: {url: string; sha256: string; size: number}},
) {
  const revision = "a".repeat(40), manifest = {url: "https://artifactscdn.mentraglass.com/exact/manifest.json", sha256: "f".repeat(64), size: 100};
  const selected = {...selection, routineId: "paired-controls"};
  const admitted = new Map<string, StoredRequest>();
  const service = {get: async (id: string) => admitted.get(id) ?? null, prepare: async (hostId: string, dispatchIntent: any) => {
    const row: StoredRequest = {requestId: dispatchIntent.requestId, hostId, dispatchIntent, dispatchIntentSha256: requestInputDigest(dispatchIntent), state: "preparing"}; admitted.set(row.requestId, row); return row;}, submit: async (requestId: string, hostId: string, input: unknown) => {
  const row: StoredRequest = {requestId, hostId, input, inputSha256: requestInputDigest(input), state: "queued"}; admitted.set(requestId, row); return row;}} as unknown as TestRequestService;
  const definitions = {
    getCurrent: async () => {throw new Error("Must not select the old published definition");},
    getExact: async () => ({
      routineId: selected.routineId,
      platform: selected.platform,
      definitionRevision: revision,
      routineSource: testRoutineSource(revision),
      definition: {
        minimumRoutineApiVersion: 1,
        requires: ["glasses-ble"],
        glasses: {models: ["mentra-live"], ...(startSoftware ? {startSoftware} : {})},
        execution: {resourceKinds: ["app", "recorder", "glasses"]},
      },
    }),
  } as unknown as RoutineDefinitionService
  const build = {source: selected.source, platform: "ios-on-mac", headSha: "b".repeat(40), availability: "available", manifest, manifestSha256: manifest.sha256,
  receipt: {url: "https://artifactscdn.mentraglass.com/receipt.json", sha256: "e".repeat(64), size: 100},
  archive: {name: "app.zip", url: "https://artifactscdn.mentraglass.com/app.zip", size: 100, sha256: selected.archiveSha256}};
  const builds = {resolve: async () => build} as unknown as TestBuildGateway;
  const hosts = {get: async () => ({hostId: "mini", receivedAt: new Date().toISOString(), lanes: [{id: "mac", platform: "ios-on-mac", dispatchMode: "paused",
  resources: [...resources, {id: "physical-live", kind: "glasses"}],
  glasses: [{resourceId: "physical-live", deviceId: "live-cid", model: "mentra-live", capabilities}]}]})} as unknown as TestHostStateService;
  return {app: createTestDispatchAdminApi(service, definitions, builds, hosts, new RoutineDispatchService(definitions, builds, hosts, service, undefined, undefined,
    {async resolve(override) {return override ?? revision;}, async inventory(commit) {return {commit, files: []};}})), admitted, selected, manifest,
    input: async () => routineAdmissionInput((await definitions.getExact(selected.routineId, selected.platform, revision, true))!, build as any,
      {hostId: selected.hostId, laneId: selected.laneId}, await hosts.get(selected.hostId), Date.now(), {requireAutomatic: false})};
}

test("Admin picker and direct admission share the frozen glasses manifest on a manually paused lane", async () => {
 const f = glassesFixture();
 expect((await post(f.app, f.selected)).status).toBe(202);
 const input = await f.input() as Record<string, any>;
 expect(input.glassesStart).toEqual({model: "mentra-live", manifest: f.manifest});
 expect(input.glassesReturn).toEqual(input.glassesStart);
 expect(input.build.manifestSha256).toBe(f.manifest.sha256);
 expect((await post(f.app, {requestId: "direct", hostId: "mini", input}, "/test-dispatches")).status).toBe(202);
 expect(f.admitted.get("direct")!.input).toEqual(input);
 expect((await post(f.app, {requestId: "direct", hostId: "mini", input}, "/test-dispatches")).status).toBe(202);
});

test("picker saves immutable intent while direct executable admission checks provider capability", async () => {
 const valid = glassesFixture(); await post(valid.app, valid.selected);
 const input = await valid.input();
 const missing = glassesFixture([]);
 expect((await post(missing.app, missing.selected)).status).toBe(202);
 expect(missing.admitted.get(missing.selected.requestId)!.input).toBeUndefined();
 expect((await post(missing.app, {requestId: "direct", hostId: "mini", input}, "/test-dispatches")).status).toBe(409);
 expect(missing.admitted.size).toBe(1);
});

test("direct Admin admission refuses a coherent alternate manifest that does not match the resolved build", async () => {
 const f = glassesFixture(); await post(f.app, f.selected);
 const original = await f.input() as Record<string, any>;
 const manifest = {...f.manifest, sha256: "d".repeat(64)}, software = {model: "mentra-live", manifest};
 const input = {...original, build: {...original.build, manifest, manifestSha256: manifest.sha256}, glassesStart: software, glassesReturn: software};
 expect((await post(f.app, {requestId: "changed", hostId: "mini", input}, "/test-dispatches")).status).toBe(409);
 expect(f.admitted.has("changed")).toBe(false);
});

test("Admin paths preserve declared alternate start and refuse a forged start before storing requests", async () => {
 const startSoftware = {model: "mentra-live" as const, manifest: {url: "https://artifactscdn.mentraglass.com/reset/manifest.json", sha256: "d".repeat(64), size: 100}};
 const f = glassesFixture(["glasses-ble"], startSoftware);
 expect((await post(f.app, f.selected)).status).toBe(202);
 const input = await f.input() as Record<string, any>;
 expect(input.glassesStart).toEqual(startSoftware);
 expect(input.glassesReturn).toEqual({model: "mentra-live", manifest: f.manifest});
 expect((await post(f.app, {requestId: "declared", hostId: "mini", input}, "/test-dispatches")).status).toBe(202);
 for (const glassesStart of [input.glassesReturn, {...startSoftware, manifest: {...startSoftware.manifest, sha256: "e".repeat(64)}}]) {
  expect((await post(f.app, {requestId: "forged", hostId: "mini", input: {...input, glassesStart}}, "/test-dispatches")).status).toBe(409);
  expect(f.admitted.has("forged")).toBe(false);
 }
});

test("picker inventory uses source IDs and fresh main without a published-definition gate", async () => {
  const f = fixture(), response = await f.app.request("/test-routines");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({routineRevision: "a".repeat(40), routines: [{routineId: "no-glasses"}]});
  const exact = await f.app.request(`/test-routines?revision=${"f".repeat(40)}`);
  expect((await exact.json() as {routineRevision:string}).routineRevision).toBe("f".repeat(40));
});

test("picker optional exact revision and independent framework floor survive immutable retries", async () => {
  const f = fixture(), request = {...selection, routineRevision: "f".repeat(40), minimumFrameworkVersion: 123};
  expect((await post(f.app, request)).status).toBe(202);
  expect(f.admitted()).toMatchObject({state: "preparing", dispatchIntent: {routineRevision: request.routineRevision, minimumFrameworkVersion: 123}});
  f.reEnroll();
  expect((await post(f.app, request)).status).toBe(202);
  expect(f.resolves()).toBe(1);
  for (const changed of [{...request, routineRevision: "e".repeat(40)}, {...request, minimumFrameworkVersion: 124},
    {...request, laneId: "other"}, {...request, hostId: "other"}])
    expect((await post(f.app, changed)).status).toBe(409);
  expect((await post(fixture().app, {...selection, routineRevision: "main"})).status).toBe(400);
});

test("picker retries require its saved intent digest and never read a fabricated executable input", async () => {
  const f = fixture(); expect((await post(f.app, selection)).status).toBe(202);
  const saved = f.admitted()!;
  expect(saved.input).toBeUndefined();
  saved.dispatchIntentSha256 = "f".repeat(64);
  expect((await post(f.app, selection)).status).toBe(503);
});

import {expect, test} from "bun:test";
import {createTestDispatchAdminApi, HOST_STATE_FRESHNESS_MS} from "./test-dispatches.api";
import {TestRequestService, type StoredTestRequest} from "../../services/test-request.service";
import type {RoutineDefinitionService} from "../../services/routine-definition.service";
import type {TestBuildGateway} from "../../services/test-builds.service";
import type {TestHostStateService} from "../../services/test-host-state.service";
const selection = {requestId: "request-1", hostId: "mini", laneId: "mac", routineId: "no-glasses", platform: "ios-on-mac",
 source: {channel: "dev", buildRunId: 15, publicationAttempt: 1}, archiveSha256: "c".repeat(64)};
const resources = [{id: "mac-app", kind: "app"}, {id: "mac-recorder", kind: "recorder"}];
function fixture(changed = false, offline = false, clockSkew = 0, receiptAge = 0) {
 let admitted: StoredTestRequest | undefined, revision = "a".repeat(40), resolves = 0;
 const service = {get: async () => admitted ?? null, submit: async (requestId: string, hostId: string, input: unknown) => {
   admitted = {requestId,hostId,input,inputSha256:"test",state:"queued"}; return admitted;}} as unknown as TestRequestService;
 const definitions = {getCurrent: async () => ({definitionRevision: revision, definition: {execution: {resourceKinds: ["app", "recorder"], policy: {estimatedOutputBytes: 100}}}})} as unknown as RoutineDefinitionService;
 const builds = {resolve: async (source: unknown, platform: unknown) => {expect(source).toEqual(selection.source); expect(platform).toBe("ios-on-mac"); resolves++;
   return {source: selection.source, headSha: "b".repeat(40), availability: "available", release:"3.3.0-dev.5",receipt: {url: "https://artifactscdn.mentraglass.com/receipt.json", sha256: "e".repeat(64), size: 1773}, archive: {name: "app.zip", url: "https://artifactscdn.mentraglass.com/app.zip", size: 100, sha256: (changed ? "d" : "c").repeat(64)}};}} as unknown as TestBuildGateway;
 const hosts = {get: async () => offline ? null : {observedAt:new Date(Date.now()+clockSkew).toISOString(),receivedAt:new Date(Date.now()-receiptAge).toISOString(),lanes:[{id:"mac",platform:"ios-on-mac",resources}]}} as unknown as TestHostStateService;
 return {app: createTestDispatchAdminApi(service, definitions, builds, hosts), admitted: () => admitted, reEnroll:()=>revision="d".repeat(40), resolves:()=>resolves};
}
const post = (app: ReturnType<typeof createTestDispatchAdminApi>, body: unknown, path="/test-dispatches/picker") => app.request(path,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
test("picker freezes selected publication and source-defined host inputs", async () => {
 const f=fixture();expect((await post(f.app,selection)).status).toBe(202);
 expect(f.admitted()).toMatchObject({requestId:"request-1",hostId:"mini",input:{routineId:"no-glasses",definitionRevision:"a".repeat(40),platform:"ios-on-mac",laneId:"mac",resources,policy:{estimatedOutputBytes:100},build:{headSha:"b".repeat(40),kind:"mac-ci-package",archive:{sha256:"c".repeat(64)}}}});
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
 const f=fixture();await post(f.app,selection);const original=f.admitted()!;
 const foreign={...original.input as object,build:{repository:"Mentra-Community/MentraOS",headSha:"b".repeat(40),channel:"dev",source:selection.source,archive:{sha256:"f".repeat(64)}}};
 const fresh=fixture();expect((await post(fresh.app,{requestId:"other",hostId:"mini",input:foreign},"/test-dispatches")).status).toBe(409);expect(fresh.admitted()).toBeUndefined();
});

test("dispatch freshness uses Core receipt time rather than a skewed controller clock", async () => {
 for (const skew of [-180000, 86400000]) {
  const live=fixture(false,false,skew);expect((await post(live.app,selection)).status).toBe(202);
  const stale=fixture(false,false,skew,HOST_STATE_FRESHNESS_MS+1);expect((await post(stale.app,selection)).status).toBe(409);expect(stale.admitted()).toBeUndefined();
 }
});

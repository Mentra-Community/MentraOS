import {expect, test} from "bun:test";
import {createTestDispatchAdminApi} from "./test-dispatches.api";
import type {TestRequestService} from "../../services/test-request.service";
import type {RoutineDefinitionService} from "../../services/routine-definition.service";
import type {TestBuildGateway} from "../../services/test-builds.service";
const selection = {requestId: "request-1", hostId: "mini", laneId: "mac", routineId: "notes-phone", platform: "ios-on-mac",
 source: {channel: "dev", buildRunId: 15, publicationAttempt: 1}, archiveSha256: "c".repeat(64)};
function fixture(changed = false) {
 let admitted: unknown;
 const service = {submit: async (requestId: string, hostId: string, input: unknown) => {admitted = {requestId, hostId, input}; return {requestId, state: "queued"};}} as unknown as TestRequestService;
 const definitions = {getCurrent: async () => ({definitionRevision: "a".repeat(40)})} as unknown as RoutineDefinitionService;
 const builds = {resolve: async () => ({source: selection.source, headSha: "b".repeat(40), availability: "available", receipt: {url: "https://artifactscdn.mentraglass.com/receipt.json", sha256: "e".repeat(64), size: 1773}, archive: {name: "app.zip", url: "https://artifactscdn.mentraglass.com/app.zip", size: 100, sha256: (changed ? "d" : "c").repeat(64)}})} as unknown as TestBuildGateway;
 return {app: createTestDispatchAdminApi(service, definitions, builds), admitted: () => admitted};
}
test("picker queues a verified build through the native request service", async () => {
 const f = fixture(); const result = await f.app.request("/test-dispatches/picker", {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify(selection)});
 expect(result.status).toBe(202);
 expect(f.admitted()).toMatchObject({requestId: "request-1", hostId: "mini", input: {routineId: "notes-phone", definitionRevision: "a".repeat(40), laneId: "mac", build: {headSha: "b".repeat(40), kind: "mac-ci-package", archive: {sha256: "c".repeat(64)}, receipt: {size: 1773}}}});
});
test("changed artifact refuses admission instead of silently testing a different build", async () => {
 const f = fixture(true); const result = await f.app.request("/test-dispatches/picker", {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify(selection)});
 expect(result.status).toBe(409); expect(f.admitted()).toBeUndefined();
});

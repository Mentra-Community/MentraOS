import {expect, test} from "bun:test";
import {createFrameworkResultsApi} from "./framework-results.api";
import {FrameworkResultConflict, FrameworkResultService} from "../../services/framework-result.service";
import type {FrameworkRun} from "../../types/framework-run.types";
import type {RoutineEnrollment} from "../../types/routine-definition.types";
import {requestInputDigest} from "../../services/test-request.service";
import {FRAMEWORK_JSON_BYTES} from "./framework-json";

test('host recording reader preserves byte-range requests and refuses foreign accepted requests', async () => {
  const calls: unknown[] = []
  class Service extends FrameworkResultService {
    override async detailForHost(requestId: string, hostId: string): Promise<any> {
      calls.push({requestId, hostId})
      if (requestId !== 'owned') throw new FrameworkResultConflict('foreign result')
      return {run: {requestId, definitionRevision: 'a'.repeat(40)}, verification: {workId: 'work:one', attemptId: 1, sourceRevision: 'a'.repeat(40)}}
    }
    override async mediaForHost(requestId: string, assetId: string, hostId: string, request: Request) {
      calls.push({requestId, assetId, hostId, method: request.method, range: request.headers.get('range')})
      return new Response(null, {status: 206, headers: {'Content-Range': 'bytes 1-2/100', ETag: '"frozen-hash"'}})
    }
  }
  const token = 'host-owned-reader-' + 'x'.repeat(32)
  const api = createFrameworkResultsApi(new Service(), () => JSON.stringify({mini: token}))
  expect((await api.request('/owned')).status).toBe(401)
  const headers = {authorization: `Bearer ${token}`, range: 'bytes=1-2'}
  expect((await api.request('/owned', {headers})).status).toBe(200)
  expect((await api.request('/foreign', {headers})).status).toBe(409)
  const response = await api.request('/owned/assets/recording', {method: 'HEAD', headers})
  expect(response.status).toBe(206)
  expect(response.headers.get('etag')).toBe('"frozen-hash"')
  expect(response.headers.get('content-range')).toBe('bytes 1-2/100')
  expect(calls.at(-1)).toEqual({requestId: 'owned', assetId: 'recording', hostId: 'mini', method: 'HEAD', range: 'bytes=1-2'})
})

test("result routes derive host identity and refuse incomplete final acknowledgement", async () => {
  const calls: unknown[] = [];
  class Service extends FrameworkResultService {
    override async ingest(input: unknown, host: string) {
      calls.push({input, host});
      return {entityId: "r1", payloadSha256: "digest", created: true};
    }
    override async complete(requestId: string, host: string): Promise<never> {calls.push({requestId, host}); throw new FrameworkResultConflict("uploads incomplete");}
    override async upload(requestId: string, assetId: string, hostId: string): Promise<any> {
      calls.push({requestId, assetId, hostId}); return {uploaded: true};
    }
  }
  const token = "synthetic-controller-credential-" + "x".repeat(32);
  const api = createFrameworkResultsApi(new Service(), () => JSON.stringify({mini: token}));
  const headers = {authorization: `Bearer ${token}`, "content-type": "application/json"};
  const response = await api.request("/", {method: "POST", headers, body: JSON.stringify({hostId: "other"})});
  expect(response.status).toBe(200);
  expect(calls).toEqual([{input: {hostId: "other"}, host: "mini"}]);
  expect((await api.request("/r1/complete", {method: "POST", headers})).status).toBe(409);
  expect(calls.at(-1)).toEqual({requestId: "r1", host: "mini"});
  expect((await api.request("/r1/assets/video", {method: "PUT", headers, body: "bytes"})).status).toBe(200);
  expect(calls.at(-1)).toEqual({requestId: "r1", assetId: "video", hostId: "mini"});
  const nested = "setup-evidence/commands/result.json";
  expect((await api.request(`/r1/assets/${encodeURIComponent(nested)}`, {method: "PUT", headers, body: "bytes"})).status).toBe(200);
  expect(calls.at(-1)).toEqual({requestId: "r1", assetId: nested, hostId: "mini"});
  expect((await api.request("/", {method: "POST", headers, body: "{"})).status).toBe(400);
});

test("a 2437-asset frozen result publishes unchanged through the authenticated route and retains its failed verdict", async () => {
  const assets: FrameworkRun["assets"] = Array.from({length: 2437}, (_, index) => ({id: index ? `setup-${String(index).padStart(64, "a")}` : "recording",
    kind: index ? "report" as const : "recording" as const, path: index ? `setup-evidence/commands/${String(index).padStart(64, "b")}.json` : "routine.mp4",
    sha256: "c".repeat(64), size: index ? 100 : 46859392, mimeType: index ? "application/json" : "video/mp4"}));
  const run = {schemaVersion: 1, requestId: "original-ota", hostId: "mini", routineId: "ota-roundtrip-android",
    definitionRevision: "a".repeat(40), platform: "android", laneId: "mini-android",
    build: {repository: "Mentra-Community/MentraOS", headSha: "b".repeat(40), channel: "dev"},
    startedAt: "2026-10-05T15:12:49.686Z", finishedAt: "2026-10-05T15:38:30.929Z", recordingAssetId: "recording", assets,
    result: {runId: "original-ota", finishedAt: "2026-10-05T15:38:30.929Z", setup: {status: "passed"}, test: "failed",
      steps: [{id: "OTA-04-requested", status: "failed", durationMs: 347211}],
      teardown: {ready: true, outcomes: [], errors: [], unavailableResources: []},
      failures: [{phase: "test", actionId: "OTA-04-requested", message: "offer did not arrive within 90000 ms; no update was repeated"}],
      evidence: assets.map(asset => asset.id), timing: {startedAt: "2026-10-05T15:12:49.686Z", setupMs: 0, testMs: 347211, teardownMs: 1000}}};
  let stored: {payload: FrameworkRun; payloadSha256: string; uploadsComplete: boolean} | null = null;
  const service = new FrameworkResultService({async insert(payload, payloadSha256) {
    if (stored) throw Object.assign(new Error("duplicate"), {code: 11000});
    stored = {payload, payloadSha256, uploadsComplete: false};
  }, async getByRequest() {return stored;}, async getByRun() {return stored;}, async getAsset(_identity, assetId) {
    return stored ? {runId: stored.payload.result.runId, asset: stored.payload.assets.find(asset => asset.id === assetId) ?? null} : null;
  }},
  async () => ({hostId: "mini", input: {routineId: run.routineId, definitionRevision: run.definitionRevision,
    platform: run.platform, laneId: run.laneId, build: run.build}}), async () => {},
  async () => ({definition: {steps: [{id: "OTA-04-requested"}]}} as unknown as RoutineEnrollment), undefined,
  {async list() {return [];}, async complete() {throw Error("Incomplete uploads cannot be acknowledged");}});
  const token = "synthetic-controller-credential-" + "x".repeat(32);
  const api = createFrameworkResultsApi(service, () => JSON.stringify({mini: token}));
  const headers = {authorization: `Bearer ${token}`, "content-type": "application/json"};
  const body = JSON.stringify(run);
  expect(Buffer.byteLength(body)).toBeLessThan(FRAMEWORK_JSON_BYTES);
  const post = () => api.request("/", {method: "POST", headers, body});
  const first = await post();
  expect(first.status).toBe(200);
  const receipt = {entityId: run.requestId, payloadSha256: requestInputDigest(run), created: true};
  expect(await first.json()).toEqual(receipt);
  expect(stored!.payload.assets).toEqual(assets);
  expect(stored!.payload.result.evidence).toEqual(run.result.evidence);
  expect((await service.detail(run.requestId)).outcome).toBe("failed");
  expect(await (await post()).json()).toEqual({...receipt, created: false});
  expect((await api.request(`/${run.requestId}/complete`, {method: "POST", headers})).status).toBe(409);
  stored!.uploadsComplete = true; // Simulate acknowledged immutable asset uploads, never a result rewrite.
  expect(await (await api.request(`/${run.requestId}/complete`, {method: "POST", headers})).json()).toEqual({entityId: run.requestId,
    payloadSha256: receipt.payloadSha256, manifestSha256: requestInputDigest(assets)});
  expect((await api.request("/", {method: "POST", headers, body: JSON.stringify({...run,
    assets: [...assets.slice(0, -1), {...assets.at(-1)!, sha256: "d".repeat(64)}]})})).status).toBe(409);
  expect((await api.request("/", {method: "POST", headers, body: body.slice(0, -1) + `,"notes":"${"x".repeat(FRAMEWORK_JSON_BYTES)}"}`})).status).toBe(413);
});

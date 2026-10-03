import {expect, test} from "bun:test";
import {createFrameworkResultsApi} from "./framework-results.api";
import {FrameworkResultConflict, FrameworkResultService} from "../../services/framework-result.service";

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
  expect((await api.request("/", {method: "POST", headers, body: "{"})).status).toBe(400);
});

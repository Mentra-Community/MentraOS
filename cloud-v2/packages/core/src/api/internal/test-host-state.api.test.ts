import {expect, test} from "bun:test";
import {createTestHostStateApi} from "./test-host-state.api";
import {hostStateSchema, TestHostStateService} from "../../services/test-host-state.service";
import {TestRunError} from "../../services/test-result-error";
const token = "synthetic-host-test-" + "x".repeat(32);
const snapshot = {hostId: "mini", incarnation: "boot-1", incarnationGeneration: 1, sequence: 1, observedAt: "2026-10-02T18:00:00Z",
  lanes: [{id: "mac", platform: "ios-on-mac", dispatchMode: "automatic", state: "idle",
    resources: [{id: "mac-app", kind: "app"}, {id: "mac-recorder", kind: "recorder"}]}]};
const headers = {authorization: `Bearer ${token}`, "content-type": "application/json"};
test("capability reports are bound to the authenticated host and retain exact lane resources", async () => {
  let observed: unknown;
  class Service extends TestHostStateService {
    override async report(input: unknown, host: string) {
      const value = hostStateSchema.parse(input);
      if (value.hostId !== host) throw new TestRunError(409, "Wrong host");
      observed = value; return {hostId: host, incarnation: value.incarnation, incarnationGeneration: value.incarnationGeneration, sequence: value.sequence};
    }
  }
  const api = createTestHostStateApi(new Service(), () => JSON.stringify({mini: token}));
  expect((await api.request("/", {method:"POST", headers, body:JSON.stringify(snapshot)})).status).toBe(200);
  expect(observed).toEqual(snapshot);
  expect((await api.request("/", {method:"POST", headers, body:JSON.stringify({...snapshot, hostId:"other"})})).status).toBe(409);
  expect((await api.request("/", {method:"POST", headers, body:JSON.stringify({...snapshot, lanes:[{...snapshot.lanes[0], resources:[{id:"invented", kind:"unknown"}]}]})})).status).toBe(400);
  expect((await api.request("/", {method:"POST", headers:{...headers, authorization:"Bearer wrong"}, body:JSON.stringify(snapshot)})).status).toBe(401);
});

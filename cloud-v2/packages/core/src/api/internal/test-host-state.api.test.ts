import {expect, test} from "bun:test";
import {createTestHostStateApi} from "./test-host-state.api";
import {hostStateSchema, updaterDeploymentSchema, TestHostStateService} from "../../services/test-host-state.service"
import {TestRunError} from "../../services/test-result-error";
const token = "synthetic-host-test-" + "x".repeat(32);
const snapshot = {hostId: "mini", incarnation: "boot-1", incarnationGeneration: 1, sequence: 1, observedAt: "2026-10-02T18:00:00Z",
  lanes: [{id: "mac", platform: "ios-on-mac", dispatchMode: "automatic", state: "idle",
    resources: [{id: "mac-app", kind: "app"}, {id: "mac-recorder", kind: "recorder"}]}]};
const headers = {"authorization": `Bearer ${token}`, "content-type": "application/json"}
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
test("independent updater endpoint retains same-host authentication and rejects assertions of current binding", async () => {
  let observed: unknown;
  class Service extends TestHostStateService {
    override async reportDeployment(input: unknown, host: string) {
      const value = updaterDeploymentSchema.parse(input)
      if (value.hostId !== host) throw new TestRunError(409, "Wrong host");
      observed = value;
      return {hostId: host, generation: value.generation, sequence: value.sequence}
    }
  }
  const api = createTestHostStateApi(new Service(), () => JSON.stringify({mini: token}));
  const body = {
    hostId: "mini",
    producer: "framework-updater",
    generation: 1,
    sequence: 1,
    deployment: {
      phase: "failed",
      observedAt: snapshot.observedAt,
      consumers: [],
      reason: "Incomplete staged source",
      nextAction: "Retry changed publication",
    },
  }
  expect((await api.request("/deployment", {method:"POST", headers, body: JSON.stringify(body)})).status).toBe(200)
  expect(observed).toEqual(body)
  expect(
    (await api.request("/deployment", {method:"POST", headers, body: JSON.stringify({...body, hostId: "foreign"})}))
      .status,
  ).toBe(409)
  expect(
    (
      await api.request("/deployment", {
        method:"POST",
        headers,
        body: JSON.stringify({...body, frameworkBinding: {version: 2}}),
      })
    ).status,
  ).toBe(400)
  expect(
    (
      await api.request("/deployment", {
        method:"POST",
        headers:{...headers, authorization:"Bearer wrong"},
        body: JSON.stringify(body),
      })
    ).status,
  ).toBe(401)
})

test('authenticated current custody accepts only its exact run identity and owned lane state', async () => {
  let observed: ReturnType<typeof hostStateSchema.parse> | undefined
  class Service extends TestHostStateService {
    override async report(input: unknown, hostId: string) {
      const value = hostStateSchema.parse(input)
      if (value.hostId !== hostId) throw new TestRunError(409, 'Wrong host')
      observed = value
      return {hostId, incarnation: value.incarnation, incarnationGeneration: value.incarnationGeneration, sequence: value.sequence}
    }
  }
  const api = createTestHostStateApi(new Service(), () => JSON.stringify({mini: token}))
  const lane = {...snapshot.lanes[0], state: 'running', activity: {generation: 4,
    owner: {id: 'request:actual', kind: 'run' as const, requestId: 'request:actual'}}}
  const post = (value: unknown) => api.request('/', {method: 'POST', headers, body: JSON.stringify(value)})
  expect((await post({...snapshot, lanes: [lane]})).status).toBe(200)
  expect(observed!.lanes[0].activity).toEqual(lane.activity)
  for (const changed of [
    {...lane, state: 'idle'},
    {...lane, activity: {...lane.activity, owner: {...lane.activity.owner, requestId: 'request:foreign'}}},
    {...lane, activity: {...lane.activity, owner: {...lane.activity.owner, kind: 'authoring'}}},
    {...lane, activity: {...lane.activity, owner: {...lane.activity.owner, privateInput: 'must-not-leak'}}},
  ]) expect((await post({...snapshot, lanes: [changed]})).status).toBe(400)
})

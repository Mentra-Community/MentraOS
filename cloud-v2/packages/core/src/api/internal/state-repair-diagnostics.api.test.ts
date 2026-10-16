import {expect, test} from "bun:test";
import {createStateRepairDiagnosticsApi} from "./state-repair-diagnostics.api";
import {StateRepairDiagnosticsService} from "../../services/state-repair-diagnostics.service";
import {TestRunError} from "../../services/test-result-error";

test("diagnostics are host authenticated, bounded, and return explicit publication failure", async () => {
  let observed: unknown;
  class Service extends StateRepairDiagnosticsService {
    override async publish(host: string, interruption: string, body: unknown): Promise<any> {
      observed = {host, interruption, body};
      if ((body as {fail?: boolean})?.fail) throw new TestRunError(409, "Attachment identity changed");
      return {hostId: host, interruptionId: interruption, artifactId: "art_TEST"};
    }
  }
  const token = "test-host-" + "x".repeat(40), headers = {authorization: `Bearer ${token}`, "content-type": "application/json"};
  const app = createStateRepairDiagnosticsApi(new Service(), () => JSON.stringify({mini: token}));
  expect((await app.request("/repair:1/diagnostics", {method: "POST", headers, body: '{"key":"one"}'})).status).toBe(200);
  expect(observed).toEqual({host: "mini", interruption: "repair:1", body: {key: "one"}});
  expect((await app.request("/repair:1/diagnostics", {method: "POST", body: "{}"})).status).toBe(401);
  expect((await app.request("/repair:1/diagnostics", {method: "POST", headers, body: "invalid"})).status).toBe(400);
  expect((await app.request("/repair:1/diagnostics", {method: "POST", headers, body: '{"fail":true}'})).status).toBe(409);
  expect((await app.request("/repair:1/diagnostics", {method: "POST", headers: {...headers, "content-length": String(12 * 1024 * 1024)}, body: "{}"})).status).toBe(413);
});

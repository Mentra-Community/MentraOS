import {expect, test} from "bun:test";
import {createTestRequestsApi} from "./test-requests.api";
import {TestRequestConflict, TestRequestService, type HostAcceptance} from "../../services/test-request.service";

const token = "synthetic-controller-credential-" + "x".repeat(32);
const headers = {authorization: `Bearer ${token}`, "content-type": "application/json"};
const digest = "a".repeat(64);

test("delivery scopes queue and acceptance to authenticated controller", async () => {
  const calls: unknown[] = [];
  class Service extends TestRequestService {
    override async queued(host: string, cursor: string | undefined, limit: number) {
      calls.push({host, cursor, limit});
      return {requests: [], preparations: [], dispatchCompletions: [], nextCursor: null};
    }
    override async accept(receipt: HostAcceptance, host: string) {
      if (receipt.hostId !== host) throw new TestRequestConflict("wrong host");
      return {requestId: receipt.requestId, hostId: host, inputSha256: digest,
        input: {}, state: "accepted" as const, hostReceipt: receipt};
    }
  }
  const api = createTestRequestsApi(new Service(), () => JSON.stringify({mini: token}));
  expect((await api.request("/?hostId=other&limit=2", {headers})).status).toBe(200);
  expect(calls).toEqual([{host: "mini", cursor: undefined, limit: 2}]);
  const receipt = {requestId: "r1", inputSha256: digest, hostId: "mini", acceptedAt: "2026-10-02T19:00:00Z"};
  const response = await api.request("/r1/accept", {method: "POST", headers, body: JSON.stringify(receipt)});
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({receipt});
  expect((await api.request("/r1/accept", {method: "POST", headers,
    body: JSON.stringify({...receipt, hostId: "other"})})).status).toBe(409);
  expect((await api.request("/r2/accept", {method: "POST", headers,
    body: JSON.stringify(receipt)})).status).toBe(400);
});

test("malformed acceptance and storage outage cannot acknowledge execution", async () => {
  class Service extends TestRequestService {
    override async queued(): Promise<never> {throw new Error("database unavailable");}
  }
  const api = createTestRequestsApi(new Service(), () => JSON.stringify({mini: token}));
  const response = await api.request("/", {headers});
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({error: "request_delivery_unavailable"});
  expect((await api.request("/r1/accept", {method: "POST", headers, body: "{"})).status).toBe(400);
  expect((await api.request("/r1/accept", {method: "POST", headers, body: "[]"})).status).toBe(400);
});

test("host rejection returns the immutable receipt and refuses foreign or malformed delivery identity", async () => {
  const rejection = {requestId: "r1", hostId: "mini", inputSha256: digest, rejectedAt: "2026-10-03T11:00:00Z",
    code: "missing-definition", reason: "The requested revision is not installed."};
  class Service extends TestRequestService {
    override async reject(input: unknown, host: string) {
      const receipt = input as typeof rejection;
      if (receipt.hostId !== host) throw new TestRequestConflict("wrong host");
      return {requestId: receipt.requestId, hostId: host, inputSha256: digest, input: {}, state: "terminal" as const,
        terminalStatus: "not-run", hostRejection: receipt};
    }
  }
  const api = createTestRequestsApi(new Service(), () => JSON.stringify({mini: token}));
  const response = await api.request("/r1/reject", {method: "POST", headers, body: JSON.stringify(rejection)});
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({rejection});
  expect((await api.request("/r2/reject", {method: "POST", headers, body: JSON.stringify(rejection)})).status).toBe(400);
  expect((await api.request("/r1/reject", {method: "POST", headers, body: JSON.stringify({...rejection, hostId: "other"})})).status).toBe(409);
  expect((await api.request("/r1/reject", {method: "POST", headers, body: JSON.stringify({...rejection, status: "pass"})})).status).toBe(400);
  expect((await api.request("/r1/reject", {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify(rejection)})).status).toBe(401);
});

test("cancellation delivery scopes the host and acknowledges the exact cooperative intent", async () => {
  const cancellation = {requestId: "r1", hostId: "mini", inputSha256: digest, requestedAt: "2026-10-03T14:00:00Z", reason: "Occurrence boundary"};
  class Service extends TestRequestService {
    override async cancellations(host: string) {
      expect(host).toBe("mini");
      return {requests: [{requestId: "r1", hostId: host, inputSha256: digest, input: {}, state: "terminal" as const,
        terminalStatus: "cancelled", hostCancellation: cancellation}], nextCursor: null};
    }
    override async acknowledgeCancellation(input: unknown, host: string) {
      if ((input as typeof cancellation).hostId !== host) throw new TestRequestConflict("wrong host");
      return {requestId: "r1", hostId: host, inputSha256: digest, input: {}, state: "accepted" as const, hostCancellation: cancellation};
    }
  }
  const api = createTestRequestsApi(new Service(), () => JSON.stringify({mini: token}));
  expect((await api.request("/cancellations?hostId=other", {headers})).status).toBe(200);
  const response = await api.request("/r1/cancel-ack", {method: "POST", headers, body: JSON.stringify(cancellation)});
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({cancellation});
  expect((await api.request("/r2/cancel-ack", {method: "POST", headers, body: JSON.stringify(cancellation)})).status).toBe(400);
  expect((await api.request("/r1/cancel-ack", {method: "POST", headers, body: JSON.stringify({...cancellation, hostId: "other"})})).status).toBe(409);
});

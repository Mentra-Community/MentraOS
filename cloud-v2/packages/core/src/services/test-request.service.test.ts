import {expect, test} from "bun:test";
import {createHash} from "node:crypto";
import {requestInputDigest, TestRequestService, type HostAcceptance, type HostRejection, type StoredTestRequest, type TestRequestRepository} from "./test-request.service";

const build = {repository: "Mentra-Community/MentraOS", channel: "dev", headSha: "b".repeat(40)};
function inputFor(routineId = "notes") {return {routineId, definitionRevision: "a".repeat(40), platform: "android", laneId: "android", resources: [], build};}

function store(): TestRequestRepository {
  const rows = new Map<string, StoredTestRequest>();
  return {
    async queued(hostId, after, limit) {
      return [...rows.values()].filter(row => row.hostId === hostId && row.state === "queued")
        .sort((a, b) => a.requestId.localeCompare(b.requestId))
        .filter(row => !after || row.requestId > after.requestId).slice(0, limit)
        .map(row => ({...structuredClone(row), createdAt: new Date("2026-10-02T19:00:00Z")}));
    },
    async insert(row) {
      if (rows.has(row.requestId)) throw Object.assign(new Error("duplicate"), {code: 11000});
      rows.set(row.requestId, structuredClone(row));
    },
    async get(id) {return structuredClone(rows.get(id) ?? null);},
    async accept(receipt) {
      const row = rows.get(receipt.requestId);
      if (!row || row.hostReceipt || row.hostRejection || row.inputSha256 !== receipt.inputSha256 || row.hostId !== receipt.hostId) return null;
      if (row.state === "queued") row.state = "accepted";
      else if (row.state !== "terminal" || row.terminalStatus !== "cancelled" || !row.hostCancellation) return null;
      row.hostReceipt = structuredClone(receipt);
      return structuredClone(row);
    },
    async reject(receipt) {
      const row = rows.get(receipt.requestId);
      if (!row || row.state !== "queued" || row.hostReceipt || row.hostRejection
        || row.inputSha256 !== receipt.inputSha256 || row.hostId !== receipt.hostId) return null;
      row.state = "terminal"; row.terminalStatus = "not-run"; row.hostRejection = structuredClone(receipt);
      return structuredClone(row);
    },
    async cancel(receipt) {
      const row = rows.get(receipt.requestId);
      if (!row || row.hostCancellation || row.state === "terminal" || row.hostId !== receipt.hostId || row.inputSha256 !== receipt.inputSha256) return null;
      if (row.state === "queued" && !row.hostReceipt) {row.state = "terminal"; row.terminalStatus = "cancelled";}
      row.hostCancellation = structuredClone(receipt);
      return structuredClone(row);
    },
    async acknowledgeCancellation(receipt) {
      const row = rows.get(receipt.requestId);
      if (!row?.hostCancellation || requestInputDigest(row.hostCancellation) !== requestInputDigest(receipt)) return null;
      row.cancellationAcknowledged = true; return structuredClone(row);
    },
    async cancellations(hostId, after, limit) {
      return [...rows.values()].filter(row => row.hostId === hostId && row.hostCancellation && !row.cancellationAcknowledged)
        .sort((a, b) => a.requestId.localeCompare(b.requestId)).filter(row => !after || row.requestId > after.requestId).slice(0, limit)
        .map(row => ({...structuredClone(row), createdAt: new Date("2026-10-03T11:00:00Z")}));
    },
  };
}

test("duplicate delivery and lost acknowledgement preserve one host acceptance", async () => {
  const service = new TestRequestService(store());
  const input = inputFor("no-glasses");
  const first = await service.submit("request-1", "mini", input);
  expect(await service.submit("request-1", "mini", inputFor("no-glasses"))).toEqual(first);
  const receipt: HostAcceptance = {requestId: first.requestId, inputSha256: first.inputSha256, hostId: "mini", acceptedAt: "2026-10-02T19:00:00Z"};
  const accepted = await service.accept(receipt, "mini");
  expect(accepted.state).toBe("accepted");
  expect(await service.accept(receipt, "mini")).toEqual(accepted);
  await expect(service.accept({...receipt, acceptedAt: "2026-10-02T19:01:00Z"}, "mini")).rejects.toThrow("missing, changed");
  expect(await service.submit("request-1", "mini", input)).toEqual(accepted);
});

test("different input or host cannot borrow an existing request", async () => {
  const service = new TestRequestService(store());
  const row = await service.submit("request-1", "mini", inputFor());
  await expect(service.submit("request-1", "mini", inputFor("captions"))).rejects.toThrow("different inputs or host");
  await expect(service.submit("request-1", "other", inputFor())).rejects.toThrow("different inputs or host");
  const receipt = {requestId: row.requestId, inputSha256: row.inputSha256, hostId: "mini", acceptedAt: "2026-10-02T19:00:00Z"};
  await expect(service.accept(receipt, "other")).rejects.toThrow("authenticated host");
  await expect(service.accept({...receipt, inputSha256: "wrong"}, "mini")).rejects.toThrow("missing, changed");
});

test("concurrent accepts converge on one original receipt", async () => {
  const service = new TestRequestService(store());
  const row = await service.submit("request-1", "mini", inputFor());
  const receipt = {requestId: row.requestId, inputSha256: row.inputSha256, hostId: "mini", acceptedAt: "2026-10-02T19:00:00Z"};
  const results = await Promise.all(Array.from({length: 8}, () => service.accept(receipt, "mini")));
  expect(results.every(result => JSON.stringify(result) === JSON.stringify(results[0]))).toBe(true);
});

test("hash refuses non-JSON values instead of conflating inputs", () => {
  for (const input of [{x: undefined}, {x: Infinity}, new Date(), {x: () => 1}])
    expect(() => requestInputDigest(input)).toThrow("finite JSON");
});

test("host and cloud canonical JSON agree on integer-like object keys", () => {
  const expected = createHash("sha256").update('{"2":"two","10":"ten","a":{"1":true,"b":false}}').digest("hex");
  expect(requestInputDigest({a: {b: false, "1": true}, "10": "ten", "2": "two"})).toBe(expected);
});

test("queue pages preserve equal-time requests and exclude other hosts", async () => {
  const service = new TestRequestService(store());
  for (const id of ["a", "b", "c"]) await service.submit(id, "mini", inputFor());
  await service.submit("d", "other", inputFor());
  const first = await service.queued("mini", undefined, 2);
  expect(first.requests.map(row => row.requestId)).toEqual(["a", "b"]);
  const second = await service.queued("mini", first.nextCursor!, 2);
  expect(second.requests.map(row => row.requestId)).toEqual(["c"]);
  expect(second.nextCursor).toBeNull();
  await expect(service.queued("other", first.nextCursor!, 2)).rejects.toThrow("Invalid host queue cursor");
});

test("local acceptance publishes atomically without creating queued delivery", async () => {
  const repository = store(), service = new TestRequestService(repository), input = inputFor("no-glasses");
  const receipt = {requestId: "local-1", hostId: "mini", inputSha256: requestInputDigest(input), acceptedAt: "2026-10-02T19:00:00Z"};
  const first = await service.registerLocal(input, receipt, "mini");
  expect(first.state).toBe("accepted");
  expect((await service.queued("mini", undefined, 10)).requests).toEqual([]);
  expect(await service.registerLocal(input, receipt, "mini")).toEqual(first);
  await expect(service.registerLocal(input, {...receipt, acceptedAt: "2026-10-02T19:01:00Z"}, "mini")).rejects.toThrow("conflicts");
  await expect(service.registerLocal(input, receipt, "other")).rejects.toThrow("authenticated host");
  await expect(service.registerLocal(inputFor(), receipt, "mini")).rejects.toThrow("immutable input");
});


test("malformed admission is rejected before persistence", async () => {
  const service = new TestRequestService(store());
  for (const input of [null, {}, {...inputFor(), build: null}, {...inputFor(), build: {...build, channel: "pr"}}])
    await expect(service.submit("invalid", "mini", input)).rejects.toMatchObject({status: 400});
  expect((await service.queued("mini", undefined, 10)).requests).toEqual([]);
});

test("host rejection freezes an impossible request without fabricating execution and retries one receipt", async () => {
  const service = new TestRequestService(store()), input = inputFor("newly-discovered");
  const row = await service.submit("rejected", "mini", input);
  const receipt: HostRejection = {requestId: row.requestId, hostId: "mini", inputSha256: row.inputSha256,
    rejectedAt: "2026-10-03T11:00:00Z", code: "missing-definition", reason: "The requested source revision is not installed."};
  const results = await Promise.all(Array.from({length: 4}, () => service.reject(receipt, "mini")));
  expect(results.every(result => JSON.stringify(result) === JSON.stringify(results[0]))).toBe(true);
  expect(results[0]).toMatchObject({state: "terminal", terminalStatus: "not-run", input, hostRejection: receipt});
  expect(results[0]!.hostReceipt).toBeUndefined();
  expect(results[0]!.runId).toBeUndefined();
  expect((await service.queued("mini", undefined, 100)).requests).toEqual([]);
  expect(await service.submit(row.requestId, "mini", input)).toEqual(results[0]);
  for (const changed of [{...receipt, reason: "changed"}, {...receipt, rejectedAt: "2026-10-03T11:01:00Z"}, {...receipt, code: "unsupported-lane"}])
    await expect(service.reject(changed, "mini")).rejects.toThrow("different terminal rejection");
  await expect(service.accept({requestId: row.requestId, hostId: "mini", inputSha256: row.inputSha256,
    acceptedAt: receipt.rejectedAt}, "mini")).rejects.toThrow("has not been accepted");
});

test("rejection refuses another host, changed inputs, accepted requests and malformed receipts", async () => {
  const service = new TestRequestService(store()), row = await service.submit("queued", "mini", inputFor());
  const receipt: HostRejection = {requestId: row.requestId, hostId: "mini", inputSha256: row.inputSha256,
    rejectedAt: "2026-10-03T11:00:00Z", code: "unsupported-lane", reason: "The requested lane is not installed."};
  await expect(service.reject(receipt, "another")).rejects.toThrow("authenticated host");
  await expect(service.reject({...receipt, inputSha256: "c".repeat(64)}, "mini")).rejects.toThrow("original request");
  for (const changed of [{...receipt, reason: ""}, {...receipt, rejectedAt: "invalid"}, {...receipt, arbitrary: true}])
    await expect(service.reject(changed, "mini")).rejects.toThrow("immutable receipt");
  await service.accept({requestId: row.requestId, hostId: "mini", inputSha256: row.inputSha256, acceptedAt: receipt.rejectedAt}, "mini");
  await expect(service.reject(receipt, "mini")).rejects.toThrow("unaccepted queued");
});

test("cancellation removes cloud-queued work atomically and preserves accepted work for cooperative host cancellation", async () => {
  const service = new TestRequestService(store()), requestedAt = "2026-10-03T14:00:00Z";
  const queued = await service.submit("queued-cancel", "mini", inputFor());
  const cancelled = await service.cancel(queued.requestId, requestedAt, "Occurrence boundary");
  expect(cancelled).toMatchObject({state: "terminal", terminalStatus: "cancelled", hostCancellation: {requestedAt}});
  expect(cancelled!.hostReceipt).toBeUndefined();
  expect(await service.accept({requestId: queued.requestId, hostId: "mini", inputSha256: queued.inputSha256,
    acceptedAt: requestedAt}, "mini")).toMatchObject({state: "terminal", terminalStatus: "cancelled"});
  const active = await service.submit("accepted-cancel", "mini", inputFor());
  await service.accept({requestId: active.requestId, hostId: "mini", inputSha256: active.inputSha256, acceptedAt: requestedAt}, "mini");
  const intended = await service.cancel(active.requestId, requestedAt, "Occurrence boundary");
  expect(intended).toMatchObject({state: "accepted", hostCancellation: {requestedAt}});
  expect(intended!.terminalStatus).toBeUndefined();
  expect(await service.cancel(active.requestId, "2026-10-03T14:01:00Z", "later reason")).toEqual(intended);
  const first = await service.cancellations("mini", undefined, 1);
  expect(first.requests[0]!.requestId).toBe(active.requestId);
  expect((await service.cancellations("mini", first.nextCursor!, 1)).requests[0]!.requestId).toBe(queued.requestId);
  await expect(service.acknowledgeCancellation(intended!.hostCancellation, "other")).rejects.toThrow("authenticated host");
  await expect(service.acknowledgeCancellation({...intended!.hostCancellation, reason: "changed"}, "mini")).rejects.toThrow("immutable intent");
  expect(await service.acknowledgeCancellation(intended!.hostCancellation, "mini")).toMatchObject({cancellationAcknowledged: true, state: "accepted"});
  expect((await service.cancellations("mini", undefined, 100)).requests.map(row => row.requestId)).toEqual([queued.requestId]);
});

test("acceptance racing cancellation retains the cancellation for local host reconciliation", async () => {
  for (const acceptFirst of [true, false]) {
    const service = new TestRequestService(store()), row = await service.submit("racing-request", "mini", inputFor());
    const accept = () => service.accept({requestId: row.requestId, hostId: row.hostId, inputSha256: row.inputSha256,
      acceptedAt: "2026-10-03T14:00:00Z"}, "mini");
    const cancel = () => service.cancel(row.requestId, "2026-10-03T14:00:00Z", "Occurrence boundary");
    const outcomes = await Promise.allSettled(acceptFirst ? [accept(), cancel()] : [cancel(), accept()]);
    expect(outcomes).toHaveLength(2);
    const saved = (await service.get(row.requestId))!;
    expect(saved.hostCancellation).toBeDefined();
    expect((await service.cancellations("mini", undefined, 100)).requests[0]!.input).toEqual(row.input);
    expect(saved.state === "accepted" || saved.state === "terminal" && saved.terminalStatus === "cancelled").toBe(true);
  }
});

test("lost acceptance acknowledgement after cancellation retains real result custody without resurrecting work", async () => {
  const service = new TestRequestService(store()), row = await service.submit("lost-acceptance", "mini", inputFor());
  const receipt = {requestId: row.requestId, hostId: "mini", inputSha256: row.inputSha256, acceptedAt: "2026-10-03T11:00:00Z"};
  // The host's local admission committed at acceptedAt; its HTTP receipt arrives after Core's boundary cancellation.
  await service.cancel(row.requestId, "2026-10-03T14:00:00Z", "Occurrence boundary");
  const accepted = await service.accept(receipt, "mini");
  expect(accepted).toMatchObject({state: "terminal", terminalStatus: "cancelled", hostReceipt: receipt});
  expect((await service.queued("mini", undefined, 100)).requests).toEqual([]);
  expect(await service.accept(receipt, "mini")).toEqual(accepted);
  await expect(service.accept({...receipt, acceptedAt: "2026-10-03T11:01:00Z"}, "mini")).rejects.toThrow("missing, changed");
  const {FrameworkResultService} = await import("./framework-result.service");
  let terminal: unknown;
  const results = new FrameworkResultService({async insert() {}, async getByRequest() {return null;}, async getByRun() {return null;}},
    async id => {const request = await service.get(id); return request?.hostReceipt ? {hostId: request.hostId, input: request.input as any} : null;},
    async run => {terminal = run;}, async () => ({definition: {steps: [{id: "check"}]}} as any));
  const run = {schemaVersion: 1, requestId: row.requestId, hostId: row.hostId, routineId: "notes", definitionRevision: "a".repeat(40),
    platform: "android", laneId: "android", build, startedAt: receipt.acceptedAt, finishedAt: "2026-10-03T14:00:01Z", assets: [],
    result: {runId: row.requestId, finishedAt: "2026-10-03T14:00:01Z", setup: {status: "passed"}, test: "cancelled",
      steps: [{id: "check", status: "not-run", durationMs: 0}], teardown: {ready: true, outcomes: [], errors: [], unavailableResources: []},
      failures: [], evidence: [], timing: {startedAt: receipt.acceptedAt, setupMs: 1, testMs: 1, teardownMs: 1}}};
  expect(await results.ingest(run, "mini")).toMatchObject({entityId: row.requestId, created: true});
  expect(terminal).toEqual(run);
  expect((await service.get(row.requestId))!.state).toBe("terminal");
});

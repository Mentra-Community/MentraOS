import {expect, test} from "bun:test";
import {requestInputDigest, TestRequestService, type HostAcceptance, type StoredTestRequest, type TestRequestRepository} from "./test-request.service";

function store(): TestRequestRepository {
  const rows = new Map<string, StoredTestRequest>();
  return {
    async insert(row) {
      if (rows.has(row.requestId)) throw Object.assign(new Error("duplicate"), {code: 11000});
      rows.set(row.requestId, structuredClone(row));
    },
    async get(id) {return structuredClone(rows.get(id) ?? null);},
    async accept(receipt) {
      const row = rows.get(receipt.requestId);
      if (!row || row.state !== "queued" || row.inputSha256 !== receipt.inputSha256 || row.hostId !== receipt.hostId) return null;
      row.state = "accepted"; row.hostReceipt = structuredClone(receipt);
      return structuredClone(row);
    },
  };
}

test("duplicate delivery and lost acknowledgement preserve one host acceptance", async () => {
  const service = new TestRequestService(store());
  const input = {routine: "no-glasses", build: {sha: "fixed"}};
  const first = await service.submit("request-1", "mini", input);
  expect(await service.submit("request-1", "mini", {build: {sha: "fixed"}, routine: "no-glasses"})).toEqual(first);
  const receipt: HostAcceptance = {requestId: first.requestId, inputSha256: first.inputSha256, hostId: "mini", acceptedAt: "2026-10-02T19:00:00Z"};
  const accepted = await service.accept(receipt, "mini");
  expect(accepted.state).toBe("accepted");
  expect(await service.accept({...receipt, acceptedAt: "2026-10-02T19:01:00Z"}, "mini")).toEqual(accepted);
  expect(await service.submit("request-1", "mini", input)).toEqual(accepted);
});

test("different input or host cannot borrow an existing request", async () => {
  const service = new TestRequestService(store());
  const row = await service.submit("request-1", "mini", {routine: "notes"});
  await expect(service.submit("request-1", "mini", {routine: "captions"})).rejects.toThrow("different inputs or host");
  await expect(service.submit("request-1", "other", {routine: "notes"})).rejects.toThrow("different inputs or host");
  const receipt = {requestId: row.requestId, inputSha256: row.inputSha256, hostId: "mini", acceptedAt: "2026-10-02T19:00:00Z"};
  await expect(service.accept(receipt, "other")).rejects.toThrow("authenticated host");
  await expect(service.accept({...receipt, inputSha256: "wrong"}, "mini")).rejects.toThrow("missing, changed");
});

test("concurrent accepts converge on one original receipt", async () => {
  const service = new TestRequestService(store());
  const row = await service.submit("request-1", "mini", {routine: "notes"});
  const receipt = {requestId: row.requestId, inputSha256: row.inputSha256, hostId: "mini", acceptedAt: "2026-10-02T19:00:00Z"};
  const results = await Promise.all(Array.from({length: 8}, () => service.accept(receipt, "mini")));
  expect(results.every(result => JSON.stringify(result) === JSON.stringify(results[0]))).toBe(true);
});

test("hash refuses non-JSON values instead of conflating inputs", () => {
  for (const input of [{x: undefined}, {x: Infinity}, new Date(), {x: () => 1}])
    expect(() => requestInputDigest(input)).toThrow("finite JSON");
});

import {expect, spyOn, test} from "bun:test";
import {TestHostStateModel} from "../models/test-host-state.model";
import {TestHostStateService} from "./test-host-state.service";

function fixture() {
  let row: Record<string, any> | null = null, now = Date.parse("2026-10-03T01:00:00Z"), writes = 0;
  const find = spyOn(TestHostStateModel, "findOne").mockImplementation((() => ({lean: async () => row && {...row}})) as any);
  const update = spyOn(TestHostStateModel, "findOneAndUpdate").mockImplementation(((filter: Record<string, unknown>, change: {$set: Record<string, any>}, options: {upsert: boolean}) => ({lean: async () => {
    if (row && Object.entries(filter).some(([key, value]) => row![key] !== value)) return null;
    if (!row && !options.upsert) return null;
    row = {...row, ...change.$set}; writes++; return {...row};
  }})) as any);
  return {service: new TestHostStateService(() => now), advance: (ms: number) => now += ms,
    writes: () => writes, row: () => row!, stop: () => {find.mockRestore(); update.mockRestore();}};
}
const snapshot = (generation: number, sequence: number, observedAt = "2026-10-03T01:00:00Z", incarnation = `boot-${generation}`) => ({
  hostId: "mini", incarnation, incarnationGeneration: generation, sequence, observedAt,
  lanes: [{id: "mac", platform: "ios-on-mac", dispatchMode: "automatic", state: "idle", resources: []}],
});

test("server receipt freshness is independent of clocks and duplicates cannot extend it", async () => {
 const f = fixture();
 try {
  await f.service.report(snapshot(1, 1, "2026-10-04T01:00:00Z"), "mini");
  const first = (await f.service.get("mini"))!;
  expect(first.receivedAt).toBe("2026-10-03T01:00:00.000Z");
  f.advance(180000);
  await f.service.report(snapshot(1, 1, "2026-10-05T01:00:00Z"), "mini");
  expect((await f.service.get("mini"))!.receivedAt).toBe(first.receivedAt);
  expect(f.writes()).toBe(1);
  await f.service.report(snapshot(1, 2, "2026-10-02T01:00:00Z"), "mini");
  expect((await f.service.get("mini"))!.receivedAt).toBe("2026-10-03T01:03:00.000Z");
 } finally {f.stop();}
});

test("durable generations order restarts and reject delayed unseen old incarnations", async () => {
 const f = fixture();
 try {
  await f.service.report(snapshot(2, 10, "2026-10-04T01:00:00Z"), "mini");
  f.advance(1000);
  await f.service.report(snapshot(3, 1, "2026-10-02T01:00:00Z"), "mini");
  const restarted = (await f.service.get("mini"))!;
  expect(restarted.incarnationGeneration).toBe(3); expect(restarted.sequence).toBe(1);
  f.advance(10000);
  await f.service.report(snapshot(1, 999, "2026-10-06T01:00:00Z", "previously-unseen-old-boot"), "mini");
  expect(await f.service.get("mini")).toEqual(restarted);
  await expect(f.service.report(snapshot(3, 2, "2026-10-03T01:00:00Z", "different-same-generation"), "mini"))
    .rejects.toThrow("another process");
  expect(f.writes()).toBe(2);
 } finally {f.stop();}
});

test("concurrent generation replacement fences the losing snapshot and retry cannot overwrite it", async () => {
 const f = fixture();
 try {
  await f.service.report(snapshot(1, 1), "mini");
  const results = await Promise.allSettled([f.service.report(snapshot(3, 1), "mini"), f.service.report(snapshot(2, 1), "mini")]);
  expect(results.map(item => item.status)).toEqual(["fulfilled", "rejected"]);
  expect((await f.service.get("mini"))!.incarnationGeneration).toBe(3);
  expect((await f.service.report(snapshot(2, 1), "mini")).incarnationGeneration).toBe(3);
  expect(f.writes()).toBe(2);
 } finally {f.stop();}
});

test("host snapshots persist optional strict per-lane exact-definition availability without changing other lanes", async () => {
 const f = fixture();
 try {
  const source = snapshot(1, 1), definitionRevision = "a".repeat(40);
  const availability = {routineId: "arbitrary-product", definitionRevision, available: false, reason: "Selected source is unavailable on this lane."};
  const reported = {...source, lanes: [{...source.lanes[0], routineAvailability: [availability]},
    {...source.lanes[0], id: "other", routineAvailability: [{...availability, available: true, reason: undefined}]}]};
  await f.service.report(reported, "mini");
  expect((await f.service.get("mini"))!.lanes.map(lane => lane.routineAvailability?.[0]?.available)).toEqual([false, true]);
  for (const bad of [{...availability, available: "yes"}, {...availability, definitionRevision: "bad"}, {...availability, unsupported: true}])
    await expect(f.service.report({...source, sequence: 2, lanes: [{...source.lanes[0], routineAvailability: [bad]}]}, "mini")).rejects.toThrow();
  await expect(f.service.report({...source, sequence: 2, lanes: [{...source.lanes[0], routineAvailability: [availability, availability]}]}, "mini")).rejects.toThrow("Duplicate lane");
  expect(f.writes()).toBe(1);
 } finally {f.stop();}
});

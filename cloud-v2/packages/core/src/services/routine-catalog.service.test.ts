import {expect, test} from "bun:test";
import {RoutineCatalogService} from "./routine-catalog.service";
import type {RoutineEnrollment} from "../types/routine-definition.types";

test("catalog asks for each exact current definition and does not invent passing examples", async () => {
  const definitions = [{routineId: "notes", platform: "ios-on-mac", definitionRevision: "new"},
    {routineId: "gallery-sync", platform: "android", definitionRevision: "current"}] as RoutineEnrollment[];
  const queried: string[] = [];
  const service = new RoutineCatalogService({async current() {return definitions;}, async getCurrent() {return null;}}, {
    async history() {return [];},
    async latestPassing(row) {
      queried.push(`${row.routineId}/${row.definitionRevision}`);
      return row.routineId === "notes" ? null : {runId: "gallery-pass", startedAt: "start", finishedAt: "end", recordingAssetId: "video"};
    },
  });
  const catalog = await service.list();
  expect(queried).toEqual(["notes/new", "gallery-sync/current"]);
  expect(catalog[0]!.example).toBeNull();
  expect(catalog[1]!.example?.runId).toBe("gallery-pass");
});

test("history cursor is scoped to routine and platform and retains equal-time runs", async () => {
  const definition = {routineId: "notes", platform: "ios-on-mac", definitionRevision: "new"} as RoutineEnrollment;
  const rows = ["c", "b", "a"].map(runId => ({runId, startedAt: "2026-10-02T19:00:00Z",
    outcome: "failed", uploadsComplete: true, definitionRevision: "old"}));
  const service = new RoutineCatalogService({async current() {return [definition];},
    async getCurrent(id) {return id === "notes" ? definition : null;}}, {
    async latestPassing() {return null;},
    async history(_id, _platform, after, limit) {return rows.filter(row => !after || row.runId < after.runId).slice(0, limit);},
  });
  const first = await service.detail("notes", "ios-on-mac", undefined, 2);
  expect(first.history.map(row => row.runId)).toEqual(["c", "b"]);
  const last = await service.detail("notes", "ios-on-mac", first.nextCursor!, 2);
  expect(last.history.map(row => row.runId)).toEqual(["a"]);
  expect(last.nextCursor).toBeNull();
  await expect(service.detail("notes", "android", first.nextCursor!)).rejects.toThrow("cursor");
  await expect(service.detail("missing", "android")).rejects.toThrow("not enrolled");
});

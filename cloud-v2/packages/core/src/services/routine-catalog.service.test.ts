import {expect, test} from "bun:test";
import {RoutineCatalogService} from "./routine-catalog.service";
import type {RoutineEnrollment} from "../types/routine-definition.types";

test("catalog asks for each exact current definition and does not invent passing examples", async () => {
  const definitions = [{routineId: "notes", platform: "ios-on-mac", definitionRevision: "new"},
    {routineId: "gallery-sync", platform: "android", definitionRevision: "current"}] as RoutineEnrollment[];
  const queried: string[] = [];
  const service = new RoutineCatalogService({async current() {return definitions;}}, {
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

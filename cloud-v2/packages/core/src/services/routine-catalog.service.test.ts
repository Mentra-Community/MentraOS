import {expect, test} from "bun:test";
import {RoutineCatalogService} from "./routine-catalog.service";
import type {RoutineEnrollment} from "../types/routine-definition.types";
import type {CatalogExample, CatalogHistoryRun} from "./routine-catalog.service";

const example: CatalogExample = {runId: "notes-pass", startedAt: "2026-10-02T18:00:00Z",
  finishedAt: "2026-10-02T18:01:00Z", recordingAssetId: "video", definitionRevision: "a".repeat(40),
  build: {repository: "Mentra-Community/MentraOS", channel: "dev", headSha: "b".repeat(40)}};
test("a historical passing example retains catalog membership while new authoring work stays out", async () => {
  const definitions = [{routineId: "notes", platform: "ios-on-mac", definitionRevision: "c".repeat(40)},
    {routineId: "gallery-sync", platform: "android", definitionRevision: "d".repeat(40)}] as RoutineEnrollment[];
  const service = new RoutineCatalogService({async current() {return definitions;}, async getCurrent() {return definitions[0]!;}}, {
    async history() {return [];}, async latestPassing(row) {return row.routineId === "notes" ? example : null;},
  });
  const catalog = await service.list();
  expect(catalog).toHaveLength(1);
  expect(catalog[0]!.routineId).toBe("notes");
  expect(catalog[0]!.definitionRevision).toBe("c".repeat(40));
  expect(catalog[0]!.example).toEqual(example);
  expect((await service.detail("notes", "ios-on-mac")).example?.definitionRevision).toBe("a".repeat(40));
});

test("history pagination preserves equal-time and earlier runs and refuses foreign/malformed cursors", async () => {
  const definition = {routineId: "notes", platform: "ios-on-mac", definitionRevision: "c".repeat(40)} as RoutineEnrollment;
  const rows: CatalogHistoryRun[] = ["c", "b", "a"].map(runId => ({runId, startedAt: "2026-10-02T19:00:00Z",
    outcome: "failed", uploadsComplete: true, evidenceStatus: "complete", definitionRevision: "a".repeat(40)}));
  rows.push({...rows[0]!, runId: "z", startedAt: "2026-10-02T18:00:00Z"});
  const service = new RoutineCatalogService({async current() {return [definition];},
    async getCurrent(id) {return ["notes", "other"].includes(id) ? {...definition, routineId: id} : null;}}, {
    async latestPassing() {return null;},
    async history(_id, _platform, after, limit) {return rows.filter(row => !after
      || Date.parse(row.startedAt) < after.startedAt.getTime()
      || Date.parse(row.startedAt) === after.startedAt.getTime() && row.runId < after.runId).slice(0, limit);},
  });
  const first = await service.detail("notes", "ios-on-mac", undefined, 2);
  expect(first.history.map(row => row.runId)).toEqual(["c", "b"]);
  const last = await service.detail("notes", "ios-on-mac", first.nextCursor!, 2);
  expect(last.history.map(row => row.runId)).toEqual(["a", "z"]);
  expect(last.nextCursor).toBeNull();
  await expect(service.detail("notes", "android", first.nextCursor!)).rejects.toThrow("cursor");
  await expect(service.detail("other", "ios-on-mac", first.nextCursor!)).rejects.toThrow("cursor");
  await expect(service.detail("notes", "ios-on-mac", "not-json")).rejects.toThrow("cursor");
  const invalidDate = Buffer.from(JSON.stringify({routineId: "notes", platform: "ios-on-mac", runId: "b", startedAt: 2026})).toString("base64url");
  await expect(service.detail("notes", "ios-on-mac", invalidDate)).rejects.toThrow("cursor");
  await expect(service.detail("notes", "ios-on-mac", undefined, 0)).rejects.toThrow("history query");
  await expect(service.detail("missing", "android")).rejects.toThrow("not enrolled");
});

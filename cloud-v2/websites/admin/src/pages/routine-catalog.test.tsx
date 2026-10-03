import {expect, test} from "bun:test";
import {renderToStaticMarkup} from "react-dom/server";
import {RoutineCatalogCard, routineHref} from "./routine-catalog";
import {routineEnrollmentSchema} from "../../../../packages/core/src/types/routine-definition.types";

const routine = routineEnrollmentSchema.parse({routineId: "notes-phone", platform: "ios-on-mac", definitionRevision: "c".repeat(40), definitionSha256: "d".repeat(64),
  definition: {id: "notes-phone", title: "Notes", purpose: "Create and find a note", platforms: ["ios-on-mac"], entry: "home", account: "lane", requires: [], requirements: [], fixtures: [],
    steps: [{id: "create", instruction: "Create a note", expected: "Note saved"}], source: {repository: "Mentra-Community/Mentra-Automated-Testing", revision: "c".repeat(40), path: "routines/notes-phone/routine.ts"}}});
test("catalog labels a historical example without claiming the current definition passed", () => {
  const markup = renderToStaticMarkup(<RoutineCatalogCard routine={{...routine, example: {runId: "old-pass", startedAt: "2026-10-02T18:00:00Z", finishedAt: "2026-10-02T18:01:00Z", recordingAssetId: "video", definitionRevision: "a".repeat(40),
    build: {repository: "Mentra-Community/MentraOS", channel: "dev", headSha: "b".repeat(40)}}}} />);
  expect(markup).toContain("Complete passing example available");
  expect(markup).toContain("earlier definition");
  expect(markup).toContain("aaaaaaaa");
  expect(markup).toContain("routine=notes-phone&amp;platform=ios-on-mac");
  expect(routineHref("notes-phone", "ios-on-mac")).toBe("/?routineCatalog=1&routine=notes-phone&platform=ios-on-mac");
});

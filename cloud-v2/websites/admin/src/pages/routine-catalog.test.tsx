import {expect, test} from "bun:test";
import {renderToStaticMarkup} from "react-dom/server";
import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import {FrameworkRunPage, RoutineCatalogCard, frameworkRunHref, routineHref} from "./routine-catalog";
import {readTestRunLink} from "../lib/test-run-links";
import {routineEnrollmentSchema} from "../../../../packages/core/src/types/routine-definition.types";
import {frameworkRunSchema} from "../../../../packages/core/src/types/framework-run.types";

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

test("run keeps every timestamp-linked step beside a bounded recording and stacks on narrow screens", () => {
  const run = frameworkRunSchema.parse({schemaVersion: 1, requestId: "request", hostId: "mini", routineId: "notes-phone",
    definitionRevision: "c".repeat(40), platform: "ios-on-mac", laneId: "mac", build: {repository: "Mentra-Community/MentraOS", channel: "dev", headSha: "b".repeat(40)},
    startedAt: "2026-10-03T19:00:00Z", finishedAt: "2026-10-03T19:02:00Z", recordingAssetId: "recording",
    assets: [{id: "recording", kind: "recording", path: "video.mp4", sha256: "a".repeat(64), size: 100, mimeType: "video/mp4"}],
    result: {runId: "request", finishedAt: "2026-10-03T19:02:00Z", setup: {status: "passed"}, test: "passed",
      steps: Array.from({length: 71}, (_, index) => ({id: `step-${index}`, status: "passed", durationMs: 1000,
        recordingLocation: {assetId: "recording", startOffsetMs: index * 1000}})),
      teardown: {ready: true, outcomes: [], errors: [], unavailableResources: []}, failures: [], evidence: ["recording"],
      timing: {startedAt: "2026-10-03T19:00:00Z", setupMs: 1000, testMs: 71000, teardownMs: 1000}}});
  const client = new QueryClient();
  const render = (uploadsComplete: boolean) => {
    client.setQueryData(["framework-run", "saved-run"], {run, definition: null, outcome: "pass", uploadsComplete, evidenceStatus: "complete"});
    return renderToStaticMarkup(<QueryClientProvider client={client}><FrameworkRunPage runId="saved-run" /></QueryClientProvider>);
  };
  const html = render(true);
  expect(html).toContain("lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]");
  expect(html).toContain("order-2 lg:order-1");
  expect(html).toContain("lg:overflow-y-auto");
  expect(html).toContain("lg:sticky lg:top-[calc(var(--admin-header-height,6rem)+1rem)]");
  expect(html).toContain("object-contain lg:max-h-[calc(100dvh-var(--admin-header-height,6rem)-8rem)]");
  expect(html.match(/Watch this step/g)).toHaveLength(71);
  expect(html).toContain("Started ");
  expect(html).toContain("Setup 1.0 seconds · Test 71.0 seconds · Teardown 1.0 seconds");
  expect(html).toContain("/api/admin/routine-catalog/results/by-run/saved-run/assets/recording");
  const pending = render(false);
  expect(pending).toContain("Evidence upload pending");
  expect(pending).not.toContain("<video");
  expect(pending).not.toContain("lg:overflow-y-auto");
});

test("catalog run links use the result route understood by the Admin shell", () => {
  const href = frameworkRunHref("old-pass");
  expect(href).toBe("/?testRun=old-pass");
  expect(readTestRunLink(new URL(href, "https://admin.mentraglass.com").search)).toEqual({runID: "old-pass"});
  const html = renderToStaticMarkup(<RoutineCatalogCard routine={{...routine, example: null,
    latestAttempt: {runId: "old-pass", startedAt: "2026-10-02T18:00:00Z", outcome: "pass", uploadsComplete: true, evidenceStatus: "complete", definitionRevision: "c".repeat(40)}}} />);
  expect(html).toContain('href="/?testRun=old-pass"');
});

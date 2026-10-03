import {expect, test} from "bun:test";
import {renderToStaticMarkup} from "react-dom/server";
import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import {FrameworkRunPage, FrameworkRunsPage, RoutineCatalogCard, frameworkRunHref, routineHref, matchesStepSearch, recordingOffset} from "./routine-catalog";
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

test("run keeps steps and recording in one equal-height desktop row with evidence below", () => {
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
  const render = (uploadsComplete: boolean, stepId?: string) => {
    client.setQueryData(["framework-run", "saved-run"], {run, definition: null, outcome: "pass", uploadsComplete, evidenceStatus: "complete"});
    return renderToStaticMarkup(<QueryClientProvider client={client}><FrameworkRunPage runId="saved-run" stepId={stepId} /></QueryClientProvider>);
  };
  const html = render(true);
  expect(html).toContain("lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]");
  expect(html.indexOf('aria-label="Run recording"')).toBeLessThan(html.indexOf('aria-label="Execution steps"'));
  expect(html).toContain("order-2 lg:order-1 lg:flex lg:min-h-0 lg:flex-col");
  expect(html).toContain("lg:h-[calc(100dvh-var(--admin-header-height,6rem)-2rem)]");
  expect(html).toContain('role="region" aria-label="Execution details" tabindex="0"');
  expect(html).toContain("lg:overflow-y-auto");
  expect(html).not.toContain("lg:sticky");
  expect(html).toContain("object-contain lg:h-full lg:max-h-none");
  expect(html).toContain('Teardown: ready</p></div></section></div><section');
  expect(html.match(/Watch this step/g)).toHaveLength(71);
  expect(html).toContain("Search steps");
  expect(html).toContain("Watch this step · 01:10");
  const selected = render(true, "step-60");
  expect(selected).toContain('aria-current="step"');
  expect(selected).toContain("border-[#3b7650] bg-[#edf6ef]");
  expect(html).toContain("Tested build: dev");
  expect(html).toContain("https://github.com/Mentra-Community/MentraOS/commit/" + "b".repeat(40));
  expect(html.match(/class="w-7 shrink-0 text-right"/g)).toHaveLength(71);
  expect(html).toContain('class="w-7 shrink-0 text-right">71.</span>');
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

test("step search matches recorded identity and English definition text without changing recording offsets", () => {
  const step = {id: "create", status: "passed" as const, durationMs: 1000, recordingLocation: {assetId: "video", startOffsetMs: 123456}};
  expect(matchesStepSearch(step, routine.definition, "  NOTE SAVED ")).toBe(true);
  expect(matchesStepSearch(step, routine.definition, "create")).toBe(true);
  expect(matchesStepSearch(step, null, "create")).toBe(true);
  expect(matchesStepSearch(step, routine.definition, "login")).toBe(false);
  expect(recordingOffset(step.recordingLocation.startOffsetMs)).toBe("02:03");
  expect(recordingOffset(59999)).toBe("00:59");
});

const historyRun = {kind: "run" as const, runId: "standalone-run", requestId: "standalone-request", hostId: "mini", routineId: "no-glasses", platform: "ios-on-mac", laneId: "mac", startedAt: "2026-10-03T19:00:00Z", finishedAt: "2026-10-03T19:01:00Z", outcome: "pass", evidenceStatus: "complete", uploadsComplete: true, build: {repository: "Mentra-Community/MentraOS", channel: "dev", headSha: "b".repeat(40), release: "dev.577"}};
test("combined history renders chronological suites and standalone runs across loaded pages", () => {
  const client = new QueryClient();
  client.setQueryData(["test-history"], {pages: [
    {entries: [{kind: "suite", suiteId: "nightly-two", channel: "dev", trigger: "nightly", startedAt: "2026-10-03T20:00:00Z", outcome: "running", expectedCount: 2, passed: 1, build: {headSha: "a".repeat(40)}}], nextCursor: "next"},
    {entries: [historyRun], nextCursor: "older"}], pageParams: [undefined, "next"]});
  const html = renderToStaticMarkup(<QueryClientProvider client={client}><FrameworkRunsPage/></QueryClientProvider>);
  expect(html).toContain('href="/?testSuite=nightly-two"');
  expect(html).toContain('href="/?testRun=standalone-run"');
  expect(html.indexOf("nightly-two")).toBeLessThan(html.indexOf("standalone-run"));
  expect(html).toContain("1/2 passed");
  expect(html).toContain("dev.577");
  expect(html).toContain("More history");
  expect(html.match(/standalone-run/g)).toHaveLength(2);
});
test("history distinguishes empty data and cached refresh failures while keeping filtered build links scoped", () => {
  const client = new QueryClient();
  const render = (scope?: Record<string, string>) => renderToStaticMarkup(<QueryClientProvider client={client}><FrameworkRunsPage scope={scope}/></QueryClientProvider>);
  client.setQueryData(["test-history"], {pages: [{entries: [], nextCursor: null}], pageParams: [undefined]});
  expect(render()).toContain("No test suites or routine runs yet");
  client.setQueryData(["test-history"], {pages: [{entries: [historyRun], nextCursor: null}], pageParams: [undefined]});
  client.getQueryCache().find({queryKey: ["test-history"]})!.setState({error: new Error("refresh refused"), status: "error"});
  expect(render()).toContain("History could not refresh: refresh refused");
  expect(render()).toContain("standalone-run");
  const scope = {channel: "dev", headSha: "b".repeat(40), routineId: "no-glasses"};
  client.setQueryData(["framework-runs", new URLSearchParams(scope).toString()], {runs: [historyRun]});
  const scoped = render(scope);
  expect(scoped).toContain("Filtered routine runs");
  expect(scoped).not.toContain("nightly-two");
  expect(scoped).toContain("dev.577");
});

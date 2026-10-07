import {expect, test} from "bun:test";
import {renderToStaticMarkup} from "react-dom/server";
import type {TestHistoryEntry} from "../../../../packages/core/src/types/test-history.types";
import {TestHistoryTable, HistoryStatus} from "./test-history-table";

const suite: TestHistoryEntry = {kind: "suite", suiteId: "private-suite-id", channel: "dev", trigger: "nightly",
  startedAt: "2026-10-07T18:00:00Z", finishedAt: "2026-10-07T18:03:00Z", outcome: "passed",
  expectedCount: 2, passed: 2, rerunCount: 4, failedCount: 0, lanes: [{hostId: "private-host-id", laneId: "android-primary"}],
  build: {headSha: "a".repeat(40), release: "3.3.0-dev.698"}};

test("history is a semantic table with named links, exact lane pairs and accepted suite rerun count", () => {
  const html = renderToStaticMarkup(<TestHistoryTable entries={[suite]} routines={[]}/>);
  expect(html).toContain('<table data-slot="table"');
  for (const heading of ["Started", "Name", "Duration", "Lane", "Tested build", "Status"])
    expect(html).toContain(`>${heading}</th>`);
  expect(html).toContain('scope="col"');
  expect(html).toContain('href="/?testSuite=private-suite-id"');
  expect(html).toContain("Dev nightly suite");
  expect(html).toContain("4 reruns");
  expect(html).toContain('title="4 accepted rerun jobs"');
  expect(html).toContain("hostId=private-host-id&amp;laneId=android-primary");
  expect(html).toContain("3m 00s");
  expect(html).toContain("3.3.0-dev.698");
  const text = html.replace(/<[^>]+>/g, "");
  expect(text).not.toContain(suite.suiteId);
  expect(text).not.toContain("private-host-id");
  expect(html).not.toContain('class="font-semibold underline"');
  expect(html).not.toContain('type="checkbox"');
});

test("history distinguishes failure and pass from neutral cancelled, with textual status", () => {
  expect(renderToStaticMarkup(<HistoryStatus outcome="pass"/>)).toContain("text-[#1a7f37]");
  expect(renderToStaticMarkup(<HistoryStatus outcome="setup-failed"/>)).toContain("text-[#cf222e]");
  const cancelled = renderToStaticMarkup(<HistoryStatus outcome="cancelled"/>);
  expect(cancelled).toContain("Cancelled");
  expect(cancelled).toContain("text-[#656d76]");
  expect(cancelled).not.toContain("text-[#cf222e]");
  expect(cancelled).not.toContain("amber");
});

test("suite without reruns omits the badge and an included rerun links to its authoritative batch", () => {
  expect(renderToStaticMarkup(<TestHistoryTable entries={[{...suite, rerunCount: 0}]} routines={[]}/>)).not.toContain("accepted rerun jobs");
  const run: Extract<TestHistoryEntry, {kind: "run"}> = {kind: "run", runId: "private-run-id", requestId: "request", routineId: "notes-phone",
    hostId: "mini", laneId: "mac", platform: "ios-on-mac", startedAt: suite.startedAt, finishedAt: suite.finishedAt!,
    outcome: "failed", uploadsComplete: true, evidenceStatus: "complete", build: {...suite.build, repository: "Mentra-Community/MentraOS", channel: "dev"},
    rerun: {rerunId: "accepted-rerun", parentSuiteId: suite.suiteId}};
  const html = renderToStaticMarkup(<TestHistoryTable entries={[run]} routines={[]}/>);
  expect(html).toContain('href="/?testRerun=accepted-rerun"');
  expect(html.replace(/<[^>]+>/g, "")).not.toContain(run.runId);
});

test("incomplete suites and unpublished passes remain neutral instead of claiming failure or qualified pass", () => {
  const html = renderToStaticMarkup(<TestHistoryTable entries={[{...suite, outcome: "failed", failedCount: 0}]} routines={[]}/>);
  expect(html).toContain("Incomplete");
  expect(html).not.toContain("text-[#cf222e]");
});


test("terminal evidence failure is distinct from pending uploads on an otherwise passing run", () => {
  const run: Extract<TestHistoryEntry, {kind: "run"}> = {kind: "run", runId: "run", requestId: "request", routineId: "notes",
    hostId: "mini", laneId: "mac", platform: "ios-on-mac", startedAt: suite.startedAt, finishedAt: suite.finishedAt!,
    outcome: "pass", uploadsComplete: false, evidenceStatus: "failed", build: {...suite.build, repository: "Mentra-Community/MentraOS", channel: "dev"}};
  const failed = renderToStaticMarkup(<TestHistoryTable entries={[run]} routines={[]}/>);
  expect(failed).toContain("Evidence failed");
  expect(failed).not.toContain("Evidence pending");
  expect(failed).not.toContain("Evidence upload pending");
  expect(failed).not.toContain("text-[#1a7f37]");
  const pending = renderToStaticMarkup(<TestHistoryTable entries={[{...run, evidenceStatus: "complete"}]} routines={[]}/>);
  expect(pending).toContain("Evidence pending");
  expect(pending).toContain("Evidence upload pending");
  expect(pending).not.toContain("Evidence failed");
});

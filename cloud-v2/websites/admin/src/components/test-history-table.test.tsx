import {expect, test} from "bun:test";
import {renderToStaticMarkup} from "react-dom/server";
import type {TestHistoryEntry} from "../../../../packages/core/src/types/test-history.types";
import {TestHistoryTable, HistoryStatus} from "./test-history-table";

const suite: TestHistoryEntry = {kind: "suite", suiteId: "private-suite-id", channel: "dev", trigger: "nightly",
  startedAt: "2026-10-07T18:00:00Z", finishedAt: "2026-10-07T18:03:00Z", outcome: "passed",
  expectedCount: 2, passed: 2, rerunCount: 4, failedCount: 0, lanes: [{hostId: "private-host-id", laneId: "android-primary"}],
  build: {headSha: "a".repeat(40), release: "3.3.0-dev.698"}};

const run: Extract<TestHistoryEntry, {kind: "run"}> = {kind: "run", runId: "private-run-id", requestId: "request", routineId: "notes-phone",
  hostId: "mini", laneId: "mac", platform: "ios-on-mac", startedAt: suite.startedAt, finishedAt: suite.finishedAt!,
  outcome: "pass", uploadsComplete: true, evidenceStatus: "complete", stepCounts: {passed: 12, total: 14, skipped: 2},
  build: {...suite.build, repository: "Mentra-Community/MentraOS", channel: "dev"}};

test("history is a semantic table with named links, exact lane pairs and accepted suite rerun count", () => {
  const html = renderToStaticMarkup(<TestHistoryTable entries={[suite]} routines={[]}/>);
  expect(html).toContain('<table data-slot="table"');
  for (const heading of ["Started", "Name", "Duration", "Lane", "Tested build", "Status"])
    expect(html).toContain(`>${heading}</th>`);
  expect(html).toContain('scope="col"');
  expect(html).toContain('href="/?testSuite=private-suite-id"');
  expect(html).toContain("Dev nightly suite");
  expect(html).toContain("4 reruns");
  expect(html).toContain('title="4 routine reruns"');
  expect(html).toContain("hostId=private-host-id&amp;laneId=android-primary");
  expect(html).toContain("3m 00s");
  expect(html).toContain("3.3.0-dev.698");
  const text = html.replace(/<[^>]+>/g, "");
  expect(text).not.toContain(suite.suiteId);
  expect(text).not.toContain("private-host-id");
  expect(html).not.toContain('class="font-semibold underline"');
  expect(html).not.toContain('type="checkbox"');
});

test("standalone rerun counts link to the original run detail and stay out of the status column", () => {
  const html = renderToStaticMarkup(<TestHistoryTable entries={[{...run, rerunCount: 2}]} routines={[]}/>);
  expect(html).toContain('title="2 routine reruns"');
  expect(html).toContain('href="/?testRun=private-run-id" title="2 routine reruns"');
  expect(html).toContain("2 reruns");
  expect(html).not.toContain("testRerun=");
  expect(renderToStaticMarkup(<TestHistoryTable entries={[{...run, rerunCount: 0}]} routines={[]}/>)).not.toContain("routine reruns");
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

test("mixed history uses distinct kind icons, accessible kind names and a subtle suite row", () => {
  const html = renderToStaticMarkup(<TestHistoryTable entries={[suite, run]} routines={[]}/>);
  const [, suiteRow, runRow] = html.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/g)!;
  expect(suiteRow).toContain("lucide-layers");
  expect(suiteRow).toContain('<span class="sr-only">Test suite: </span>Dev nightly suite');
  expect(suiteRow.split(">", 1)[0]).toContain("bg-[#f6f8fa]");
  expect(suiteRow.split(">", 1)[0]).toContain("hover:bg-[#eaeef2]");
  expect(runRow).toContain("lucide-file-text");
  expect(runRow).toContain('<span class="sr-only">Routine run: </span>notes phone');
  expect(runRow.split(">", 1)[0]).not.toContain("hover:bg-[#eaeef2]");
  expect(html).not.toContain("font-bold");
  expect(html).not.toContain("font-semibold");
});

test("suite failure counts exclude authoritative skipped members from the denominator", () => {
  const html = renderToStaticMarkup(<TestHistoryTable entries={[{...suite, outcome: "failed", expectedCount: 8, passed: 3, failedCount: 2, skipped: 3}]} routines={[]}/>);
  expect(html).toContain("2/5 failed, 3 skipped");
  expect(html).toContain(">Failed</span>");
  expect(html).not.toContain("passed with complete evidence");
  expect(html).not.toContain("2/8 failed");
});

test("zero failures and waiting suite members keep their original qualified status", () => {
  const passed = renderToStaticMarkup(<TestHistoryTable entries={[{...suite, rerunCount: 0}]} routines={[]}/>);
  expect(passed).toContain("0/2 failed");
  expect(passed).toContain(">Passed</span>");
  expect(passed).not.toContain("skipped");
  const running = renderToStaticMarkup(<TestHistoryTable entries={[{...suite, outcome: "running", finishedAt: undefined, expectedCount: 8, passed: 1, failedCount: 0, skipped: 2}]} routines={[]} now={Date.parse(suite.startedAt) + 60_000}/>);
  expect(running).toContain("0/6 failed, 2 skipped");
  expect(running).toContain(">In progress</span>");
  expect(running).not.toContain("text-[#1a7f37]");
  expect(running).not.toContain("text-[#cf222e]");
  const allSkipped = renderToStaticMarkup(<TestHistoryTable entries={[{...suite, outcome: "failed", passed: 0, failedCount: 0, skipped: 2}]} routines={[]}/>);
  expect(allSkipped).toContain("0/0 failed, 2 skipped");
  expect(allSkipped).toContain(">Incomplete</span>");
});

test("individual run status omits step fractions and keeps evidence qualification", () => {
  const passed = renderToStaticMarkup(<TestHistoryTable entries={[run]} routines={[]}/>);
  expect(passed).toContain(">Passed</span>");
  expect(passed).not.toContain("12/14");
  expect(passed).not.toContain("2 skipped");
  const pending = renderToStaticMarkup(<TestHistoryTable entries={[{...run, uploadsComplete: false}]} routines={[]}/>);
  expect(pending).toContain("Evidence pending");
  expect(pending).toContain("Evidence upload pending");
  expect(pending).not.toContain("12/14");
});

test("unavailable records retain suite and run distinctions without guessed failure counts", () => {
  const entries: TestHistoryEntry[] = [
    {kind: "unavailable", sourceKind: "suite", id: suite.suiteId, startedAt: suite.startedAt, message: "Details unavailable."},
    {kind: "unavailable", sourceKind: "run", id: run.runId, startedAt: run.startedAt, message: "Details unavailable."},
  ];
  const html = renderToStaticMarkup(<TestHistoryTable entries={entries} routines={[]}/>);
  const [, suiteRow, runRow] = html.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/g)!;
  expect(suiteRow).toContain("lucide-layers");
  expect(suiteRow).toContain(">Test suite</a>");
  expect(suiteRow.split(">", 1)[0]).toContain("hover:bg-[#eaeef2]");
  expect(runRow).toContain("lucide-file-text");
  expect(runRow).toContain(">Routine run</a>");
  expect(runRow.split(">", 1)[0]).not.toContain("hover:bg-[#eaeef2]");
  expect(html.match(/Details unavailable\./g)).toHaveLength(2);
  expect(html.match(/>Unavailable<\/span>/g)).toHaveLength(2);
  expect(html).not.toContain("failed");
});

test("suite without reruns omits the badge and an included rerun links to its authoritative batch", () => {
  expect(renderToStaticMarkup(<TestHistoryTable entries={[{...suite, rerunCount: 0}]} routines={[]}/>)).not.toContain("routine reruns");
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

test("PR builds show the PR link followed by the recorded commit link", () => {
  const html = renderToStaticMarkup(<TestHistoryTable entries={[{...run, build: {...run.build, channel: "pr", prNumber: 698, producerUrl: "https://github.com/Mentra-Community/MentraOS/actions/runs/123"}}]} routines={[]}/>);
  expect(html).toContain('href="https://github.com/Mentra-Community/MentraOS/pull/698"');
  expect(html).toContain('>#698</a>');
  expect(html).toContain(`href="https://github.com/Mentra-Community/MentraOS/commit/${run.build.headSha}"`);
  expect(html).not.toContain("actions/runs/123");
});

test("a suite without a recorded repository does not invent a commit destination", () => {
  const html = renderToStaticMarkup(<TestHistoryTable entries={[{...suite, channel: "pr"}]} routines={[]}/>);
  expect(html).toContain("PR number unavailable");
  expect(html).toContain(suite.build.headSha.slice(0, 10));
  expect(html).not.toContain("github.com/Mentra-Community/MentraOS/commit/");
});

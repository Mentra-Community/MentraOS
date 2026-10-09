import {expect, test} from "bun:test";
import {renderToStaticMarkup} from "react-dom/server";
import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import {readSuiteId, TestSuitePage, RecentTestSuites, type TestSuiteResult} from "./test-suites";
const suite: TestSuiteResult = {suiteId: "nightly-123", channel: "dev", trigger: "nightly", startedAt: "2026-10-01T11:00:00Z",
  finishedAt: "2026-10-01T11:05:00Z", build: {headSha: "a".repeat(40), release: "dev.123"}, outcome: "failed", passed: 1,
  failedRoutines: ["ota"], members: [{memberId: "mac-captions", requestId: "req1", routineId: "captions-phone", platform: "ios-on-mac", status: "pass", publicationComplete: true, runId: "run-one"},
    {memberId: "android-ota", requestId: "req2", routineId: "ota", platform: "android", status: "not-run"}]};
test("suite link survives as a validated distinct URL", () => {
  expect(readSuiteId("?testSuite=nightly-123")).toBe("nightly-123");
  expect(readSuiteId("?testSuite=one&testSuite=two")).toBeNull();
  expect(readSuiteId("?testSuite=../bad")).toBeNull();
  expect(readSuiteId("?testSuite=nightly:dev.123")).toBe("nightly:dev.123");
  expect(readSuiteId(`?testSuite=${"a".repeat(240)}`)).toBe("a".repeat(240));
  expect(readSuiteId(`?testSuite=${"a".repeat(241)}`)).toBeNull();
});
test("suite shows missing routines and links to published recordings", () => {
  const client = new QueryClient(); client.setQueryData(["test-suite-summary", suite.suiteId], suite);
  const html = renderToStaticMarkup(<QueryClientProvider client={client}><TestSuitePage suiteId={suite.suiteId}/></QueryClientProvider>);
  expect(html).toContain("1/2 passed"); expect(html).toContain("Did not run");
  expect(html).toContain("/?testRun=run-one"); expect(html).toContain("Incomplete: ota");
});
test("recent suite link opens aggregate", () => {
  const client = new QueryClient(); client.setQueryData(["test-suites"], {suites: [suite]});
  expect(renderToStaticMarkup(<QueryClientProvider client={client}><RecentTestSuites/></QueryClientProvider>)).toContain("/?testSuite=nightly-123");
});

test("running suites explain automatic refresh and empty history stays hidden", () => {
  const client = new QueryClient();
  client.setQueryData(["test-suite-summary", suite.suiteId], {...suite, finishedAt: undefined, outcome: "running"});
  client.setQueryData(["test-suites"], {suites: []});
  const html = renderToStaticMarkup(<QueryClientProvider client={client}><TestSuitePage suiteId={suite.suiteId}/></QueryClientProvider>);
  expect(html).toContain("In progress"); expect(html).toContain("Refreshes every 15 seconds");
  expect(renderToStaticMarkup(<QueryClientProvider client={client}><RecentTestSuites/></QueryClientProvider>)).toBe("");
});

test("a one-member job opens its individual run instead of claiming to be a suite", () => {
  const client = new QueryClient();
  client.setQueryData(["test-suite-summary", suite.suiteId], {...suite, members: [suite.members[0]!], passed: 1, failedRoutines: []});
  const html = renderToStaticMarkup(<QueryClientProvider client={client}><TestSuitePage suiteId={suite.suiteId}/></QueryClientProvider>);
  expect(html).toContain("Individual routine run");
  expect(html).toContain("is not a test suite");
  expect(html).toContain('href="/?testRun=run-one"');
  expect(html).not.toContain("nightly test suite");
  expect(html).not.toContain("1/1 passed");
});

test("a rejected suite member displays its admission reason and keeps neighboring run links", () => {
  const client = new QueryClient();
  client.setQueryData(["test-suite-summary", suite.suiteId], {...suite, members: [suite.members[0]!,
    {...suite.members[1]!, unavailableReason: "missing-definition: Selected source is not installed."}]});
  const html = renderToStaticMarkup(<QueryClientProvider client={client}><TestSuitePage suiteId={suite.suiteId}/></QueryClientProvider>);
  expect(html).toContain("missing-definition: Selected source is not installed.");
  expect(html).toContain('href="/?testRun=run-one"');
  expect(html).toContain("Did not run");
});

function renderSuite(value: TestSuiteResult) {
  const client = new QueryClient();
  client.setQueryData(["test-suite-summary", value.suiteId], value);
  return renderToStaticMarkup(<QueryClientProvider client={client}><TestSuitePage suiteId={value.suiteId}/></QueryClientProvider>);
}

test("live suite members show active execution and their actual linked lane", () => {
  const html = renderSuite({...suite, finishedAt: undefined, outcome: "running", members: [
    {...suite.members[0]!, status: "running", publicationComplete: false, runId: undefined, hostId: "testing-air-1", laneId: "testing-air-1-mac"},
    {...suite.members[1]!, status: "waiting", hostId: undefined, laneId: undefined},
  ]});
  expect(html).toContain('href="/?systemHealth=1&amp;hostId=testing-air-1&amp;laneId=testing-air-1-mac"');
  expect(html).toContain('title="testing-air-1 / testing-air-1-mac"');
  expect(html).toContain('>testing air 1 mac</a>');
  expect(html).toContain('animate-spin');
  expect(html).toContain('>In progress</span>');
  expect(html).toContain('>Waiting</span>');
  expect(html).not.toContain('>Mac</td>');
  expect(html).not.toContain('>Android</td>');
});

test("suite totals and routine rows use hours for long durations", () => {
  const html = renderSuite({...suite, finishedAt: "2026-10-01T13:02:03Z", members: [
    {...suite.members[0]!, startedAt: suite.startedAt, finishedAt: "2026-10-01T12:02:03Z"}, suite.members[1]!,
  ]});
  expect(html).toContain("2h 02m 03s");
  expect(html).toContain('<td class="whitespace-nowrap tabular-nums">1h 02m 03s</td>');
  expect(html).not.toContain("122m");
  expect(html).not.toContain("62m");
});

test("suite displays chronological execution order with unrun members last and stable ties", () => {
  const member = suite.members[0]!;
  const value = {...suite, members: [
    {...member, memberId: "unrun", routineId: "unrun", status: "not-run", startedAt: undefined},
    {...member, memberId: "later", routineId: "later", startedAt: "2026-10-01T11:04:00Z"},
    {...member, memberId: "first", routineId: "first", startedAt: "2026-10-01T04:01:00-07:00"},
    {...member, memberId: "tie", routineId: "tie", startedAt: "2026-10-01T11:01:00Z"},
    {...member, memberId: "waiting", routineId: "waiting", status: "waiting", startedAt: undefined},
  ]};
  const original = value.members.map(member => member.memberId);
  const html = renderSuite(value);
  const order = ["first", "tie", "later", "unrun", "waiting"].map(id => html.indexOf(`>${id}</a>`));
  expect(order.every(index => index >= 0)).toBe(true);
  expect(order).toEqual([...order].sort((a, b) => a - b));
  expect(value.members.map(member => member.memberId)).toEqual(original);
});

test("only passing and failure results use green and red; other states remain neutral", () => {
  for (const status of ["pass", "failed", "setup-failed", "teardown-failed", "not-run", "waiting", "cancelled"]) {
    const html = renderSuite({...suite, members: [suite.members[0]!, {...suite.members[1]!, status, publicationComplete: true}]});
    const label = status === "pass" ? "Passed" : status === "not-run" ? "Not run" : status.replaceAll("-", " ").replace(/^./, c => c.toUpperCase());
    const color = status === "pass" ? "text-[#1a7f37]" : ["failed", "setup-failed", "teardown-failed"].includes(status) ? "text-[#cf222e]" : "text-[#656d76]";
    const row = html.match(/<tbody>(.*?)<\/tbody>/)?.[1].match(/<tr[^>]*>(.*?)<\/tr>/g)?.[1] ?? "";
    expect(row).toContain(color); expect(row).toContain(`>${label}</span>`);
  }
});

test("missing results make the completed suite incomplete without red in detail or history", () => {
  const html = renderSuite(suite);
  expect(html).toContain("Incomplete");
  expect(html).not.toContain("text-red");
  expect(html).not.toContain("bg-red");
  const client = new QueryClient(); client.setQueryData(["test-suites"], {suites: [suite]});
  const history = renderToStaticMarkup(<QueryClientProvider client={client}><RecentTestSuites/></QueryClientProvider>);
  expect(history).toContain("Incomplete");
  expect(history).not.toContain("text-red");
  expect(history).not.toContain("bg-red");
});

test("actual failures stay red and incomplete routines have their own neutral summary", () => {
  const html = renderSuite({...suite, failedRoutines: ["ota", "call"], members: [...suite.members,
    {...suite.members[0]!, memberId: "call", routineId: "call", status: "failed"}]});
  expect(html).toContain("bg-red-100 text-red-800");
  expect(html).toContain('text-red-700">Failed: call');
  expect(html).toContain('text-[#68746d]">Incomplete: ota');
});


test("suite rows show compact 12-hour start times and retain the full suite date", () => {
  const startedAt = "2026-10-01T11:01:23Z";
  const html = renderSuite({...suite, members: [{...suite.members[0]!, startedAt}, suite.members[1]!]});
  expect(html).toContain("<th>Started</th><th>Name</th><th>Duration</th><th>Lane</th><th>Tested build</th><th>Status</th>");
  expect(html).toContain(`<time dateTime="${startedAt}">${new Date(startedAt).toLocaleTimeString("en-US", {hour: "numeric", minute: "2-digit", hour12: true})}</time>`);
  expect(html).toContain(`Started ${new Date(suite.startedAt).toLocaleString()}`);
  const rows = html.match(/<tbody>(.*?)<\/tbody>/)?.[1].match(/<tr[^>]*>(.*?)<\/tr>/g) ?? [];
  expect(rows).toHaveLength(2);
  expect(rows[0]).toContain('<td class="whitespace-nowrap tabular-nums"><time');
  expect(rows[0]).toContain('text-[#1a7f37]'); expect(rows[0]).toContain('>Passed</span>');
  expect(rows[1]).toContain('text-[#656d76]'); expect(rows[1]).toContain('>Not run</span>');
  expect(html.match(/<time /g)).toHaveLength(1);
  expect(html).toContain('<td class="whitespace-nowrap tabular-nums">—</td>');
});

test.each([false, undefined])("a passed run with unpublished evidence stays neutral and does not inflate the qualified header; complete=%s", publicationComplete => {
  const value: TestSuiteResult = {...suite, finishedAt: undefined, outcome: "running", passed: 1, failedRoutines: ["ota"],
    members: [suite.members[0]!, {...suite.members[1]!, status: "pass", publicationComplete, runId: "uploading-run"}]};
  const before = JSON.stringify(value);
  const html = renderSuite(value);
  expect(html).toContain("1/2 passed with complete evidence");
  expect(html).toContain("1 passed · evidence pending");
  expect(html).toContain("text-[#656d76]");
  expect(html).toContain(">Evidence pending</span>");
  expect(html.match(/>Passed<\/span>/g)).toHaveLength(1);
  expect(html).toContain('href="/?testRun=uploading-run"');
  const client = new QueryClient(); client.setQueryData(["test-suites"], {suites: [value]});
  const recent = renderToStaticMarkup(<QueryClientProvider client={client}><RecentTestSuites/></QueryClientProvider>);
  expect(recent).toContain("1/2 passed with complete evidence · 1 passed with pending evidence");
  expect(JSON.stringify(value)).toBe(before);
  const published = renderSuite({...value, passed: 2, members: value.members.map(member => ({...member, publicationComplete: true}))});
  expect(published).toContain("2/2 passed with complete evidence");
  expect(published).not.toContain("Passed · evidence pending");
});


test("suite actions replace selection, keep status read-only and disable active originals or reruns", () => {
  const client = new QueryClient();
  const base = suite.members[0]!;
  const value: TestSuiteResult = {...suite, members: [
    {...base, memberId: "finished", routineId: "finished"},
    {...base, memberId: "waiting", routineId: "waiting", status: "waiting"},
    {...base, memberId: "retrying", routineId: "retrying", status: "failed"},
    {...base, memberId: "unknown", routineId: "unknown"},
  ]};
  client.setQueryData(["test-suite-summary", value.suiteId], value);
  client.setQueryData(["rerun-progress", value.suiteId], {members: [
    {memberId: "finished", latest: null}, {memberId: "waiting", latest: null},
    {memberId: "retrying", latest: {attemptId: "active", memberId: "retrying", attemptNumber: 1, parent: {suiteId: value.suiteId}, status: "running", publicationComplete: false}},
  ], children: []});
  const html = renderToStaticMarkup(<QueryClientProvider client={client}><TestSuitePage suiteId={value.suiteId}/></QueryClientProvider>);
  expect(html).toContain('<th>Status</th><th><span class="sr-only">Actions</span></th>');
  expect(html).not.toContain('type="checkbox"');
  expect(html).not.toContain("Rerun selected");
  expect(html).not.toContain("No reruns");
  const buttons = html.match(/<button[^>]*title="Rerun"[^>]*>/g) ?? [];
  expect(buttons).toHaveLength(4);
  expect(buttons[0]).toContain('aria-label="Rerun finished (ios-on-mac)"');
  expect(buttons[0]).not.toContain('disabled=""');
  for (const button of buttons.slice(1)) expect(button).toContain('disabled=""');
  expect(html).toContain('disabled="">Rerun failures</button>');
  expect(html).toContain('Attempt 1 · running');
});


test("unbound suite members use plain names and explain missing detail links", () => {
  const html = renderSuite({...suite, members: [suite.members[0]!, {...suite.members[1]!, routineId: "unbound", runId: undefined, requestId: undefined}]})
  expect(html).toContain('<span class="font-medium">unbound</span>')
  expect(html).toContain("Not available yet")
  expect(html).not.toMatch(/<a[^>]*>unbound<\/a>/)
})


test("suite presentation requests the compact summary rather than full dispatch inputs", () => {
  const client = new QueryClient();
  renderToStaticMarkup(<QueryClientProvider client={client}><TestSuitePage suiteId="pending-suite"/></QueryClientProvider>);
  const query = client.getQueryCache().find({queryKey: ["test-suite-summary", "pending-suite"]});
  expect(query?.options.queryFn?.toString()).toContain("/summary");
  expect(client.getQueryCache().find({queryKey: ["test-suite", "pending-suite"]})).toBeUndefined();
});

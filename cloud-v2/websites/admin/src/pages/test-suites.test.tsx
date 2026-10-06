import {expect, test} from "bun:test";
import {renderToStaticMarkup} from "react-dom/server";
import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import {readSuiteId, TestSuitePage, RecentTestSuites, type TestSuiteResult} from "./test-suites";
const suite: TestSuiteResult = {suiteId: "nightly-123", channel: "dev", trigger: "nightly", startedAt: "2026-10-01T11:00:00Z",
  finishedAt: "2026-10-01T11:05:00Z", build: {headSha: "a".repeat(40), release: "dev.123"}, outcome: "failed", passed: 1,
  failedRoutines: ["ota"], members: [{memberId: "mac-captions", requestId: "req1", routineId: "captions-phone", platform: "ios-on-mac", status: "pass", runId: "run-one"},
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
  const client = new QueryClient(); client.setQueryData(["test-suite", suite.suiteId], suite);
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
  client.setQueryData(["test-suite", suite.suiteId], {...suite, finishedAt: undefined, outcome: "running"});
  client.setQueryData(["test-suites"], {suites: []});
  const html = renderToStaticMarkup(<QueryClientProvider client={client}><TestSuitePage suiteId={suite.suiteId}/></QueryClientProvider>);
  expect(html).toContain("In progress"); expect(html).toContain("Refreshes every 15 seconds");
  expect(renderToStaticMarkup(<QueryClientProvider client={client}><RecentTestSuites/></QueryClientProvider>)).toBe("");
});

test("a one-member job opens its individual run instead of claiming to be a suite", () => {
  const client = new QueryClient();
  client.setQueryData(["test-suite", suite.suiteId], {...suite, members: [suite.members[0]!], passed: 1, failedRoutines: []});
  const html = renderToStaticMarkup(<QueryClientProvider client={client}><TestSuitePage suiteId={suite.suiteId}/></QueryClientProvider>);
  expect(html).toContain("Individual routine run");
  expect(html).toContain("is not a test suite");
  expect(html).toContain('href="/?testRun=run-one"');
  expect(html).not.toContain("nightly test suite");
  expect(html).not.toContain("1/1 passed");
});

test("a rejected suite member displays its admission reason and keeps neighboring run links", () => {
  const client = new QueryClient();
  client.setQueryData(["test-suite", suite.suiteId], {...suite, members: [suite.members[0]!,
    {...suite.members[1]!, unavailableReason: "missing-definition: Selected source is not installed."}]});
  const html = renderToStaticMarkup(<QueryClientProvider client={client}><TestSuitePage suiteId={suite.suiteId}/></QueryClientProvider>);
  expect(html).toContain("missing-definition: Selected source is not installed.");
  expect(html).toContain('href="/?testRun=run-one"');
  expect(html).toContain("Did not run");
});

function renderSuite(value: TestSuiteResult) {
  const client = new QueryClient();
  client.setQueryData(["test-suite", value.suiteId], value);
  return renderToStaticMarkup(<QueryClientProvider client={client}><TestSuitePage suiteId={value.suiteId}/></QueryClientProvider>);
}

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
  const order = ["first", "tie", "later", "unrun", "waiting"].map(id => html.indexOf(`font-medium">${id}</td>`));
  expect(order.every(index => index >= 0)).toBe(true);
  expect(order).toEqual([...order].sort((a, b) => a - b));
  expect(value.members.map(member => member.memberId)).toEqual(original);
});

test("only passing and failure results use green and red; other states remain neutral", () => {
  for (const status of ["pass", "failed", "setup-failed", "teardown-failed", "not-run", "waiting", "cancelled"]) {
    const html = renderSuite({...suite, members: [suite.members[0]!, {...suite.members[1]!, status}]});
    const label = status === "not-run" ? "Did not run" : status === "waiting" ? "Awaiting result" : status;
    const color = status === "pass" ? "text-green-700" : ["failed", "setup-failed", "teardown-failed"].includes(status) ? "text-red-700" : "text-[#68746d]";
    expect(html).toContain(`<td class="${color}">${label}`);
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

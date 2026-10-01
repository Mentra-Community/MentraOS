import {expect, test} from "bun:test";
import {renderToStaticMarkup} from "react-dom/server";
import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import {readSuiteId, TestSuitePage, RecentTestSuites, type TestSuiteResult} from "./test-suites";
const suite: TestSuiteResult = {suiteId: "nightly-123", channel: "dev", trigger: "nightly", startedAt: "2026-10-01T11:00:00Z",
  finishedAt: "2026-10-01T11:05:00Z", build: {headSha: "a".repeat(40), release: "dev.123"}, outcome: "failed", passed: 1,
  failedRoutines: ["ota"], members: [{memberId: "mac-captions", requestId: "req1", routineId: "captions-phone", platform: "ios-mac", status: "passed", runId: "run-one"},
    {memberId: "android-ota", requestId: "req2", routineId: "ota", platform: "android", status: "not-run"}]};
test("suite link survives as a validated distinct URL", () => {
  expect(readSuiteId("?testSuite=nightly-123")).toBe("nightly-123");
  expect(readSuiteId("?testSuite=one&testSuite=two")).toBeNull();
  expect(readSuiteId("?testSuite=../bad")).toBeNull();
});
test("suite shows missing routines and links to published recordings", () => {
  const client = new QueryClient(); client.setQueryData(["test-suite", suite.suiteId], suite);
  const html = renderToStaticMarkup(<QueryClientProvider client={client}><TestSuitePage suiteId={suite.suiteId}/></QueryClientProvider>);
  expect(html).toContain("1/2 passed"); expect(html).toContain("Did not run");
  expect(html).toContain("/?testRun=run-one"); expect(html).toContain("Failed or incomplete: ota");
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

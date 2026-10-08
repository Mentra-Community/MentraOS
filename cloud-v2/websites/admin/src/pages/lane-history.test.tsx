import {expect, test} from "bun:test";
import {renderToStaticMarkup} from "react-dom/server";
import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import {LaneHistoryPage} from "./lane-history";
import {laneHistoryHref, readLaneSelection} from "../lib/lane-links";
import type {LaneRestorationAttempt, LaneRestorationHost} from "../../../../packages/core/src/types/lane-restoration.types";
const at = "2026-10-06T03:00:00Z", now = Date.parse(at);
const selection = {hostId: "mini", laneId: "mac"};
const attempt: LaneRestorationAttempt = {executionId: "fixer:mac", interruptionId: "repair:mac", laneId: "mac", generation: 1,
  current: false, state: "resumed", assignedAt: at, handedOffAt: at, startedAt: at, finishedAt: at, report: null,
  resume: {status: "accepted", decisionId: "resume:mac", calledAt: at, reason: null}, requiredAction: null,
  actions: [], actionsTruncated: false, requestId: "request:mac", runId: null, incidentId: null, sessionId: null};
const host: LaneRestorationHost = {hostId: "mini", observedAt: at, receivedAt: at,
  lanes: [{id: "mac", platform: "ios-on-mac", state: "idle", dispatchMode: "automatic"}, {id: "android", platform: "android", state: "running", dispatchMode: "authoring"}],
  restoration: {schemaVersion: 1, truncated: true, attempts: [attempt, {...attempt, executionId: "foreign-fixer", laneId: "android", requestId: "foreign-request"}]}};
const run = (runId: string) => ({runId, requestId: runId, hostId: "mini", laneId: "mac", routineId: "notes", platform: "ios-on-mac",
  startedAt: at, finishedAt: at, outcome: "passed", uploadsComplete: true, evidenceStatus: "complete",
  build: {repository: "Mentra-Community/MentraOS", channel: "dev", headSha: "a".repeat(40)}});
function fixture() {
  const client = new QueryClient({defaultOptions: {queries: {retry: false}}});
  client.setQueryData(["lane-overview"], {hosts: [host, {...host, hostId: "foreign-host"}], freshForMs: 120000});
  client.setQueryData(["lane-restoration", "mini"], {hosts: [host], freshForMs: 120000});
  client.setQueryData(["lane-runs", "mini", "mac"], {pages: [{runs: [run("first")], nextCursor: "next"}, {runs: [run("second")], nextCursor: "third"}], pageParams: [undefined, "next"]});
  return {client, render: () => renderToStaticMarkup(<QueryClientProvider client={client}><LaneHistoryPage selection={selection} now={now}/></QueryClientProvider>)};
}
test("lane links retain exact host and lane identities and reject incomplete or duplicate scope", () => {
  expect(readLaneSelection(new URL(laneHistoryHref("host:one", "lane:two"), "https://admin.example").search)).toEqual({hostId: "host:one", laneId: "lane:two"});
  for (const search of ["?systemHealth=1&laneId=mac", "?systemHealth=1&hostId=mini", "?systemHealth=1&hostId=mini&laneId=mac&laneId=android", "?hostId=mini&laneId=mac", "?systemHealth=1&hostId=mini&laneId="]) expect(readLaneSelection(search)).toBeNull();
});
test("lane history shows only the selected controller/lane, paginated runs and restoration receipts", () => {
  const {client, render} = fixture(); const html = render();
  expect(html).toContain("Mini · iOS on Mac · Glasses not reported history"); expect(html).toContain("testRun=first"); expect(html).toContain("testRun=second");
  expect(html).toContain("More runs"); expect(html).toContain("Scheduling resumed"); expect(html).toContain("request%3Amac");
  expect(html).not.toContain("foreign-fixer"); expect(html).not.toContain("foreign-request"); expect(html).not.toContain("foreign-host");
  expect(html).toContain("bounded portion"); client.clear();
});
test("run pagination always requests both host and lane and preserves its cursor", async () => {
  const {client} = fixture();
  renderToStaticMarkup(<QueryClientProvider client={client}><LaneHistoryPage selection={selection} now={now}/></QueryClientProvider>);
  const query = client.getQueryCache().find({queryKey: ["lane-runs", "mini", "mac"]})!;
  const original = globalThis.fetch; let url = "";
  globalThis.fetch = (async input => {url = String(input); return Response.json({runs: [], nextCursor: null});}) as typeof fetch;
  try {
    await (query.options.queryFn as Function)({pageParam: "cursor:next"});
    expect(url).toBe("/api/admin/test-runs?hostId=mini&laneId=mac&cursor=cursor%3Anext");
  } finally {globalThis.fetch = original; client.clear();}
});

test('lane details fetch retained history for the selected host only', async () => {
  const {client, render} = fixture(); render();
  const query = client.getQueryCache().find({queryKey: ['lane-restoration', 'mini']})!;
  const original = globalThis.fetch; let url = '';
  globalThis.fetch = (async input => {url = String(input); return Response.json({hosts: [], freshForMs: 120000});}) as typeof fetch;
  try {await (query.options.queryFn as Function)({}); expect(url).toBe('/api/admin/test-runs/restoration/list?hostId=mini')}
  finally {globalThis.fetch = original; client.clear()}
});
test("cached refresh failures keep history but current lane status becomes unknown", () => {
  const {client, render} = fixture();
  for (const queryKey of [["lane-overview"], ["lane-runs", "mini", "mac"]]) client.getQueryCache().find({queryKey})!.setState({status: "error", error: new Error("Refresh failed")});
  const html = render(); expect(html).toContain("Current lane status is unknown"); expect(html).toContain("Run history could not refresh");
  expect(html).toContain("testRun=first"); expect(html).toContain("Last reported state: Idle"); client.clear();
});
test("an unknown lane cannot display another lane's restoration history", () => {
  const {client} = fixture();
  const html = renderToStaticMarkup(<QueryClientProvider client={client}><LaneHistoryPage selection={{hostId: "mini", laneId: "missing"}} now={now}/></QueryClientProvider>);
  expect(html).toContain("No controller report is available for this lane"); expect(html).not.toContain("resume:mac"); client.clear();
});

test("a fresh lane visit shows restoration loading until controller reports settle", () => {
  const client = new QueryClient({defaultOptions: {queries: {retry: false}}});
  const render = () => renderToStaticMarkup(<QueryClientProvider client={client}><LaneHistoryPage selection={selection} now={now}/></QueryClientProvider>);
  const loading = render();
  expect(loading).toContain("Loading restoration history");
  expect(loading).toContain('animate-spin');
  expect(loading).toContain('role="status"');
  expect(loading).not.toContain("Restoration history is unavailable for this lane.");
  client.setQueryData(["lane-overview"], {hosts: [], freshForMs: 120000});
  client.setQueryData(["lane-restoration", "mini"], {hosts: [], freshForMs: 120000});
  expect(render()).toContain("Restoration history is unavailable for this lane.");
  expect(render()).not.toContain("Loading restoration history");
  client.clear();
});

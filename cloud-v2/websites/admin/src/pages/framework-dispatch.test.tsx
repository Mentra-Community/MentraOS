import {expect, test} from "bun:test";
import {renderToStaticMarkup} from "react-dom/server";
import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import {buildSelectable, pickerRequest, NativeActivityPanel, NativeDispatchPanel, TestBuildOption} from "./framework-dispatch";
import type {TestBuild} from "../../../../packages/core/src/types/test-build.types";
const build: TestBuild = {source: {channel: "dev", buildRunId: 15, publicationAttempt: 1}, platform: "ios-on-mac", title: "Dev build", headSha: "a".repeat(40), buildUrl: "https://github.com/Mentra-Community/MentraOS/actions/runs/15", createdAt: "2026-10-02T19:00:00Z", availability: "available", receipt: {url: "https://artifactscdn.mentraglass.com/receipt", size: 10, sha256: "c".repeat(64)}, archive: {name: "app.zip", url: "https://artifactscdn.mentraglass.com/app.zip", size: 100, sha256: "b".repeat(64)}};
test("published build radio is selectable and unavailable row explains why", () => {
 expect(buildSelectable(build)).toBe(true);
 const published = renderToStaticMarkup(<TestBuildOption build={build} checked={false} disabled={false} onSelect={() => {}} />);
 expect(published).not.toContain('disabled=""'); expect(published).toContain("Published · ready to select");
 const missing = {...build, availability: "unavailable" as const, reason: "Mac publication is still running"};
 expect(buildSelectable(missing)).toBe(false);
 const unavailable = renderToStaticMarkup(<TestBuildOption build={missing} checked={false} disabled={false} onSelect={() => {}} />);
 expect(unavailable).toContain('disabled=""'); expect(unavailable).toContain(missing.reason);
});

test("dispatch lists main source IDs without enrollment metadata and asks for platform explicitly", () => {
 const client = new QueryClient({defaultOptions: {queries: {retry: false}}});
 client.setQueryData(["routine-catalog"], {routines: []});
 client.setQueryData(["dispatch-routines", ""], {routineRevision: "c".repeat(40), routines: [{routineId: "new-main-routine"}]});
 const html = renderToStaticMarkup(<QueryClientProvider client={client}><NativeDispatchPanel /></QueryClientProvider>);
 expect(html).toContain('value="new-main-routine"');
 expect(html).toContain('aria-label="Platform"');
 expect(html).toContain('aria-label="Routine revision"');
 expect(html).toContain("latest Harness main when submitted");
 expect(html).not.toContain("UI Mac walkthrough");
});

test("picker submits default main or an explicit exact SHA independently of inspected inventory revision", () => {
 const selected = {requestId: "request", hostId: "mini", laneId: "mac", routineId: "new-main-routine", platform: "ios-on-mac" as const, build};
 const latest = pickerRequest(selected);
 expect(latest).not.toHaveProperty("routineRevision");
 expect(latest).toMatchObject({routineId: "new-main-routine", platform: "ios-on-mac", source: build.source, archiveSha256: build.archive!.sha256});
 expect(pickerRequest({...selected, routineRevision: "d".repeat(40)}).routineRevision).toBe("d".repeat(40));
 expect(() => pickerRequest({...selected, routineRevision: "main"})).toThrow("40-character");
 expect(() => pickerRequest({...selected, platform: "android"})).toThrow("published build");
 expect(buildSelectable({...build, receipt: undefined})).toBe(false);
});


test("delivery cards explain queue states and keep diagnostic IDs in details", () => {
 const client = new QueryClient();
 client.setQueryData(["framework-activity"], {requests: ["queued", "accepted", "running", "unknown"].map(state => ({
   requestId: `request-${state}`, hostId: "test-mac-mini", state, createdAt: "2026-10-06T11:00:00Z",
   routineId: "captions-phone", laneId: "mac-primary", platform: "ios-on-mac",
 }))});
 const html = renderToStaticMarkup(<QueryClientProvider client={client}><NativeActivityPanel/></QueryClientProvider>);
 expect(html).toContain("Captions phone");
 expect(html).toContain("Waiting for computer");
 expect(html).toContain("Received by computer");
 expect(html).toContain("Execution has not been reported yet.");
 expect(html).toContain("Its test result is still pending.");
 expect(html).toContain("Delivery status unavailable");
 expect(html).toContain("<dd>Mac</dd>");
 expect(html).toContain("<dd>Test mac mini</dd>");
 expect(html).toContain("<dd>Mac primary</dd>");
 expect(html).toContain("<summary class=\"cursor-pointer\">Request details</summary>");
 expect(html).toContain("request-queued");
});

test("delivery distinguishes loading from an empty queue", () => {
 const client = new QueryClient();
 const render = () => renderToStaticMarkup(<QueryClientProvider client={client}><NativeActivityPanel/></QueryClientProvider>);
 expect(render()).toContain("Loading request delivery");
 expect(render()).not.toContain("No pending requests.");
 client.setQueryData(["framework-activity"], {requests: []});
 expect(render()).toContain("No pending requests.");
 expect(render()).not.toContain("Loading request delivery");
});

test("preparing delivery has a routine name and exact waiting reason without executable input", () => {
 const client = new QueryClient();
 client.setQueryData(["framework-activity"], {requests: [{requestId: "source-request", hostId: "test-mac-mini", state: "preparing", routineId: "new-main-routine", platform: "android", laneId: "android", definitionRevision: "a".repeat(40), reason: "Installed routine API is too old; waiting for framework deployment."}]});
 const html = renderToStaticMarkup(<QueryClientProvider client={client}><NativeActivityPanel/></QueryClientProvider>);
 expect(html).toContain("New main routine"); expect(html).toContain("Preparing routine source");
 expect(html).toContain("Installed routine API is too old; waiting for framework deployment.");
 expect(html).toContain("No test has started.");
});


test("picker accepts fleet and host targets and delivery shows unassigned jobs", () => {
 const portable = {requestId: "portable", routineId: "new-main-routine", platform: "ios-on-mac" as const, build};
 expect(pickerRequest(portable)).not.toHaveProperty("hostId");
 expect(pickerRequest(portable)).not.toHaveProperty("laneId");
 expect(pickerRequest({...portable, hostId: "mini"})).toHaveProperty("hostId", "mini");
 expect(() => pickerRequest({...portable, laneId: "mac"})).toThrow("computer ID");
 const client = new QueryClient();
 client.setQueryData(["framework-activity"], {requests:[{requestId:"portable",state:"awaiting-runner",routineId:"new-main-routine",platform:"ios-on-mac"}]});
 const html = renderToStaticMarkup(<QueryClientProvider client={client}><NativeActivityPanel/></QueryClientProvider>);
 expect(html).toContain("Waiting for compatible computer");
 expect(html).toContain("Awaiting assignment");
});

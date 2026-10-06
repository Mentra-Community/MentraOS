import {expect, test} from "bun:test";
import {renderToStaticMarkup} from "react-dom/server";
import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import {buildSelectable, NativeActivityPanel, NativeDispatchPanel, TestBuildOption} from "./framework-dispatch";
import type {TestBuild} from "../../../../packages/core/src/types/test-build.types";
const build: TestBuild = {source: {channel: "dev", buildRunId: 15, publicationAttempt: 1}, platform: "ios-on-mac", title: "Dev build", headSha: "a".repeat(40), buildUrl: "https://github.com/Mentra-Community/MentraOS/actions/runs/15", createdAt: "2026-10-02T19:00:00Z", availability: "available", archive: {name: "app.zip", url: "https://artifactscdn.mentraglass.com/app.zip", size: 100, sha256: "b".repeat(64)}};
test("published build radio is selectable and unavailable row explains why", () => {
 expect(buildSelectable(build)).toBe(true);
 const published = renderToStaticMarkup(<TestBuildOption build={build} checked={false} disabled={false} onSelect={() => {}} />);
 expect(published).not.toContain('disabled=""'); expect(published).toContain("Published · ready to select");
 const missing = {...build, availability: "unavailable" as const, reason: "Mac publication is still running"};
 expect(buildSelectable(missing)).toBe(false);
 const unavailable = renderToStaticMarkup(<TestBuildOption build={missing} checked={false} disabled={false} onSelect={() => {}} />);
 expect(unavailable).toContain('disabled=""'); expect(unavailable).toContain(missing.reason);
});

// A never-run routine must be dispatchable before it has a catalog recording.
test("dispatch lists enrolled definitions independently of passing examples", () => {
 const client = new QueryClient({defaultOptions: {queries: {retry: false}}});
 client.setQueryData(["routine-catalog"], {routines: []});
 client.setQueryData(["dispatch-routines"], {routines: [{routineId: "no-glasses", platform: "ios-on-mac",
   definitionRevision: "c".repeat(40), definitionSha256: "d".repeat(64),
   definition: {title: "UI Mac walkthrough", execution: {resourceKinds: ["app", "recorder"]}}}]});
 const html = renderToStaticMarkup(<QueryClientProvider client={client}><NativeDispatchPanel /></QueryClientProvider>);
 expect(html).toContain('value="no-glasses/ios-on-mac"');
 expect(html).toContain("UI Mac walkthrough · ios-on-mac");
});


test("delivery cards explain queue states and keep diagnostic IDs in details", () => {
 const client = new QueryClient();
 client.setQueryData(["framework-activity"], {requests: ["queued", "accepted", "running", "unknown"].map(state => ({
   requestId: `request-${state}`, hostId: "test-mac-mini", state, createdAt: "2026-10-06T11:00:00Z",
   input: {routineId: "captions-phone", laneId: "mac-primary", platform: "ios-on-mac"},
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
 expect(render()).toContain("Loading request delivery…");
 expect(render()).not.toContain("No pending requests.");
 client.setQueryData(["framework-activity"], {requests: []});
 expect(render()).toContain("No pending requests.");
 expect(render()).not.toContain("Loading request delivery…");
});

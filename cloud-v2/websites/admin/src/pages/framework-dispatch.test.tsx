import {expect, test} from "bun:test";
import {renderToStaticMarkup} from "react-dom/server";
import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import {buildSelectable, NativeDispatchPanel, TestBuildOption} from "./framework-dispatch";
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

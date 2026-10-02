import {expect, test} from "bun:test";
import {renderToStaticMarkup} from "react-dom/server";
import {buildSelectable, TestBuildOption} from "./framework-dispatch";
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

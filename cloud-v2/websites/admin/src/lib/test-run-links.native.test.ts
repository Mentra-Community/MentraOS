import {expect, test} from "bun:test";
import {hasInvalidTestRunListScope, readTestRunLink, readTestRunListScope, testRunAssetPath} from "./test-run-links";
test("native identities survive query links and encoded asset paths", () => {
 const id = "local:run." + "a".repeat(200);
 expect(readTestRunLink(new URLSearchParams({testRun: id}).toString())?.runID).toBe(id);
 expect(testRunAssetPath(id, "capture.part:1")).toContain(encodeURIComponent(id));
 for (const bad of ["../run", "run/path", "run%2fpath"]) {
  expect(readTestRunLink(new URLSearchParams({testRun: bad}).toString())).toBeNull();
  expect(() => testRunAssetPath(bad, "capture")).toThrow();
 }
});

test("unsupported or incomplete filters are explicit refusals rather than global history", () => {
 const current = {testRuns: "1", repository: "Mentra-Community/MentraOS", channel: "pr", pr: "123", headSha: "a".repeat(40), archiveSha256: "d".repeat(64), routineId: "coverage", platform: "android"};
 expect(hasInvalidTestRunListScope(new URLSearchParams(current).toString())).toBe(false);
 expect(hasInvalidTestRunListScope("?testRuns=1")).toBe(false);
 for (const search of [new URLSearchParams({...current, platform: "ios-mac"}).toString(),
   new URLSearchParams(Object.fromEntries(Object.entries(current).filter(([key]) => key !== "channel"))).toString(),
   "?testRuns=1&pr=123&headSha=" + "a".repeat(40)]) {
  expect(readTestRunListScope(search)).toBeNull();
  expect(hasInvalidTestRunListScope(search)).toBe(true);
 }
});

// Exercise notification producers through the real Admin parser, rather than comparing query strings alone.
test("PR and release producer links preserve exact current-platform scopes", async () => {
 // @ts-expect-error The GitHub producer is JavaScript; this integration test exercises its runtime output.
 const {routineResultsUrl} = await import("../../../../../.github/scripts/notify-pr-builds.mjs");
 // @ts-expect-error The GitHub producer is JavaScript; this integration test exercises its runtime output.
 const {coordinatedRoutineLinks} = await import("../../../../../.github/scripts/coordinated-downloads-slack.mjs");
 const {readTestRunListScope} = await import("./test-run-links");
 const sha = "a".repeat(40), digest = "d".repeat(64);
 for (const platform of ["android", "ios-on-mac"] as const) {
  const url = routineResultsUrl({repository: "Mentra-Community/MentraOS", pr: 123, sha, archiveSha256: digest, routineId: "coverage", platform});
  expect(readTestRunListScope(new URL(url).search)).toEqual({repository: "Mentra-Community/MentraOS", channel: "pr", pr: "123", headSha: sha, archiveSha256: digest, routineId: "coverage", platform});
 }
 const [block] = await coordinatedRoutineLinks({BRANCH: "dev", REPOSITORY: "Mentra-Community/MentraOS", FINALIZE_RESULT: "success", RELEASE_IDENTITY: "3.3.0-dev.223", SHA: sha, TEST_RUN_INGEST_TOKEN: "synthetic", MAC_URL: "https://example.com/mac.zip"},
  async () => new Response(JSON.stringify({routines: [{routineId: "coverage", platform: "ios-on-mac", definitionRevision: sha, definition: {id: "coverage", title: "Coverage", platforms: ["ios-on-mac"], execution: {module: "routine.ts", export: "createRoutine"}}}]})),
  {select: async () => ({archive: {url: "https://example.com/mac.zip", sha256: digest}})});
 const match = block.text.text.match(/<(https:[^|]+)\|Results for this exact build>/)!;
 expect(readTestRunListScope(new URL(match[1]).search)).toEqual({repository: "Mentra-Community/MentraOS", channel: "dev", headSha: sha, archiveSha256: digest, routineId: "coverage", platform: "ios-on-mac"});
});

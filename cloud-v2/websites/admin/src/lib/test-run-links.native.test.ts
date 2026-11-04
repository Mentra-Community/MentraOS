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

test("Admin media links use the shared nested asset identity and encode it as one route parameter", () => {
 const id = "setup-evidence/commands/result.json";
 expect(testRunAssetPath("local:one", id)).toBe("/api/admin/test-runs/local%3Aone/assets/setup-evidence%2Fcommands%2Fresult.json");
 for (const bad of ["../file", "a/../file", "a//file", "a%2Ffile", "a\\file", "a".repeat(501)])
  expect(() => testRunAssetPath("local:one", bad)).toThrow();
});

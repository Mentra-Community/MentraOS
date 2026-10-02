import {expect, test} from "bun:test";
import {readTestRunLink, testRunAssetPath} from "./test-run-links";
test("native identities survive query links and encoded asset paths", () => {
 const id = "local:run." + "a".repeat(200);
 expect(readTestRunLink(new URLSearchParams({testRun: id}).toString())?.runID).toBe(id);
 expect(testRunAssetPath(id, "capture.part:1")).toContain(encodeURIComponent(id));
 for (const bad of ["../run", "run/path", "run%2fpath"]) {
  expect(readTestRunLink(new URLSearchParams({testRun: bad}).toString())).toBeNull();
  expect(() => testRunAssetPath(bad, "capture")).toThrow();
 }
});

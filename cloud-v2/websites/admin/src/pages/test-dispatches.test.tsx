import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { testBuildInventoryPath, TestDispatchStatus } from "./test-dispatches";
import type { TestDispatchView } from "../../../../packages/core/src/types/test-dispatch.types";

test("inventory distinguishes PR and release selectors and rejects unsafe input", () => {
  expect(testBuildInventoryPath("pr", "4148")).toBe("/api/admin/test-builds?channel=pr&pr=4148");
  expect(testBuildInventoryPath("staging", "ignored")).toBe("/api/admin/test-builds?channel=staging");
  expect(testBuildInventoryPath("dev", "")).toBe("/api/admin/test-builds?channel=dev");
  expect(testBuildInventoryPath("pr", "4148", "no-glasses-android")).toBe("/api/admin/test-builds?channel=pr&pr=4148&routineId=no-glasses-android");
  expect(testBuildInventoryPath("staging", "", "no-glasses-android")).toBe("/api/admin/test-builds?channel=staging&routineId=no-glasses-android");
  for (const value of ["-1", "0", "1&ref=main", "9999999999999999999999"])
    expect(() => testBuildInventoryPath("pr", value)).toThrow("positive PR");
  expect(() => testBuildInventoryPath("main", "")).toThrow("channel");
});
const view: TestDispatchView = {
  dispatchId: "synthetic", input: { source: { channel: "pr", prNumber: 1, buildRunId: 1, publicationAttempt: 1 },
    routineId: "no-glasses", archiveSha256: "a".repeat(64), idempotencyKey: "synthetic" },
  requestedBy: "synthetic@example.test", createdAt: "2026-09-23T00:00:00Z", sendState: "accepted", state: "queued", message: "Waiting for worker",
};
test("queued is visibly distinct from a test verdict and final failed verdict is preserved", () => {
  const queued = renderToStaticMarkup(<TestDispatchStatus dispatch={view} onResult={() => {}} />);
  expect(queued).toContain("queued"); expect(queued).not.toContain("Test result:"); expect(queued).not.toContain("passed");
  const failed = renderToStaticMarkup(<TestDispatchStatus dispatch={{ ...view, state: "finished", result: {
    runId: "synthetic-result", outcome: "failed", outcomes: { test: "failed", teardown: "passed", evidence: "incomplete" }, reportPath: "/?testRun=synthetic-result",
  } }} onResult={() => {}} />);
  expect(failed).toContain("<strong>failed</strong>"); expect(failed).toContain("evidence: incomplete"); expect(failed).toContain("View recording and evidence");
});

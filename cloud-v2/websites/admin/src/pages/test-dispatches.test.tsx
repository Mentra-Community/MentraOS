import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { canRequestRoutine, TestBuildOption, testBuildInventoryPath, TestDispatchStatus } from "./test-dispatches";
import type { TestBuild, TestDispatchView } from "../../../../packages/core/src/types/test-dispatch.types";

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

// Synthetic inventory fixtures only; they do not describe real published builds.
const published: TestBuild = {
  source: { channel: "staging", buildRunId: 11, publicationAttempt: 2 }, platform: "android", title: "Synthetic staging build",
  headSha: "f".repeat(40), buildUrl: "https://github.com/example/synthetic/actions/runs/11", createdAt: "2026-09-25T00:00:00Z",
  availability: "available", archive: { name: "synthetic.apk", sha256: "e".repeat(64), size: 1 },
  routines: [{ id: "no-glasses-android", available: true }, { id: "no-glasses", available: false, reason: "Build is for Android" }],
};
const building: TestBuild = { ...published, source: { ...published.source, buildRunId: 12 }, availability: "unavailable", reason: "Build is still running", archive: undefined };
const option = (build: TestBuild, locked = false) =>
  renderToStaticMarkup(<TestBuildOption build={build} checked={false} locked={locked} onSelect={() => {}} />);
const radio = (markup: string) => markup.match(/<input[^>]*type="radio"[^>]*>/)![0];
const describedText = (markup: string) => {
  const id = radio(markup).match(/aria-describedby="([^"]+)"/)![1];
  return markup.match(new RegExp(`<span id="${id}"[^>]*>(.*?)</span>`))![1];
};

test("a published build is selectable and names its artifact, identity and GitHub run", () => {
  const markup = option(published);
  expect(radio(markup)).not.toContain("disabled");
  expect(markup).toContain(">Published<");
  expect(describedText(markup)).toBe("Android APK published; the request workflow completes validation");
  expect(markup).toContain(`SHA256 ${"e".repeat(64)}`);
  expect(markup).toContain("f".repeat(12));
  expect(markup).toContain('href="https://github.com/example/synthetic/actions/runs/11"');
  expect(radio(option(published, true))).toContain("disabled");
});

test("an unavailable build is disabled and its control is described by the visible reason", () => {
  const markup = option(building);
  expect(radio(markup)).toContain('disabled=""');
  expect(markup).toContain(">Not selectable<");
  expect(markup).not.toContain(">Published<");
  expect(describedText(markup)).toBe("Unavailable: Build is still running");
  expect(markup).toContain('href="https://github.com/example/synthetic/actions/runs/11"');
  const unknown = option({ ...building, reason: undefined });
  expect(describedText(unknown)).toBe("Unavailable: no published artifact is available for this build");
  const missingArchive = option({ ...published, archive: undefined });
  expect(radio(missingArchive)).toContain('disabled=""');
  expect(describedText(missingArchive)).toContain("Unavailable:");
});

test("a routine can be requested only for a selected published build compatible with it", () => {
  expect(canRequestRoutine(published, "no-glasses-android")).toBe(true);
  expect(canRequestRoutine(published, "no-glasses")).toBe(false);
  expect(canRequestRoutine(published, "mentra-call")).toBe(false);
  expect(canRequestRoutine(undefined, "no-glasses-android")).toBe(false);
  expect(canRequestRoutine(building, "no-glasses-android")).toBe(false);
  expect(canRequestRoutine({ ...published, archive: undefined }, "no-glasses-android")).toBe(false);
});

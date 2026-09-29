import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { TestHostHistory, TestHostLatest } from "../../../../packages/core/src/types/test-host-health.types";
import { CleanupEvents, componentHealth, DiskHistoryChart, diskSegments } from "./system-health";

const now = Date.parse("2026-09-29T00:00:00Z"), at = (offset: number) => new Date(now + offset).toISOString();
const host: TestHostLatest = { schemaVersion: 1, hostId: "test-mini", sampleId: "sample", sampledAt: at(0), receivedAt: at(0), freeBytes: 19 * 1024 ** 3,
  components: [], cleanupEvents: [] };
describe("system health presentation", () => {
  test("independent fresh host reporting can show paused/blocked components without claiming the computer is offline", () => {
    expect(componentHealth(host, { component: "general-worker", enabled: true, state: "stopped", reason: "operator-drained" }, now).label).toBe("Intentionally stopped");
    expect(componentHealth(host, { component: "disk-cleanup", enabled: true, state: "blocked", reason: "permission-denied" }, now)).toMatchObject({ label: "Blocked", tone: "blocked" });
    expect(componentHealth(host, { component: "disk-cleanup", enabled: true, state: "scheduled", reason: "none" }, now).label).toBe("Scheduled");
    expect(componentHealth(host, { component: "disk-cleanup", enabled: true, state: "blocked", reason: "budget-limited" }, now)).toMatchObject({ label: "Pass time limit reached", tone: "blocked" });
    expect(componentHealth(host, undefined, now).label).toBe("Not reported");
    expect(componentHealth(host, { component: "general-worker", enabled: true, state: "running", reason: "none" }, now + 180_001).label).toBe("No recent report");
    expect(componentHealth(host, { component: "general-worker", enabled: true, state: "running", reason: "none" }, now, true).tone).toBe("unknown");
  });
  test("missing samples and unavailable stat split the plot; no interpolation, synthetic zero, or untimed receipt measurement", () => {
    const points = [0, 60_000, 400_000, 460_000, 520_000].map((offset, index) => ({ sampleId: String(index), sampledAt: at(offset), freeBytes: index === 3 ? null : (25 - index) * 1024 ** 3 }));
    expect(diskSegments(points, 180_000).map(segment => segment.map(point => point.sampleId))).toEqual([["0", "1"], ["2"], ["4"]]);
    expect(diskSegments([points[0], { ...points[1], sampledAt: at(120_000) }], 90_000)).toHaveLength(2);
    const history: TestHostHistory = { hostId: host.hostId, generatedAt: at(600_000), from: at(-86_400_000), to: at(600_000), points,
      cleanupEvents: [], truncated: false, thresholdBytes: 20 * 1024 ** 3, gapAfterMs: 180_000 };
    const markup = renderToStaticMarkup(createElement(DiskHistoryChart, { history }));
    expect((markup.match(/<polyline/g) ?? []).length).toBe(3);
    expect(markup).toContain("20 GiB headroom target"); expect(markup).toContain("not a recording or readiness gate");
    expect(markup).not.toContain("recording margin"); expect(markup).toContain("Gaps are missing measurements");
    expect(renderToStaticMarkup(createElement(DiskHistoryChart, { history: { ...history, points: [] } }))).toContain("No disk measurements in this period");
  });
  test("unknown-origin partial cleanup explains its time limit without claiming a scheduled success", () => {
    const markup = renderToStaticMarkup(createElement(CleanupEvents, { events: [{ receiptId: "legacy", receiptSha256: "a".repeat(64),
      origin: "unknown", startedAt: at(-60_000), finishedAt: null, status: "refused", reason: "budget-limited", removedCount: 2,
      freeBefore: 20 * 1024 ** 3, freeAfter: 22 * 1024 ** 3, freeAfterSampledAt: null }] }));
    expect(markup).toContain("unknown"); expect(markup).toContain("refused"); expect(markup).toContain("2 items removed");
    expect(markup).toContain("Pass time limit reached; remaining work was deferred."); expect(markup).not.toContain("next scheduled pass");
  });
  test("an overlapping cleanup is shown as skipped without a custody or budget warning", () => {
    const events: TestHostHistory["cleanupEvents"] = [{ receiptId: "overlap", receiptSha256: "b".repeat(64),
      origin: "scheduled", startedAt: at(-60_000), finishedAt: at(-59_000), status: "already-running", reason: "none", removedCount: 0,
      freeBefore: null, freeAfter: null, freeAfterSampledAt: null }];
    const markup = renderToStaticMarkup(createElement(CleanupEvents, { events }));
    expect(markup).toContain("Skipped: another cleanup was running"); expect(markup).toContain("0 items removed");
    expect(markup).not.toContain("holding this worker"); expect(markup).not.toContain("Pass time limit reached");
    const history: TestHostHistory = { hostId: host.hostId, generatedAt: at(0), from: at(-120_000), to: at(0), points: [],
      cleanupEvents: events, truncated: false, thresholdBytes: 20 * 1024 ** 3, gapAfterMs: 90_000 };
    expect(renderToStaticMarkup(createElement(DiskHistoryChart, { history }))).toContain("Skipped: another cleanup was running");
  });
});

import { describe, expect, spyOn, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { TestHostHistory, TestHostLatest } from "../../../../packages/core/src/types/test-host-health.types";
import { CleanupEvents, componentHealth, DiskHistoryChart, diskSegments, MemoryHealth, SystemHealthPage, SystemHealthSummary } from "./system-health";

const now = Date.parse("2026-09-29T00:00:00Z"), at = (offset: number) => new Date(now + offset).toISOString();
const host: TestHostLatest = { schemaVersion: 1, hostId: "test-mini", sampleId: "sample", sampledAt: at(0), receivedAt: at(0), freeBytes: 19 * 1024 ** 3,
  components: [], cleanupEvents: [] };
describe("system health presentation", () => {
  test("last-observed age uses hours for stale host reports", () => {
    const clock = spyOn(Date, "now").mockReturnValue(now);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    try {
      client.setQueryData(["test-host-health"], { hosts: [{ ...host, sampledAt: at(-3_723_000), receivedAt: at(-3_723_000) }] });
      const markup = renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(SystemHealthPage)));
      expect(markup).toContain("Last observed 1h 02m 03s ago");
      expect(markup).toContain("Stale · no recent report");
    } finally {
      client.clear();
      clock.mockRestore();
    }
  });
  test("memory pressure remains independent of usage and swap; missing or stale readings are explicit", () => {
    const memory = { totalBytes: 8 * 1024 ** 3, usedBytes: 7 * 1024 ** 3, compressedBytes: 1.136 * 1024 ** 3,
      swapUsedBytes: 4.395 * 1024 ** 3, pressureFreePercent: 61, pressure: "normal" as const };
    const render = (value: TestHostLatest, clock = now, unavailable = false) => renderToStaticMarkup(createElement(MemoryHealth, { host: value, now: clock, unavailable }));
    const current = render({ ...host, memory });
    expect(current).toContain("Normal pressure"); expect(current).toContain("7.0 GiB / 8.0 GiB");
    expect(current).toContain("1.1 GiB"); expect(current).toContain("4.4 GiB"); expect(current).toContain("61%");
    expect(current).toContain("not inferred from raw free pages");
    expect(render(host)).toContain("Pressure unavailable"); expect(render(host)).toContain("Unavailable / Unavailable");
    expect(render({ ...host, memory: { ...memory, pressure: null, usedBytes: null } })).toContain("Pressure unavailable");
    for (const stale of [render({ ...host, memory }, now + 180_001), render({ ...host, memory }, now, true)]) {
      expect(stale).toContain("current pressure unavailable"); expect(stale).toContain("not current"); expect(stale).not.toContain("Normal pressure");
    }
    expect(render({ ...host, memory: { ...memory, pressure: "critical" } })).toContain("Critical pressure");
  });
  test("each memory metric uses only its real samples and keeps gaps independent of disk measurements", () => {
    const memory = { totalBytes: 8 * 1024 ** 3, usedBytes: 5 * 1024 ** 3, compressedBytes: 1024 ** 3,
      swapUsedBytes: 0, pressureFreePercent: 61, pressure: "normal" as const };
    const points = [0, 60_000, 120_000, 400_000].map((offset, index) => ({ sampleId: String(index), sampledAt: at(offset),
      freeBytes: index === 0 ? null : 25 * 1024 ** 3, ...(index === 1 ? {} : { memory }) }));
    expect(diskSegments(points, 90_000, "used").map(segment => segment.map(point => point.sampleId))).toEqual([["0"], ["2"], ["3"]]);
    const history: TestHostHistory = { hostId: host.hostId, generatedAt: at(400_000), from: at(-86_400_000), to: at(400_000), points,
      cleanupEvents: [], truncated: false, thresholdBytes: 5 * 1024 ** 3, gapAfterMs: 90_000 };
    const used = renderToStaticMarkup(createElement(DiskHistoryChart, { history, metric: "used" }));
    expect(used).toContain("Used RAM over time"); expect(used).toContain("Pressure: normal"); expect(used).not.toContain("recorder minimum");
    const availability = renderToStaticMarkup(createElement(DiskHistoryChart, { history, metric: "availability" }));
    expect(availability).toContain("61%"); expect(availability).toContain("100%"); expect(availability).not.toContain("GiB");
    const legacy = renderToStaticMarkup(createElement(DiskHistoryChart, { history: { ...history, points: [{ ...points[1] }] }, metric: "used" }));
    expect(legacy).toContain("No used ram measurements in this period"); expect(legacy).not.toContain("<polyline");
  });
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
    expect(markup).toContain("5 GiB recorder minimum"); expect(markup).toContain("Free space alone does not establish routine readiness");
    expect(markup).toContain('y1="152.6" y2="152.6" stroke="#b57729"'); // 5 GiB, including an older Core response with thresholdBytes=20 GiB.
    expect(markup).toContain("trigger below 30 GiB, target 35 GiB"); expect(markup).not.toContain("20 GiB");
    expect(markup).not.toContain("recording margin"); expect(markup).toContain("Gaps are missing measurements");
    expect(renderToStaticMarkup(createElement(DiskHistoryChart, { history: { ...history, points: [] } }))).toContain("No disk measurements in this period");
  });
  test("only free space below the 5 GiB recorder minimum receives the low-space summary and color", () => {
    for (const gib of [4.9, 5, 7.3, 19]) {
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const at = new Date().toISOString();
      client.setQueryData(["test-host-health"], { hosts: [{ ...host, freeBytes: gib * 1024 ** 3, sampledAt: at, receivedAt: at }] });
      const render = (page: typeof SystemHealthPage | typeof SystemHealthSummary) => renderToStaticMarkup(
        createElement(QueryClientProvider, { client }, createElement(page)));
      const summary = render(SystemHealthSummary), page = render(SystemHealthPage);
      expect(summary.includes("below 5 GiB recorder minimum")).toBe(gib < 5);
      expect(page.includes('text-2xl font-semibold text-[#a64235]')).toBe(gib < 5);
      expect(summary).not.toContain("20 GiB");
      client.clear();
    }
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

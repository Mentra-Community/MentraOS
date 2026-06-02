import { describe, expect, test } from "bun:test";
import {
  collectLogEntries,
  filterLogEntries,
  formatLogLines,
} from "../src/utils/incident-filter.ts";
import type { IncidentLogs } from "../src/http/agent-client.ts";

const sampleLogs: IncidentLogs = {
  incidentId: "abc",
  createdAt: "2026-01-01",
  feedback: {},
  phoneState: {},
  phoneLogs: [
    { timestamp: 1, level: "error", message: "BLE disconnect" },
    { timestamp: 2, level: "info", message: "reconnected" },
  ],
  cloudLogs: [{ timestamp: 3, level: "warn", message: "high latency" }],
  glassesLogs: [],
  glassesFirmwareLogs: [],
  appTelemetryLogs: {
    "com.example.app": [{ timestamp: 4, level: "debug", message: "tick" }],
  },
};

describe("incident-filter", () => {
  test("collectLogEntries filters by type", () => {
    const phone = collectLogEntries(sampleLogs, "phone");
    expect(phone).toHaveLength(2);
    const apps = collectLogEntries(sampleLogs, "apps", "com.example");
    expect(apps).toHaveLength(1);
  });

  test("filterLogEntries applies level and grep", () => {
    const collected = collectLogEntries(sampleLogs, "all");
    const { entries } = filterLogEntries(collected, {
      level: "warn",
      grep: "disconnect",
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].message).toContain("disconnect");
  });

  test("filterLogEntries truncates to most recent entries", () => {
    const collected = collectLogEntries(sampleLogs, "all");
    const { entries, truncated } = filterLogEntries(collected, { limit: 2 });
    expect(entries).toHaveLength(2);
    expect(truncated).toBe(true);
    expect(entries[0].message).toContain("high latency");
    expect(entries[1].message).toContain("tick");
  });

  test("formatLogLines", () => {
    const collected = collectLogEntries(sampleLogs, "phone");
    const text = formatLogLines(collected);
    expect(text).toContain("[phone]");
    expect(text).toContain("BLE disconnect");
  });
});

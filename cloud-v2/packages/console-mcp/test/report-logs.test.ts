import { describe, expect, test } from "bun:test";
import type { ReportArtifactMeta } from "../src/http/admin-reports-client";
import {
  filterLogEntries,
  formatLogLines,
  mergeLogBundles,
  parseLogBundle,
} from "../src/utils/report-logs";

function artifact(source: string): ReportArtifactMeta {
  return {
    artifactId: `art_${source}`,
    type: "logs",
    source,
    filename: null,
    contentType: "application/json",
    sizeBytes: null,
    createdAt: null,
  };
}

function encode(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

describe("parseLogBundle", () => {
  test("parses the canonical {entries: [...]} envelope", () => {
    const entries = parseLogBundle(
      encode({ entries: [{ timestamp: 1, level: "info", message: "hi" }] }),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].message).toBe("hi");
  });

  test("tolerates a bare array", () => {
    const entries = parseLogBundle(encode([{ timestamp: 1, level: "info", message: "hi" }]));
    expect(entries).toHaveLength(1);
  });

  test("drops entries without a message", () => {
    const entries = parseLogBundle(encode({ entries: [{ timestamp: 1 }, null, "x"] }));
    expect(entries).toHaveLength(0);
  });

  test("rejects non-JSON payloads", () => {
    expect(() => parseLogBundle(new TextEncoder().encode("PNG..."))).toThrow(/not valid JSON/);
  });

  test("rejects JSON without an entries array", () => {
    expect(() => parseLogBundle(encode({ phoneLogs: [] }))).toThrow(/no "entries" array/);
  });
});

describe("mergeLogBundles", () => {
  test("tags entries with the artifact source and sorts by timestamp", () => {
    const merged = mergeLogBundles([
      {
        artifact: artifact("phone"),
        entries: [
          { timestamp: 30, level: "info", message: "phone-late" },
          { timestamp: 10, level: "info", message: "phone-early" },
        ],
      },
      {
        artifact: artifact("glasses"),
        entries: [{ timestamp: 20, level: "warn", message: "glasses-mid" }],
      },
    ]);
    expect(merged.map((e) => e.message)).toEqual(["phone-early", "glasses-mid", "phone-late"]);
    expect(merged.map((e) => e.origin)).toEqual(["phone", "glasses", "phone"]);
  });

  test("sorts ISO string timestamps alongside numeric ones", () => {
    const merged = mergeLogBundles([
      {
        artifact: artifact("phone"),
        entries: [
          { timestamp: "2026-01-01T00:00:01.000Z", level: "info", message: "second" },
          { timestamp: Date.parse("2026-01-01T00:00:00.000Z"), level: "info", message: "first" },
        ],
      },
    ]);
    expect(merged.map((e) => e.message)).toEqual(["first", "second"]);
  });
});

describe("filterLogEntries", () => {
  const entries = mergeLogBundles([
    {
      artifact: artifact("phone"),
      entries: [
        { timestamp: 1, level: "debug", message: "dbg" },
        { timestamp: 2, level: "info", message: "connecting to glasses" },
        { timestamp: 3, level: "warn", message: "retry" },
        { timestamp: 4, level: "error", message: "BLE write failed" },
      ],
    },
  ]);

  test("level keeps that severity and above", () => {
    const { entries: filtered } = filterLogEntries(entries, { level: "warn" });
    expect(filtered.map((e) => e.level)).toEqual(["warn", "error"]);
  });

  test("grep is a case-insensitive substring match", () => {
    const { entries: filtered } = filterLogEntries(entries, { grep: "ble WRITE" });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].message).toBe("BLE write failed");
  });

  test("limit keeps the newest entries and flags truncation", () => {
    const { entries: filtered, truncated } = filterLogEntries(entries, { limit: 2 });
    expect(truncated).toBe(true);
    expect(filtered.map((e) => e.message)).toEqual(["retry", "BLE write failed"]);
  });

  test("unknown levels are treated as debug", () => {
    const withOdd = mergeLogBundles([
      {
        artifact: artifact("glasses"),
        entries: [{ timestamp: 1, level: "TRACE", message: "odd" }],
      },
    ]);
    expect(filterLogEntries(withOdd, { level: "info" }).entries).toHaveLength(0);
    expect(filterLogEntries(withOdd, { level: "debug" }).entries).toHaveLength(1);
  });
});

describe("formatLogLines", () => {
  test("renders ISO timestamp, origin, level, and message", () => {
    const lines = formatLogLines(
      mergeLogBundles([
        {
          artifact: artifact("phone"),
          entries: [{ timestamp: 0, level: "info", message: "boot" }],
        },
      ]),
    );
    expect(lines).toBe("[1970-01-01T00:00:00.000Z] [phone] [info] boot");
  });

  test("appends the per-entry source when it differs from the origin", () => {
    const lines = formatLogLines(
      mergeLogBundles([
        {
          artifact: artifact("phone"),
          entries: [{ timestamp: 0, level: "warn", message: "m", source: "console" }],
        },
      ]),
    );
    expect(lines).toContain("[phone:console]");
  });
});

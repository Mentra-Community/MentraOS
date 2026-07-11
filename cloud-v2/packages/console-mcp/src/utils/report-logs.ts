/**
 * Parsing, merging, filtering, and formatting for report "logs" artifacts.
 *
 * Each logs artifact blob is `{entries: [{timestamp, level, message, source?}]}`
 * as serialized by report.service.ts (addLogArtifact). The artifact-level
 * `source` says which device uploaded the bundle ("phone", glasses firmware
 * values); the optional per-entry `source` is a finer origin within that
 * device (e.g. "console").
 */

import type { ReportArtifactMeta, ReportLogEntry } from "../http/admin-reports-client";

const LEVEL_PRIORITY: Record<string, number> = { error: 0, warn: 1, info: 2, debug: 3 };

export type MergedLogEntry = ReportLogEntry & { origin: string };

export interface FilterLogsOptions {
  level?: string;
  grep?: string;
  limit?: number;
}

/**
 * Parse one logs-artifact payload. Accepts the canonical `{entries: [...]}`
 * envelope and tolerates a bare array; anything else is a hard error so a
 * mislabeled artifact doesn't silently read as empty.
 */
export function parseLogBundle(bytes: Uint8Array): ReportLogEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("logs artifact payload is not valid JSON");
  }
  const entries = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as { entries?: unknown }).entries)
      ? (parsed as { entries: unknown[] }).entries
      : null;
  if (!entries) {
    throw new Error('logs artifact payload has no "entries" array');
  }
  return entries.filter(
    (e): e is ReportLogEntry =>
      typeof e === "object" && e !== null && "message" in e,
  );
}

/** Merge bundles from several artifacts into one timestamp-ordered stream. */
export function mergeLogBundles(
  bundles: { artifact: ReportArtifactMeta; entries: ReportLogEntry[] }[],
): MergedLogEntry[] {
  const merged: MergedLogEntry[] = [];
  for (const { artifact, entries } of bundles) {
    for (const entry of entries) {
      merged.push({ ...entry, origin: artifact.source });
    }
  }
  merged.sort((a, b) => entryTime(a) - entryTime(b));
  return merged;
}

export function filterLogEntries(
  entries: MergedLogEntry[],
  options: FilterLogsOptions,
): { entries: MergedLogEntry[]; truncated: boolean } {
  let filtered = entries;

  const levelFilter = options.level?.toLowerCase();
  if (levelFilter) {
    const minPriority = LEVEL_PRIORITY[levelFilter] ?? 3;
    filtered = filtered.filter(
      (e) => (LEVEL_PRIORITY[e.level?.toLowerCase()] ?? 3) <= minPriority,
    );
  }

  const grepPattern = options.grep?.toLowerCase();
  if (grepPattern) {
    filtered = filtered.filter((e) => e.message?.toLowerCase().includes(grepPattern));
  }

  const limit = options.limit ?? 200;
  const truncated = filtered.length > limit;
  return { entries: filtered.slice(-limit), truncated };
}

export function formatLogLines(entries: MergedLogEntry[]): string {
  return entries
    .map((e) => {
      const origin = e.source && e.source !== e.origin ? `${e.origin}:${e.source}` : e.origin;
      return `[${formatTime(e)}] [${origin}] [${e.level}] ${e.message}`;
    })
    .join("\n");
}

/** Epoch millis, or null when the timestamp is unparseable or out of Date range. */
function rawTime(entry: ReportLogEntry): number | null {
  const t =
    typeof entry.timestamp === "number" ? entry.timestamp : new Date(entry.timestamp).getTime();
  return Number.isFinite(t) && Math.abs(t) <= 8.64e15 ? t : null;
}

function entryTime(entry: ReportLogEntry): number {
  return rawTime(entry) ?? 0;
}

function formatTime(entry: ReportLogEntry): string {
  const t = rawTime(entry);
  return t !== null ? new Date(t).toISOString() : String(entry.timestamp);
}

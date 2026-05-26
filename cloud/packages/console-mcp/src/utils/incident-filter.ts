import type { IncidentLogs, LogEntry } from "../http/agent-client.ts";

export type LogType = "phone" | "cloud" | "glasses" | "firmware" | "apps" | "all";

const VALID_TYPES: LogType[] = ["phone", "cloud", "glasses", "firmware", "apps", "all"];
const LEVEL_PRIORITY: Record<string, number> = { error: 0, warn: 1, info: 2, debug: 3 };

export interface FilterLogsOptions {
  logType?: LogType;
  appPackage?: string;
  level?: string;
  grep?: string;
  limit?: number;
}

export type LogEntryWithSource = LogEntry & { _source: string };

export function collectLogEntries(
  data: IncidentLogs,
  logType: LogType = "all",
  appFilter?: string,
): LogEntryWithSource[] {
  let entries: LogEntryWithSource[] = [];

  if (logType === "all" || logType === "phone") {
    entries.push(...(data.phoneLogs || []).map((e) => ({ ...e, _source: "phone" })));
  }
  if (logType === "all" || logType === "cloud") {
    entries.push(...(data.cloudLogs || []).map((e) => ({ ...e, _source: "cloud" })));
  }
  if (logType === "all" || logType === "glasses") {
    entries.push(...(data.glassesLogs || []).map((e) => ({ ...e, _source: "glasses" })));
  }
  if (logType === "all" || logType === "firmware") {
    entries.push(
      ...(data.glassesFirmwareLogs || []).map((e) => ({ ...e, _source: "firmware" })),
    );
  }
  if (logType === "all" || logType === "apps") {
    for (const [pkg, logs] of Object.entries(data.appTelemetryLogs || {})) {
      if (appFilter && !pkg.includes(appFilter)) continue;
      entries.push(...logs.map((e) => ({ ...e, _source: `app:${pkg}` })));
    }
  }

  entries.sort((a, b) => {
    const ta = typeof a.timestamp === "number" ? a.timestamp : new Date(a.timestamp).getTime();
    const tb = typeof b.timestamp === "number" ? b.timestamp : new Date(b.timestamp).getTime();
    return ta - tb;
  });

  return entries;
}

export function filterLogEntries(
  entries: LogEntryWithSource[],
  options: FilterLogsOptions,
): { entries: LogEntryWithSource[]; truncated: boolean } {
  const logType = options.logType || "all";
  if (!VALID_TYPES.includes(logType)) {
    throw new Error(`Invalid log type "${logType}". Valid: ${VALID_TYPES.join(", ")}`);
  }

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

export function formatLogLines(entries: LogEntryWithSource[]): string {
  return entries
    .map((e) => {
      const ts =
        typeof e.timestamp === "number"
          ? new Date(e.timestamp).toISOString()
          : String(e.timestamp);
      return `[${ts}] [${e._source}] [${e.level}] ${e.message}`;
    })
    .join("\n");
}

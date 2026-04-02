import { createClient, resolveConfig, resolveIncidentId, type LogEntry } from "../client";
import { formatLogLines } from "../format";

type LogType = "phone" | "cloud" | "glasses" | "firmware" | "apps" | "all";

const VALID_TYPES: LogType[] = ["phone", "cloud", "glasses", "firmware", "apps", "all"];
const VALID_LEVELS = ["error", "warn", "info", "debug"];

const USAGE = `
Usage: bun run incidents logs <id> [options]

Arguments:
  id                Incident ID (full UUID or first 8 chars)

Options:
  --type <type>     Log type: phone, cloud, glasses, firmware, apps, all (default: all)
  --app <package>   Filter app telemetry by package name
  --level <level>   Filter by minimum level: error, warn, info, debug
  --grep <pattern>  Search log messages (case-insensitive substring)
  --limit <n>       Max entries to display (default: 200)
  --json            Output raw JSON
  --help            Show this help
`.trim();

export async function logsCommand(args: string[], flags: Record<string, string | boolean>) {
  if (flags.help) {
    console.log(USAGE);
    return;
  }

  const shortId = args[0];
  if (!shortId) {
    console.error("Error: incident ID required.\n");
    console.log(USAGE);
    process.exit(1);
  }

  const logType = String(flags.type || "all") as LogType;
  if (!VALID_TYPES.includes(logType)) {
    console.error(`Error: invalid log type "${logType}". Valid: ${VALID_TYPES.join(", ")}`);
    process.exit(1);
  }

  const levelFilter = flags.level ? String(flags.level).toLowerCase() : null;
  if (levelFilter && !VALID_LEVELS.includes(levelFilter)) {
    console.error(`Error: invalid level "${levelFilter}". Valid: ${VALID_LEVELS.join(", ")}`);
    process.exit(1);
  }

  const grepPattern = flags.grep ? String(flags.grep).toLowerCase() : null;
  const appFilter = flags.app ? String(flags.app) : null;
  const limit = parseInt(String(flags.limit || "200"), 10);

  const client = createClient(resolveConfig());
  const fullId = await resolveIncidentId(client, shortId);
  const res = await client.getIncidentLogs(fullId);
  const data = res.data;

  // Collect logs based on --type
  let entries: Array<LogEntry & { _source: string }> = [];

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
    entries.push(...(data.glassesFirmwareLogs || []).map((e) => ({ ...e, _source: "firmware" })));
  }
  if (logType === "all" || logType === "apps") {
    for (const [pkg, logs] of Object.entries(data.appTelemetryLogs || {})) {
      if (appFilter && !pkg.includes(appFilter)) continue;
      entries.push(...logs.map((e) => ({ ...e, _source: `app:${pkg}` })));
    }
  }

  // Sort by timestamp (ascending — oldest first)
  entries.sort((a, b) => {
    const ta = typeof a.timestamp === "number" ? a.timestamp : new Date(a.timestamp).getTime();
    const tb = typeof b.timestamp === "number" ? b.timestamp : new Date(b.timestamp).getTime();
    return ta - tb;
  });

  // Apply level filter (--level warn means "show warn and above")
  if (levelFilter) {
    const levelPriority: Record<string, number> = { error: 0, warn: 1, info: 2, debug: 3 };
    const minPriority = levelPriority[levelFilter] ?? 3;
    entries = entries.filter((e) => (levelPriority[e.level?.toLowerCase()] ?? 3) <= minPriority);
  }

  // Apply grep filter (case-insensitive substring match on message)
  if (grepPattern) {
    entries = entries.filter((e) => e.message?.toLowerCase().includes(grepPattern));
  }

  // Apply limit
  const truncated = entries.length > limit;
  entries = entries.slice(0, limit);

  if (flags.json) {
    console.log(JSON.stringify(entries, null, 2));
    return;
  }

  if (entries.length === 0) {
    console.log("No log entries found matching filters.");
    return;
  }

  console.log(formatLogLines(entries));

  if (truncated) {
    console.log(`\n... truncated at ${limit} entries. Use --limit to show more.`);
  }
}

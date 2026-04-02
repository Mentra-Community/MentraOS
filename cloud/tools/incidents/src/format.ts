import type { IncidentMeta, LogEntry, IncidentLogs } from "./client";

// ── ANSI escape codes ──────────────────────────────────────────────────────────

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const GREEN = "\x1b[32m";
const CYAN = "\x1b[36m";
const GRAY = "\x1b[90m";
const WHITE = "\x1b[37m";

function c(color: string, text: string): string {
  return `${color}${text}${RESET}`;
}

// Public color helpers
export const red = (t: string) => c(RED, t);
export const yellow = (t: string) => c(YELLOW, t);
export const green = (t: string) => c(GREEN, t);
export const gray = (t: string) => c(GRAY, t);
export const bold = (t: string) => c(BOLD, t);
export const dim = (t: string) => c(DIM, t);

// ── Helpers ────────────────────────────────────────────────────────────────────

function pad(str: string, width: number): string {
  if (str.length > width) return str.slice(0, width - 1) + "…";
  return str.padEnd(width);
}

function colorStatus(status: string): string {
  switch (status) {
    case "complete":
      return c(GREEN, status);
    case "processing":
      return c(YELLOW, status);
    case "failed":
      return c(RED, status);
    case "partial":
      return c(YELLOW, status);
    default:
      return status;
  }
}

export function formatTimestamp(ts: string | number): string {
  const d = new Date(ts);
  return d.toISOString().replace("T", " ").slice(0, 19);
}

function colorLevel(level: string): string {
  const l = level.toLowerCase();
  const padded = l.padEnd(5);
  switch (l) {
    case "error":
      return c(RED, padded);
    case "warn":
      return c(YELLOW, padded);
    case "info":
      return c(WHITE, padded);
    case "debug":
      return c(GRAY, padded);
    default:
      return c(DIM, padded);
  }
}

// ── formatIncidentTable ────────────────────────────────────────────────────────

export function formatIncidentTable(incidents: IncidentMeta[]): string {
  const header = [pad("ID", 10), pad("Status", 12), pad("User", 28), pad("Summary", 40), pad("Created", 20)].join("  ");

  const separator = "-".repeat(header.length);

  const rows = incidents.map((i) => {
    const shortId = i.incidentId.slice(0, 8);
    const status = colorStatus(i.status);
    const user = pad(i.userId || "—", 28);
    const summary = pad(i.summary || "—", 40);
    const created = pad(formatTimestamp(i.createdAt), 20);
    return [pad(shortId, 10), pad(status, 12), user, summary, created].join("  ");
  });

  return [c(BOLD, header), separator, ...rows].join("\n");
}

// ── formatIncidentDetail ───────────────────────────────────────────────────────

export function formatIncidentDetail(meta: IncidentMeta, logs: IncidentLogs): string {
  const lines: string[] = [];
  const feedback = (logs.feedback || {}) as Record<string, unknown>;
  const phoneState = (logs.phoneState || {}) as Record<string, unknown>;

  // Header
  lines.push(c(BOLD, `Incident ${meta.incidentId}`));
  lines.push("");

  // Status + timestamps
  lines.push(`${c(BOLD, "Status:")}       ${colorStatus(meta.status)}`);
  lines.push(`${c(BOLD, "Created:")}      ${formatTimestamp(meta.createdAt)}`);
  lines.push(`${c(BOLD, "Updated:")}      ${formatTimestamp(meta.updatedAt)}`);
  lines.push(`${c(BOLD, "User:")}         ${meta.userId || "—"}`);

  // LLM Summary
  if (meta.summary) {
    lines.push("");
    lines.push(c(BOLD, "Summary:"));
    lines.push(`  ${meta.summary}`);
  }

  // Feedback (user's bug report)
  if (Object.keys(feedback).length > 0) {
    lines.push("");
    lines.push(c(BOLD, "Feedback:"));

    if (feedback.expectedBehavior) lines.push(`  Expected: ${feedback.expectedBehavior}`);
    if (feedback.actualBehavior) lines.push(`  Actual:   ${feedback.actualBehavior}`);
    if (feedback.severityRating) lines.push(`  Severity: ${feedback.severityRating}/5`);
    if (feedback.additionalContext) lines.push(`  Context:  ${feedback.additionalContext}`);
  }

  // System info from feedback
  const sysInfo = (feedback.systemInfo || {}) as Record<string, unknown>;
  if (Object.keys(sysInfo).length > 0) {
    lines.push("");
    lines.push(c(BOLD, "System Info:"));
    for (const [k, v] of Object.entries(sysInfo)) {
      lines.push(`  ${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`);
    }
  }

  // Phone state snapshot (summarized)
  if (Object.keys(phoneState).length > 0) {
    lines.push("");
    lines.push(c(BOLD, "Phone State:"));
    const keys = Object.keys(phoneState);
    for (const k of keys) {
      const val = phoneState[k];
      if (typeof val === "object" && val !== null) {
        const json = JSON.stringify(val);
        lines.push(`  ${k}: ${json.slice(0, 120)}${json.length > 120 ? "…" : ""}`);
      } else {
        lines.push(`  ${k}: ${val}`);
      }
    }
  }

  // Log counts
  lines.push("");
  lines.push(c(BOLD, "Log Counts:"));
  lines.push(`  Phone:    ${(logs.phoneLogs || []).length}`);
  lines.push(`  Cloud:    ${(logs.cloudLogs || []).length}`);
  lines.push(`  Glasses:  ${(logs.glassesLogs || []).length}`);
  lines.push(`  Firmware: ${(logs.glassesFirmwareLogs || []).length}`);

  const appLogs = logs.appTelemetryLogs || {};
  const appKeys = Object.keys(appLogs);
  if (appKeys.length > 0) {
    lines.push(`  Apps:`);
    for (const pkg of appKeys) {
      lines.push(`    ${pkg}: ${appLogs[pkg].length}`);
    }
  }

  // Attachments
  if (logs.attachments && logs.attachments.length > 0) {
    lines.push("");
    lines.push(c(BOLD, `Attachments (${logs.attachments.length}):`));
    for (const att of logs.attachments) {
      lines.push(`  ${att.filename}`);
    }
  }

  return lines.join("\n");
}

// ── formatLogLines ─────────────────────────────────────────────────────────────

export function formatLogLines(entries: Array<LogEntry & { _source: string }>): string {
  return entries
    .map((e) => {
      const ts = c(GRAY, formatTimestamp(e.timestamp));
      const level = colorLevel(e.level || "info");
      const source = c(CYAN, `[${e._source}]`);
      const msg = e.message || "";
      return `${ts} ${level} ${source} ${msg}`;
    })
    .join("\n");
}

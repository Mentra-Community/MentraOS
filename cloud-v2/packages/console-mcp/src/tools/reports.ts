/**
 * Report triage tools — the Cloud V2 successors of the V1 incident_list /
 * incident_get / incident_get_logs tools, backed by /api/admin/reports.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ConsoleMcpConfig } from "../config";
import {
  createAdminReportsClient,
  type ReportArtifactMeta,
  type ReportLogEntry,
  type ReportSummary,
} from "../http/admin-reports-client";
import { resolveReport } from "../utils/id-resolution";
import {
  filterLogEntries,
  formatLogLines,
  mergeLogBundles,
  parseLogBundle,
} from "../utils/report-logs";
import { textContent, truncate } from "./helpers";

const SUMMARY_MAX_CHARS = 160;
const TEXT_ARTIFACT_MAX_CHARS = 262_144; // 256 KiB of JSON/text into context, truncated beyond
const IMAGE_ARTIFACT_MAX_BYTES = 4_194_304; // 4 MiB screenshot cap for inline image content

export function registerReportTools(server: McpServer, config: ConsoleMcpConfig): void {
  const client = () => createAdminReportsClient(config);

  server.registerTool(
    "report_list",
    {
      description:
        "List recent Cloud V2 bug reports / feedback / automatic reports (admin API), newest first. " +
        "Returns compact rows; set full: true for raw report documents.",
      inputSchema: {
        kind: z.enum(["bug", "feedback", "automatic"]).optional(),
        status: z.enum(["collecting", "ready", "closed"]).optional(),
        limit: z.number().int().min(1).max(200).optional().describe("Default 25, max 200"),
        before: z
          .string()
          .optional()
          .describe("ISO timestamp — only reports created before this (for paging back)"),
        userId: z.string().optional().describe("Client-side filter on mentraUserId after fetch"),
        full: z.boolean().optional().describe("Return raw report documents instead of compact rows"),
      },
    },
    async ({ kind, status, limit = 25, before, userId, full }) => {
      const { reports } = await client().listReports({ kind, status, limit, before });
      const filtered = userId
        ? reports.filter((r) => r.mentraUserId.includes(userId))
        : reports;
      return textContent(full ? filtered : filtered.map(compactReportRow));
    },
  );

  server.registerTool(
    "report_get",
    {
      description:
        "Get one report by full id (rep_...) or short prefix: report document, diagnostic context, " +
        "and artifact/asset metadata (use report_get_logs / report_get_artifact for payloads).",
      inputSchema: {
        reportId: z.string(),
        includeContext: z
          .boolean()
          .optional()
          .describe("Include the phone/glasses diagnostic context snapshot (default true)"),
      },
    },
    async ({ reportId, includeContext = true }) => {
      const { report, assets } = await resolveReport(client(), reportId);
      const doc = includeContext ? report : { ...report, context: "<omitted — includeContext: false>" };
      return textContent({ report: doc, assets });
    },
  );

  server.registerTool(
    "report_get_logs",
    {
      description:
        "Fetch and merge the log bundles attached to a report, oldest first. Defaults to the last 200 " +
        "matching lines. source filters by uploading device (e.g. \"phone\"); level keeps that severity " +
        "and above; grep is a case-insensitive substring match.",
      inputSchema: {
        reportId: z.string(),
        source: z.string().optional().describe('Artifact source, e.g. "phone"'),
        level: z.enum(["error", "warn", "info", "debug"]).optional(),
        grep: z.string().optional(),
        limit: z.number().int().min(1).max(2000).optional(),
        json: z.boolean().optional().describe("Return structured entries instead of text lines"),
      },
    },
    async ({ reportId, source, level, grep, limit, json }) => {
      const reportsClient = client();
      const { report } = await resolveReport(reportsClient, reportId);

      const logArtifacts = report.artifacts.filter(
        (a) => a.type === "logs" && (!source || a.source === source),
      );
      if (logArtifacts.length === 0) {
        return textContent(
          [
            source
              ? `Report ${report.reportId} has no logs artifacts with source "${source}".`
              : `Report ${report.reportId} has no logs artifacts.`,
            report.artifacts.length > 0
              ? `Available artifacts: ${report.artifacts.map(describeArtifact).join(", ")}`
              : "The report has no artifacts at all.",
            report.status === "collecting"
              ? "Status is \"collecting\" — the device may still be uploading artifacts."
              : null,
          ]
            .filter(Boolean)
            .join("\n"),
        );
      }

      // One unreadable bundle must not hide the others — collect what loads,
      // report what didn't.
      const bundles: { artifact: ReportArtifactMeta; entries: ReportLogEntry[] }[] = [];
      const bundleErrors: string[] = [];
      await Promise.all(
        logArtifacts.map(async (artifact) => {
          try {
            const payload = await reportsClient.getArtifact(report.reportId, artifact.artifactId);
            bundles.push({ artifact, entries: parseLogBundle(payload.bytes) });
          } catch (error) {
            bundleErrors.push(
              `${artifact.artifactId} (${artifact.source}): ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }),
      );
      if (bundles.length === 0) {
        throw new Error(`All logs artifacts failed to load:\n${bundleErrors.join("\n")}`);
      }

      const merged = mergeLogBundles(bundles);
      const { entries, truncated } = filterLogEntries(merged, { level, grep, limit: limit ?? 200 });

      if (json) {
        return textContent({
          reportId: report.reportId,
          entries,
          truncated,
          ...(bundleErrors.length > 0 ? { artifactErrors: bundleErrors } : {}),
        });
      }

      let text =
        entries.length === 0 ? "No log entries found matching filters." : formatLogLines(entries);
      if (truncated) {
        text += `\n\n... truncated at ${limit ?? 200} entries. Increase limit to show more.`;
      }
      if (bundleErrors.length > 0) {
        text += `\n\nWARNING: ${bundleErrors.length} logs artifact(s) failed to load:\n${bundleErrors.join("\n")}`;
      }
      return textContent(text);
    },
  );

  server.registerTool(
    "report_get_artifact",
    {
      description:
        "Fetch one artifact payload by artifactId (art_..., listed by report_get). Screenshots return " +
        "as inline images, JSON/text inline as text; anything else (or oversized payloads) returns " +
        "metadata plus a hint to download via scripts/fetch-incident-logs.sh.",
      inputSchema: {
        reportId: z.string(),
        artifactId: z.string(),
      },
    },
    async ({ reportId, artifactId }) => {
      const reportsClient = client();
      const { report } = await resolveReport(reportsClient, reportId);
      const payload = await reportsClient.getArtifact(report.reportId, artifactId);
      const meta = report.artifacts.find((a) => a.artifactId === artifactId);
      const header = `${artifactId} (${meta ? describeArtifact(meta) : payload.contentType}${
        payload.fileName ? `, ${payload.fileName}` : ""
      }, ${payload.bytes.byteLength} bytes)`;

      if (payload.contentType.startsWith("image/")) {
        if (payload.bytes.byteLength > IMAGE_ARTIFACT_MAX_BYTES) {
          return textContent(
            `${header} exceeds the ${IMAGE_ARTIFACT_MAX_BYTES}-byte inline image cap — ` +
              `download it with: ./scripts/fetch-incident-logs.sh ${report.reportId}`,
          );
        }
        return {
          content: [
            { type: "text" as const, text: header },
            {
              type: "image" as const,
              data: Buffer.from(payload.bytes).toString("base64"),
              mimeType: payload.contentType,
            },
          ],
        };
      }

      if (payload.contentType === "application/json" || payload.contentType.startsWith("text/")) {
        const text = new TextDecoder().decode(payload.bytes);
        const body =
          text.length > TEXT_ARTIFACT_MAX_CHARS
            ? `${text.slice(0, TEXT_ARTIFACT_MAX_CHARS)}\n\n... truncated at ${TEXT_ARTIFACT_MAX_CHARS} chars ` +
              `(full download: ./scripts/fetch-incident-logs.sh ${report.reportId})`
            : text;
        return textContent(`${header}\n${body}`);
      }

      return textContent(
        `${header} has binary content type "${payload.contentType}" — ` +
          `download it with: ./scripts/fetch-incident-logs.sh ${report.reportId}`,
      );
    },
  );
}

/** One list row: enough to pick a report without pulling full documents. */
export function compactReportRow(r: ReportSummary): Record<string, unknown> {
  return {
    reportId: r.reportId,
    kind: r.kind,
    status: r.status,
    mentraUserId: r.mentraUserId,
    createdAt: r.createdAt,
    summary: deriveSummary(r),
    trigger: compactTrigger(r.trigger),
    artifacts: r.artifacts.map(describeArtifact),
  };
}

function deriveSummary(r: ReportSummary): string | null {
  if (r.kind === "feedback") {
    // submitReport normalizes string feedback to {message}; fall back to the
    // raw object for structured feedback payloads.
    if (typeof r.feedback === "string") return truncate(r.feedback, SUMMARY_MAX_CHARS);
    if (r.feedback && typeof r.feedback === "object") {
      const message = (r.feedback as Record<string, unknown>).message;
      return truncate(
        typeof message === "string" ? message : JSON.stringify(r.feedback),
        SUMMARY_MAX_CHARS,
      );
    }
    return null;
  }
  const actual = r.report?.actualBehavior;
  return typeof actual === "string" ? truncate(actual, SUMMARY_MAX_CHARS) : null;
}

function compactTrigger(trigger: Record<string, unknown> | null): string | null {
  if (!trigger) return null;
  const parts = [trigger.type, trigger.source, trigger.reason, trigger.sourceAppletPackageName]
    .filter((p): p is string => typeof p === "string" && p.length > 0);
  return parts.length > 0 ? parts.join("/") : null;
}

function describeArtifact(a: ReportArtifactMeta): string {
  const size = a.sizeBytes != null ? ` ${formatSize(a.sizeBytes)}` : "";
  return `${a.type}/${a.source}${size} (${a.artifactId})`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

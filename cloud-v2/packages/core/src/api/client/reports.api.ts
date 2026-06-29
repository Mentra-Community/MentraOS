/**
 * @fileoverview Device-called report endpoints.
 *
 * Primary Cloud V2 report API:
 *   /api/client/reports
 */

import { Hono } from "hono";
import { z } from "zod";
import { userAuth } from "../middleware/user-auth.middleware";
import { InvalidRequest } from "../../types/oauth.types";
import type { AppContext, AppEnv } from "../../types/hono.types";
import {
  addLogArtifact,
  addScreenshotArtifacts,
  markReportReady,
  submitReport,
  type ReportAttachmentInput,
} from "../../services/report.service";

const reportsApp = new Hono<AppEnv>();

const recordSchema = z.record(z.unknown());
const nonEmptyStringSchema = z.string().trim().min(1);
const optionalNonEmptyStringSchema = nonEmptyStringSchema.optional();
const logEntrySchema = z.object({
  timestamp: z.number(),
  level: z.string(),
  message: z.string(),
  source: z.string().optional(),
});
const reportTriggerSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("manual"),
    source: nonEmptyStringSchema,
    reason: nonEmptyStringSchema,
    sourceAppletPackageName: optionalNonEmptyStringSchema,
    sourceAppletName: optionalNonEmptyStringSchema,
  }),
  z.object({
    type: z.literal("automatic"),
    source: nonEmptyStringSchema,
    reason: nonEmptyStringSchema,
    sourceAppletPackageName: optionalNonEmptyStringSchema,
    sourceAppletName: optionalNonEmptyStringSchema,
  }),
]);
const automaticReportTriggerSchema = z.object({
  type: z.literal("automatic"),
  source: nonEmptyStringSchema,
  reason: nonEmptyStringSchema,
  sourceAppletPackageName: optionalNonEmptyStringSchema,
  sourceAppletName: optionalNonEmptyStringSchema,
});
const reportDetailsSchema = z.object({
  actualBehavior: nonEmptyStringSchema,
  expectedBehavior: optionalNonEmptyStringSchema,
  userSeverity: z.union([
    z.literal(1),
    z.literal(2),
    z.literal(3),
    z.literal(4),
    z.literal(5),
  ]).optional(),
  systemPriority: z.enum(["low", "medium", "high", "critical"]).optional(),
  contactEmail: z.string().email().optional(),
}).passthrough();
const submitReportSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("bug"),
    trigger: reportTriggerSchema,
    report: reportDetailsSchema,
    context: recordSchema,
  }),
  z.object({
    kind: z.literal("automatic"),
    trigger: automaticReportTriggerSchema,
    report: reportDetailsSchema,
    context: recordSchema,
  }),
  z.object({
    kind: z.literal("feedback"),
    feedback: z.union([z.string(), recordSchema]),
    context: recordSchema,
  }),
]);
const logsArtifactSchema = z.object({
  type: z.literal("logs"),
  source: nonEmptyStringSchema,
  entries: z.array(logEntrySchema),
});

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

reportsApp.post("/", userAuth, postSubmitReport);
reportsApp.post("/:reportId/artifacts", userAuth, postReportArtifacts);
reportsApp.post("/:reportId/complete", userAuth, postReportComplete);

async function postSubmitReport(c: AppContext) {
  const user = requireUser(c);
  const body = await readJsonObject(c);
  const parsed = submitReportSchema.safeParse(body);
  if (!parsed.success) {
    throw new InvalidRequest("invalid report body");
  }

  const result = await submitReport({
    mentraUserId: user.mentraUserId,
    ...parsed.data,
  });
  return c.json(result, 200);
}

async function postReportArtifacts(c: AppContext) {
  const user = requireUser(c);
  const reportId = readReportId(c, "reportId");
  const contentType = c.req.header("content-type") ?? "";

  if (contentType.includes("multipart/form-data")) {
    const files = await readAttachmentFiles(c);
    if (files.length === 0) {
      throw new InvalidRequest("at least one artifact file is required");
    }
    const result = await addScreenshotArtifacts({
      mentraUserId: user.mentraUserId,
      reportId,
      files,
    });
    if (!result) return c.json({ error: "report not found" }, 404);
    return c.json(result, 200);
  }

  const body = await readJsonObject(c);
  const parsed = logsArtifactSchema.safeParse(body);
  if (!parsed.success) {
    throw new InvalidRequest("invalid report artifact body");
  }
  const result = await addLogArtifact({
    mentraUserId: user.mentraUserId,
    reportId,
    source: parsed.data.source,
    entries: parsed.data.entries,
  });
  if (!result) return c.json({ error: "report not found" }, 404);
  return c.json(result, 200);
}

async function postReportComplete(c: AppContext) {
  const user = requireUser(c);
  const reportId = readReportId(c, "reportId");
  const status = await markReportReady({ mentraUserId: user.mentraUserId, reportId });
  if (!status) return c.json({ error: "report not found" }, 404);
  return c.json({ status }, 200);
}

function requireUser(c: AppContext): NonNullable<AppEnv["Variables"]["user"]> {
  const user = c.var.user;
  if (!user) {
    throw new InvalidRequest("missing authenticated user");
  }
  return user;
}

function readReportId(c: AppContext, paramName: string): string {
  const reportId = (c.req.param(paramName) ?? "").trim();
  if (!reportId) throw new InvalidRequest(`${paramName} is required`);
  return reportId;
}

async function readJsonObject(c: AppContext): Promise<Record<string, unknown>> {
  try {
    const parsed = await c.req.json();
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through to InvalidRequest
  }
  throw new InvalidRequest("request body must be a JSON object");
}

async function readAttachmentFiles(c: AppContext): Promise<ReportAttachmentInput[]> {
  const body = await c.req.parseBody({ all: true });
  const values = Object.entries(body)
    .filter(([key]) => key === "files" || key.startsWith("files["))
    .flatMap(([, value]) => (Array.isArray(value) ? value : [value]));

  const files: ReportAttachmentInput[] = [];
  for (const value of values) {
    if (typeof value === "string") continue;
    const bytes = new Uint8Array(await value.arrayBuffer());
    if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
      throw new InvalidRequest(`artifact ${value.name || "file"} exceeds ${MAX_ATTACHMENT_BYTES} bytes`);
    }
    files.push({
      filename: value.name || `artifact-${Date.now()}`,
      contentType: value.type || "application/octet-stream",
      bytes,
    });
  }

  return files;
}

export default reportsApp;

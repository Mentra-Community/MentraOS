/**
 * @fileoverview Device-called report endpoints.
 *
 * Primary Cloud V2 report API:
 *   /api/client/reports
 */

import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
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
const reportTriggerFields = {
  source: nonEmptyStringSchema,
  reason: nonEmptyStringSchema,
  sourceAppletPackageName: optionalNonEmptyStringSchema,
  sourceAppletName: optionalNonEmptyStringSchema,
};
const manualReportTriggerSchema = z.object({
  type: z.literal("manual"),
  ...reportTriggerFields,
});
const automaticReportTriggerSchema = z.object({
  type: z.literal("automatic"),
  ...reportTriggerFields,
});
const reportTriggerSchema = z.discriminatedUnion("type", [
  manualReportTriggerSchema,
  automaticReportTriggerSchema,
]);
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
// The feedback UI attaches at most 5 screenshots, and the cloud-client sends
// them in a single multipart call.
const MAX_ATTACHMENT_FILES = 5;
// Router-wide request-body ceiling: the full attachment budget plus slack for
// multipart framing. Also bounds the JSON routes (submit, logs).
const MAX_REQUEST_BODY_BYTES =
  MAX_ATTACHMENT_BYTES * MAX_ATTACHMENT_FILES + 1024 * 1024;

// Reject oversized request bodies before the handlers buffer them: bodyLimit
// fails fast on Content-Length and otherwise caps the stream as it is read.
// The custom onError keeps the RFC error shape instead of bodyLimit's default
// HTTPException, which the app-level error handler would report as a 500.
reportsApp.use(
  "*",
  bodyLimit({
    maxSize: MAX_REQUEST_BODY_BYTES,
    onError: (c) =>
      c.json(
        {
          error: "invalid_request",
          error_description: `request body exceeds ${MAX_REQUEST_BODY_BYTES} bytes`,
        },
        413,
      ),
  }),
);

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

// The declared multipart type is attacker-controlled; store it only when it
// names a plausible screenshot format, otherwise fall back to an opaque type.
// The admin artifact route additionally allowlists what it will serve inline.
const SCREENSHOT_CONTENT_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/heic",
  "image/heif",
]);

function screenshotContentType(raw: string | undefined): string {
  const cleaned = (raw ?? "").split(";")[0].trim().toLowerCase();
  return SCREENSHOT_CONTENT_TYPES.has(cleaned) ? cleaned : "application/octet-stream";
}

async function readJsonObject(c: AppContext): Promise<Record<string, unknown>> {
  try {
    const parsed = await c.req.json();
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch (error) {
    // Only malformed JSON falls through to InvalidRequest; anything else
    // (e.g. the bodyLimit cap tripping mid-read) must keep its own status.
    if (!(error instanceof SyntaxError)) throw error;
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
    if (files.length >= MAX_ATTACHMENT_FILES) {
      throw new InvalidRequest(`too many artifact files (max ${MAX_ATTACHMENT_FILES})`);
    }
    // Enforce the per-file limit on the parsed size BEFORE buffering the file
    // into its own array, so an oversized upload is rejected without copies.
    if (value.size > MAX_ATTACHMENT_BYTES) {
      throw new InvalidRequest(`artifact ${value.name || "file"} exceeds ${MAX_ATTACHMENT_BYTES} bytes`);
    }
    files.push({
      filename: value.name || `artifact-${Date.now()}`,
      contentType: screenshotContentType(value.type),
      bytes: new Uint8Array(await value.arrayBuffer()),
    });
  }

  return files;
}

export default reportsApp;

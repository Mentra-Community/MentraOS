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
  addAttachmentArtifacts,
  addLogArtifact,
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
// An explicit `type=video` upload may be larger than a screenshot. 20 MiB
// admits a short screen recording, while the unchanged router ceiling below
// still bounds each request.
const MAX_VIDEO_ATTACHMENT_BYTES = 20 * 1024 * 1024;
// The feedback UI attaches at most 5 screenshots, and the cloud-client sends
// them in a single multipart call.
const MAX_ATTACHMENT_FILES = 5;
// Router-wide request-body ceiling: the full attachment budget plus slack for
// multipart framing. Also bounds the JSON routes (submit, logs). Video uploads
// share this ceiling; it is not raised for them.
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
    const upload = await readAttachmentUpload(c);
    if (upload.files.length === 0) {
      throw new InvalidRequest("at least one artifact file is required");
    }
    const result = await addAttachmentArtifacts({
      mentraUserId: user.mentraUserId,
      reportId,
      ...upload,
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

const MP4_CONTENT_TYPE = "video/mp4";
// Caller-declared capture source such as `phone` or `host`. It is stored as
// a label only; the server cannot verify where a recording was captured.
const SOURCE_LABEL = /^[A-Za-z0-9._:-]{1,64}$/;

function mediaType(raw: string | undefined): string {
  return (raw ?? "").split(";")[0].trim().toLowerCase();
}

function screenshotContentType(raw: string | undefined): string {
  const cleaned = mediaType(raw);
  return SCREENSHOT_CONTENT_TYPES.has(cleaned) ? cleaned : "application/octet-stream";
}

// Structural check only: an ISO base media file starts with an `ftyp` box
// (4-byte size, then the box type). It does not prove the stream is H264 or
// that a browser can decode it.
function hasIsoMediaHeader(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 8) return false;
  const boxSize = new DataView(bytes.buffer, bytes.byteOffset, 8).getUint32(0);
  return boxSize >= 8 && new TextDecoder().decode(bytes.subarray(4, 8)) === "ftyp";
}

function textField(body: Record<string, unknown>, name: string): string | undefined {
  const value = body[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new InvalidRequest(`${name} must be a single text field`);
  return value.trim();
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

interface AttachmentUpload {
  type: "screenshot" | "video";
  source: string;
  files: ReportAttachmentInput[];
}

/**
 * The multipart `type` field selects the contract. Absent or `screenshot`
 * keeps the original screenshot behavior (phone source, image allowlist,
 * 10 MiB). `video` requires a caller-declared `source` and video/mp4 files up
 * to 20 MiB. Every file is validated before anything is stored, so one
 * rejected file leaves the report and its existing artifacts untouched.
 */
async function readAttachmentUpload(c: AppContext): Promise<AttachmentUpload> {
  const body = await c.req.parseBody({ all: true });
  const declaredType = textField(body, "type") || "screenshot";
  if (declaredType !== "screenshot" && declaredType !== "video") {
    throw new InvalidRequest("unsupported multipart artifact type");
  }
  const video = declaredType === "video";
  let source = "phone";
  if (video) {
    const declaredSource = textField(body, "source");
    if (!declaredSource || !SOURCE_LABEL.test(declaredSource)) {
      throw new InvalidRequest("video uploads require a source label");
    }
    source = declaredSource;
  }

  const values = Object.entries(body)
    .filter(([key]) => key === "files" || key.startsWith("files["))
    .flatMap(([, value]) => (Array.isArray(value) ? value : [value]));

  const files: ReportAttachmentInput[] = [];
  for (const value of values) {
    if (typeof value === "string") continue;
    if (files.length >= MAX_ATTACHMENT_FILES) {
      throw new InvalidRequest(`too many artifact files (max ${MAX_ATTACHMENT_FILES})`);
    }
    const name = value.name || "file";
    const declaredMime = mediaType(value.type);
    // A video upload accepts only MP4, and a video file never silently
    // becomes a screenshot.
    if (video && declaredMime !== MP4_CONTENT_TYPE) {
      throw new InvalidRequest(`artifact ${name} must be declared ${MP4_CONTENT_TYPE}`);
    }
    if (!video && declaredMime.startsWith("video/")) {
      throw new InvalidRequest(`artifact ${name} is a video; upload it with type=video`);
    }
    // Enforce the per-file limit on the parsed size BEFORE buffering the file
    // into its own array, so an oversized upload is rejected without copies.
    const maxBytes = video ? MAX_VIDEO_ATTACHMENT_BYTES : MAX_ATTACHMENT_BYTES;
    if (value.size > maxBytes) {
      throw new InvalidRequest(`artifact ${name} exceeds ${maxBytes} bytes`);
    }
    // Buffered once, within the limit above; the header check reads these
    // same bytes, which are then stored.
    const bytes = new Uint8Array(await value.arrayBuffer());
    if (video && !hasIsoMediaHeader(bytes)) {
      throw new InvalidRequest(`artifact ${name} has no MP4 file header`);
    }
    files.push({
      filename: value.name || `artifact-${Date.now()}`,
      contentType: video ? MP4_CONTENT_TYPE : screenshotContentType(value.type),
      bytes,
    });
  }

  return { type: video ? "video" : "screenshot", source, files };
}

export default reportsApp;

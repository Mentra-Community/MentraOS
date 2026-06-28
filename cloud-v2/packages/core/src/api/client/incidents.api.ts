/**
 * @fileoverview Device-called incident and feedback endpoints.
 *
 * Primary Cloud V2 incident API:
 *   /api/client/incidents
 *
 * Glasses log-ingress adapter:
 *   /api/incidents/:incidentId/logs
 *
 * The adapter exists for the current glasses upload command path. Mobile and
 * toolkit code should use the clean /api/client/incidents artifact API.
 */

import { Hono } from "hono";
import { z } from "zod";
import { userAuth } from "../middleware/user-auth.middleware";
import { InvalidRequest } from "../../types/oauth.types";
import type { AppContext, AppEnv } from "../../types/hono.types";
import { sendFeedback } from "../../services/feedback.service";
import {
  addLogArtifact,
  addScreenshotArtifacts,
  createIncident,
  markIncidentReady,
  type IncidentAttachmentInput,
} from "../../services/incident.service";

const incidentsApp = new Hono<AppEnv>();
export const incidentLogIngressApp = new Hono<AppEnv>();
export const feedbackApp = new Hono<AppEnv>();

const recordSchema = z.record(z.unknown());
const nonEmptyStringSchema = z.string().trim().min(1);
const optionalNonEmptyStringSchema = nonEmptyStringSchema.optional();
const logEntrySchema = z.object({
  timestamp: z.number(),
  level: z.string(),
  message: z.string(),
  source: z.string().optional(),
});
const incidentTriggerSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("manual"),
    surface: nonEmptyStringSchema,
    reason: nonEmptyStringSchema,
    sourceAppletPackageName: optionalNonEmptyStringSchema,
    sourceAppletName: optionalNonEmptyStringSchema,
  }),
  z.object({
    type: z.literal("automatic"),
    area: nonEmptyStringSchema,
    reason: nonEmptyStringSchema,
    sourceAppletPackageName: optionalNonEmptyStringSchema,
    sourceAppletName: optionalNonEmptyStringSchema,
  }),
]);
const incidentReportSchema = z.object({
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
const createIncidentSchema = z.object({
  trigger: incidentTriggerSchema,
  report: incidentReportSchema,
  context: recordSchema,
  dedupeKey: optionalNonEmptyStringSchema,
  dedupeWindowMs: z.number().int().positive().optional(),
});
const logsArtifactSchema = z.object({
  type: z.literal("logs"),
  source: nonEmptyStringSchema,
  entries: z.array(logEntrySchema),
});
const sendFeedbackSchema = z.object({
  feedback: z.union([z.string(), recordSchema]),
  phoneState: recordSchema.optional(),
});

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

incidentsApp.post("/", userAuth, postCreateIncident);
incidentsApp.post("/:incidentId/artifacts", userAuth, postIncidentArtifacts);
incidentsApp.post("/:incidentId/complete", userAuth, postIncidentComplete);
incidentLogIngressApp.post("/:incidentId/logs", userAuth, postIncidentLogIngress);
feedbackApp.post("/", userAuth, postFeedback);

async function postCreateIncident(c: AppContext) {
  const user = requireUser(c);
  const body = await readJsonObject(c);
  const parsed = createIncidentSchema.safeParse(body);
  if (!parsed.success) {
    throw new InvalidRequest("invalid incident create body");
  }

  const result = await createIncident({
    mentraUserId: user.mentraUserId,
    ...parsed.data,
  });
  return c.json(result, 200);
}

async function postIncidentArtifacts(c: AppContext) {
  const user = requireUser(c);
  const incidentId = readIncidentId(c);
  const contentType = c.req.header("content-type") ?? "";

  if (contentType.includes("multipart/form-data")) {
    const files = await readAttachmentFiles(c);
    if (files.length === 0) {
      throw new InvalidRequest("at least one artifact file is required");
    }
    const result = await addScreenshotArtifacts({
      mentraUserId: user.mentraUserId,
      incidentId,
      files,
    });
    if (!result) return c.json({ error: "incident not found" }, 404);
    return c.json(result, 200);
  }

  const body = await readJsonObject(c);
  const parsed = logsArtifactSchema.safeParse(body);
  if (!parsed.success) {
    throw new InvalidRequest("invalid incident artifact body");
  }
  const result = await addLogArtifact({
    mentraUserId: user.mentraUserId,
    incidentId,
    source: parsed.data.source,
    entries: parsed.data.entries,
  });
  if (!result) return c.json({ error: "incident not found" }, 404);
  return c.json(result, 200);
}

async function postIncidentComplete(c: AppContext) {
  const user = requireUser(c);
  const incidentId = readIncidentId(c);
  const status = await markIncidentReady({ mentraUserId: user.mentraUserId, incidentId });
  if (!status) return c.json({ error: "incident not found" }, 404);
  return c.json({ status }, 200);
}

async function postIncidentLogIngress(c: AppContext) {
  const user = requireUser(c);
  const incidentId = readIncidentId(c);
  const body = await readJsonObject(c);
  const parsed = z.object({
    source: nonEmptyStringSchema.default("glasses"),
    logs: z.array(logEntrySchema),
  }).safeParse(body);
  if (!parsed.success) {
    throw new InvalidRequest("invalid incident logs body");
  }

  const result = await addLogArtifact({
    mentraUserId: user.mentraUserId,
    incidentId,
    source: parsed.data.source,
    entries: parsed.data.logs,
  });
  if (!result) return c.json({ error: "incident not found" }, 404);
  return c.json(result, 200);
}

async function postFeedback(c: AppContext) {
  const user = requireUser(c);
  const body = await readJsonObject(c);
  const parsed = sendFeedbackSchema.safeParse(body);
  if (!parsed.success) {
    throw new InvalidRequest("invalid feedback body");
  }

  const result = await sendFeedback({
    mentraUserId: user.mentraUserId,
    feedback: parsed.data.feedback,
    phoneState: parsed.data.phoneState,
  });
  return c.json(result, 200);
}

function requireUser(c: AppContext): NonNullable<AppEnv["Variables"]["user"]> {
  const user = c.var.user;
  if (!user) {
    throw new InvalidRequest("missing authenticated user");
  }
  return user;
}

function readIncidentId(c: AppContext): string {
  const incidentId = (c.req.param("incidentId") ?? "").trim();
  if (!incidentId) throw new InvalidRequest("incidentId is required");
  return incidentId;
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

async function readAttachmentFiles(c: AppContext): Promise<IncidentAttachmentInput[]> {
  const body = await c.req.parseBody({ all: true });
  const values = Object.entries(body)
    .filter(([key]) => key === "files" || key.startsWith("files["))
    .flatMap(([, value]) => (Array.isArray(value) ? value : [value]));

  const files: IncidentAttachmentInput[] = [];
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

export default incidentsApp;

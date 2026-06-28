/**
 * @fileoverview Device-called incident and feedback endpoints.
 *
 * Mounted at:
 *   /api/incidents        — compatibility path used by the current mobile flow
 *   /api/client/feedback  — non-bug feedback path
 *
 * Cloud V1 keeps its own /api/incidents implementation. This is Cloud V2 core's
 * additive implementation, authenticated with a Core access token.
 */

import { Hono } from "hono";
import { z } from "zod";
import { userAuth } from "../middleware/user-auth.middleware";
import { InvalidRequest } from "../../types/oauth.types";
import type { AppContext, AppEnv } from "../../types/hono.types";
import {
  appendIncidentAttachments,
  appendIncidentLogs,
  createIncident,
  sendFeedback,
  type IncidentAttachmentInput,
} from "../../services/incident.service";

const incidentsApp = new Hono<AppEnv>();
export const feedbackApp = new Hono<AppEnv>();

const recordSchema = z.record(z.unknown());
const nonEmptyStringSchema = z.string().trim().min(1);
const incidentBugFeedbackSchema = z.object({
  type: z.literal("bug"),
  expectedBehavior: nonEmptyStringSchema,
  actualBehavior: nonEmptyStringSchema,
  severityRating: z.number().finite(),
  submissionMode: z.enum(["USER_INITIATED", "AUTOMATIC"]),
  triggerArea: nonEmptyStringSchema,
  triggerReason: nonEmptyStringSchema,
  systemInfo: recordSchema,
  contactEmail: z.string().email().optional(),
  glassesInfo: recordSchema.optional(),
  sourceAppletPackageName: nonEmptyStringSchema.optional(),
  sourceAppletName: nonEmptyStringSchema.optional(),
}).passthrough();
const createIncidentSchema = z.object({
  feedback: incidentBugFeedbackSchema,
  phoneState: recordSchema,
});
const logEntrySchema = z.object({
  timestamp: z.number(),
  level: z.string(),
  message: z.string(),
  source: z.string().optional(),
});
const uploadLogsSchema = z.object({
  source: z.string().optional(),
  logs: z.array(logEntrySchema),
});
const sendFeedbackSchema = z.object({
  feedback: z.union([z.string(), recordSchema]),
  phoneState: recordSchema.optional(),
});

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

incidentsApp.post("/", userAuth, postCreateIncident);
incidentsApp.post("/:incidentId/logs", userAuth, postIncidentLogs);
incidentsApp.post("/:incidentId/attachments", userAuth, postIncidentAttachments);
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
    feedback: parsed.data.feedback,
    phoneState: parsed.data.phoneState,
  });
  return c.json(result, 200);
}

async function postIncidentLogs(c: AppContext) {
  const user = requireUser(c);
  const incidentId = (c.req.param("incidentId") ?? "").trim();
  if (!incidentId) throw new InvalidRequest("incidentId is required");

  const body = await readJsonObject(c);
  const parsed = uploadLogsSchema.safeParse(body);
  if (!parsed.success) {
    throw new InvalidRequest("invalid incident logs body");
  }

  const logs = parsed.data.logs.map((entry) => ({
    ...entry,
    source: entry.source ?? parsed.data.source,
  }));
  const found = await appendIncidentLogs({
    mentraUserId: user.mentraUserId,
    incidentId,
    logs,
  });
  if (!found) {
    return c.json({ error: "incident not found" }, 404);
  }
  return c.json({ success: true }, 200);
}

async function postIncidentAttachments(c: AppContext) {
  const user = requireUser(c);
  const incidentId = (c.req.param("incidentId") ?? "").trim();
  if (!incidentId) throw new InvalidRequest("incidentId is required");

  const files = await readAttachmentFiles(c);
  if (files.length === 0) {
    throw new InvalidRequest("at least one attachment file is required");
  }

  const result = await appendIncidentAttachments({
    mentraUserId: user.mentraUserId,
    incidentId,
    files,
  });
  if (!result) {
    return c.json({ error: "incident not found" }, 404);
  }
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
      throw new InvalidRequest(`attachment ${value.name || "file"} exceeds ${MAX_ATTACHMENT_BYTES} bytes`);
    }
    files.push({
      filename: value.name || `attachment-${Date.now()}`,
      contentType: value.type || "application/octet-stream",
      bytes,
    });
  }

  return files;
}

export default incidentsApp;

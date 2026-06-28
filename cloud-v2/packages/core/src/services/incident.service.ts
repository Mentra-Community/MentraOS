/**
 * @fileoverview Incident service for Cloud V2 core.
 *
 * Owns incident ids, persistence, and per-user authorization checks for device
 * filed bug reports. API handlers validate the wire shape; this layer enforces
 * ownership and storage semantics.
 */

import { ulid } from "ulid";
import { IncidentModel } from "../models/incident.model";

export interface IncidentLogEntry {
  timestamp: number;
  level: string;
  message: string;
  source?: string;
}

export interface IncidentAttachmentInput {
  filename: string;
  contentType: string;
  bytes: Uint8Array;
}

export interface CreateIncidentInput {
  mentraUserId: string;
  feedback: Record<string, unknown>;
  phoneState: Record<string, unknown>;
}

export interface CreateIncidentResult {
  success: true;
  incidentId: string;
}

export interface UploadAttachmentsResult {
  uploaded: number;
  errors: number;
}

export async function createIncident(input: CreateIncidentInput): Promise<CreateIncidentResult> {
  const incidentId = `inc_${ulid()}`;
  await IncidentModel.create({
    incidentId,
    mentraUserId: input.mentraUserId,
    feedback: input.feedback,
    phoneState: input.phoneState,
    phoneLogs: [],
    attachments: [],
    status: "open",
  });

  return { success: true, incidentId };
}

export async function appendIncidentLogs(input: {
  mentraUserId: string;
  incidentId: string;
  logs: IncidentLogEntry[];
}): Promise<boolean> {
  const result = await IncidentModel.updateOne(
    { incidentId: input.incidentId, mentraUserId: input.mentraUserId },
    {
      $push: {
        phoneLogs: {
          $each: input.logs.map((entry) => ({
            timestamp: entry.timestamp,
            level: entry.level,
            message: entry.message,
            source: entry.source ?? null,
          })),
        },
      },
      $set: { updatedAt: new Date() },
    },
  );

  return result.matchedCount === 1;
}

export async function appendIncidentAttachments(input: {
  mentraUserId: string;
  incidentId: string;
  files: IncidentAttachmentInput[];
}): Promise<UploadAttachmentsResult | null> {
  const now = new Date();
  const attachments = input.files.map((file) => ({
    filename: file.filename,
    contentType: file.contentType,
    sizeBytes: file.bytes.byteLength,
    dataBase64: Buffer.from(file.bytes).toString("base64"),
    uploadedAt: now,
  }));

  const result = await IncidentModel.updateOne(
    { incidentId: input.incidentId, mentraUserId: input.mentraUserId },
    {
      $push: {
        attachments: { $each: attachments },
      },
      $set: { updatedAt: now },
    },
  );

  if (result.matchedCount !== 1) return null;
  return { uploaded: attachments.length, errors: 0 };
}

export async function sendFeedback(input: {
  mentraUserId: string;
  feedback: string | Record<string, unknown>;
  phoneState?: Record<string, unknown>;
}): Promise<{ success: true }> {
  await IncidentModel.create({
    incidentId: `fb_${ulid()}`,
    mentraUserId: input.mentraUserId,
    feedback: typeof input.feedback === "string" ? { type: "feedback", message: input.feedback } : input.feedback,
    phoneState: input.phoneState ?? null,
    phoneLogs: [],
    attachments: [],
    status: "closed",
  });

  return { success: true };
}

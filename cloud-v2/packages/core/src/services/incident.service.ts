/**
 * @fileoverview Incident service for Cloud V2 core.
 *
 * Owns incident ids, persistence, per-user authorization checks, server-side
 * idempotency/dedupe, and artifact storage.
 */

import { ulid } from "ulid";
import { IncidentModel } from "../models/incident.model";

export type IncidentStatus = "collecting" | "ready" | "closed";
export type IncidentSystemPriority = "low" | "medium" | "high" | "critical";

export type IncidentTrigger =
  | {
      type: "manual";
      surface: string;
      reason: string;
      sourceAppletPackageName?: string;
      sourceAppletName?: string;
    }
  | {
      type: "automatic";
      area: string;
      reason: string;
      sourceAppletPackageName?: string;
      sourceAppletName?: string;
    };

export interface IncidentReport {
  actualBehavior: string;
  expectedBehavior?: string;
  userSeverity?: 1 | 2 | 3 | 4 | 5;
  systemPriority?: IncidentSystemPriority;
  contactEmail?: string;
}

export interface IncidentContext extends Record<string, unknown> {}

export interface CreateIncidentInput {
  mentraUserId: string;
  trigger: IncidentTrigger;
  report: IncidentReport;
  context: IncidentContext;
  dedupeKey?: string;
  dedupeWindowMs?: number;
}

export interface CreateIncidentResult {
  incidentId: string;
  status: IncidentStatus;
  created: boolean;
}

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

export interface AddIncidentArtifactsResult {
  stored: number;
}

const DEFAULT_DEDUPE_WINDOW_MS = 90_000;

export async function createIncident(input: CreateIncidentInput): Promise<CreateIncidentResult> {
  const dedupeKey = input.dedupeKey?.trim() || undefined;
  if (dedupeKey) {
    const windowMs = input.dedupeWindowMs ?? DEFAULT_DEDUPE_WINDOW_MS;
    const existing = await IncidentModel.findOne({
      mentraUserId: input.mentraUserId,
      dedupeKey,
      createdAt: { $gte: new Date(Date.now() - windowMs) },
      status: { $ne: "closed" },
    }).sort({ createdAt: -1 });
    if (existing) {
      return {
        incidentId: existing.incidentId,
        status: existing.status as IncidentStatus,
        created: false,
      };
    }
  }

  const incidentId = `inc_${ulid()}`;
  await IncidentModel.create({
    incidentId,
    mentraUserId: input.mentraUserId,
    trigger: input.trigger,
    report: input.report,
    context: input.context,
    dedupeKey: dedupeKey ?? null,
    artifacts: [],
    status: "collecting",
  });

  return { incidentId, status: "collecting", created: true };
}

export async function addLogArtifact(input: {
  mentraUserId: string;
  incidentId: string;
  source: string;
  entries: IncidentLogEntry[];
}): Promise<AddIncidentArtifactsResult | null> {
  const artifact = {
    artifactId: `art_${ulid()}`,
    type: "logs",
    source: input.source,
    data: { entries: input.entries },
    createdAt: new Date(),
  };

  const result = await IncidentModel.updateOne(
    { incidentId: input.incidentId, mentraUserId: input.mentraUserId },
    {
      $push: { artifacts: artifact },
      $set: { updatedAt: new Date() },
    },
  );

  if (result.matchedCount !== 1) return null;
  return { stored: 1 };
}

export async function addScreenshotArtifacts(input: {
  mentraUserId: string;
  incidentId: string;
  files: IncidentAttachmentInput[];
}): Promise<AddIncidentArtifactsResult | null> {
  const now = new Date();
  const artifacts = input.files.map((file) => ({
    artifactId: `art_${ulid()}`,
    type: "screenshot",
    source: "phone",
    filename: file.filename,
    contentType: file.contentType,
    sizeBytes: file.bytes.byteLength,
    dataBase64: Buffer.from(file.bytes).toString("base64"),
    createdAt: now,
  }));

  const result = await IncidentModel.updateOne(
    { incidentId: input.incidentId, mentraUserId: input.mentraUserId },
    {
      $push: { artifacts: { $each: artifacts } },
      $set: { updatedAt: now },
    },
  );

  if (result.matchedCount !== 1) return null;
  return { stored: artifacts.length };
}

export async function markIncidentReady(input: {
  mentraUserId: string;
  incidentId: string;
}): Promise<IncidentStatus | null> {
  const result = await IncidentModel.updateOne(
    { incidentId: input.incidentId, mentraUserId: input.mentraUserId },
    { $set: { status: "ready", updatedAt: new Date() } },
  );
  if (result.matchedCount !== 1) return null;
  return "ready";
}

/**
 * @fileoverview Report service for Cloud V2 core.
 */

import { ulid } from "ulid";
import { ReportModel } from "../models/report.model";

export type ReportKind = "bug" | "feedback" | "automatic";
export type ReportStatus = "collecting" | "ready" | "closed";
export type ReportSystemPriority = "low" | "medium" | "high" | "critical";

interface BaseReportTrigger {
  source: string;
  reason: string;
  sourceAppletPackageName?: string;
  sourceAppletName?: string;
}

export type ReportTrigger =
  | (BaseReportTrigger & { type: "manual" })
  | (BaseReportTrigger & { type: "automatic" });

export interface ReportDetails {
  actualBehavior: string;
  expectedBehavior?: string;
  userSeverity?: 1 | 2 | 3 | 4 | 5;
  systemPriority?: ReportSystemPriority;
  contactEmail?: string;
}

export interface ReportContext extends Record<string, unknown> {}

export type SubmitReportInput =
  | {
      mentraUserId: string;
      kind: "bug";
      trigger: ReportTrigger;
      report: ReportDetails;
      context: ReportContext;
    }
  | {
      mentraUserId: string;
      kind: "automatic";
      trigger: Extract<ReportTrigger, { type: "automatic" }>;
      report: ReportDetails;
      context: ReportContext;
    }
  | {
      mentraUserId: string;
      kind: "feedback";
      feedback: string | Record<string, unknown>;
      context: ReportContext;
    };

export interface SubmitReportResult {
  reportId: string;
  status: ReportStatus;
}

export interface ReportLogEntry {
  timestamp: number;
  level: string;
  message: string;
  source?: string;
}

export interface ReportAttachmentInput {
  filename: string;
  contentType: string;
  bytes: Uint8Array;
}

export interface AddReportArtifactsResult {
  stored: number;
}

export async function submitReport(input: SubmitReportInput): Promise<SubmitReportResult> {
  const reportId = `rep_${ulid()}`;
  const status: ReportStatus = input.kind === "feedback" ? "ready" : "collecting";
  await ReportModel.create({
    reportId,
    mentraUserId: input.mentraUserId,
    kind: input.kind,
    trigger: "trigger" in input ? input.trigger : null,
    report: "report" in input ? input.report : null,
    feedback: "feedback" in input
      ? typeof input.feedback === "string"
        ? { message: input.feedback }
        : input.feedback
      : null,
    context: input.context,
    artifacts: [],
    status,
  });

  return { reportId, status };
}

export async function addLogArtifact(input: {
  mentraUserId: string;
  reportId: string;
  source: string;
  entries: ReportLogEntry[];
}): Promise<AddReportArtifactsResult | null> {
  const artifact = {
    artifactId: `art_${ulid()}`,
    type: "logs",
    source: input.source,
    data: { entries: input.entries },
    createdAt: new Date(),
  };

  const result = await ReportModel.updateOne(
    { reportId: input.reportId, mentraUserId: input.mentraUserId },
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
  reportId: string;
  files: ReportAttachmentInput[];
}): Promise<AddReportArtifactsResult | null> {
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

  const result = await ReportModel.updateOne(
    { reportId: input.reportId, mentraUserId: input.mentraUserId },
    {
      $push: { artifacts: { $each: artifacts } },
      $set: { updatedAt: now },
    },
  );

  if (result.matchedCount !== 1) return null;
  return { stored: artifacts.length };
}

export async function markReportReady(input: {
  mentraUserId: string;
  reportId: string;
}): Promise<ReportStatus | null> {
  const result = await ReportModel.updateOne(
    { reportId: input.reportId, mentraUserId: input.mentraUserId },
    { $set: { status: "ready", updatedAt: new Date() } },
  );
  if (result.matchedCount !== 1) return null;
  return "ready";
}

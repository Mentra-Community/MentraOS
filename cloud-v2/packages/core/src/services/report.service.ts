/**
 * @fileoverview Report service for Cloud V2 core.
 *
 * Artifact payloads (screenshot bytes, serialized log bundles) never live in
 * the report document: each one is written to blob storage and described by a
 * `report_assets` row (same pattern as miniapp assets), while the report
 * embeds only artifact metadata. A report therefore stays a few KB no matter
 * how many attachments it collects.
 */

import { ulid } from "ulid";
import { createLogger } from "@mentra/cloud-shared";
import { ReportModel } from "../models/report.model";
import { ReportAssetModel } from "../models/report-asset.model";
import { notifyReportSlack } from "./report-slack.service";
import { createStorageService } from "./storage/storage.service";

const logger = createLogger("core").child({ service: "report.service" });

// Same provider selection as miniapp assets: local disk in dev, S3/R2 when
// CLOUD_STORAGE_PROVIDER says so. Created on first use, not at import, so the
// provider env vars are read after test setup has pointed them somewhere safe.
let storageInstance: ReturnType<typeof createStorageService> | undefined;
function getStorage() {
  return (storageInstance ??= createStorageService());
}

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
  const feedback = "feedback" in input
    ? typeof input.feedback === "string"
      ? { message: input.feedback }
      : input.feedback
    : null;
  await ReportModel.create({
    reportId,
    mentraUserId: input.mentraUserId,
    kind: input.kind,
    trigger: "trigger" in input ? input.trigger : null,
    report: "report" in input ? input.report : null,
    feedback,
    context: input.context,
    artifacts: [],
    status,
  });

  // Feedback reports are complete as submitted, so they notify here;
  // bug/automatic reports notify from markReportReady once artifact
  // collection finishes. Fire-and-forget: the response never waits on Slack.
  if (status === "ready") {
    notifyReportSlack({
      reportId,
      mentraUserId: input.mentraUserId,
      kind: input.kind,
      feedback,
    }).catch(() => {});
  }

  return { reportId, status };
}

export async function addLogArtifact(input: {
  mentraUserId: string;
  reportId: string;
  source: string;
  entries: ReportLogEntry[];
}): Promise<AddReportArtifactsResult | null> {
  return await addArtifacts({
    reportId: input.reportId,
    mentraUserId: input.mentraUserId,
    payloads: [
      {
        type: "logs",
        source: input.source,
        filename: null,
        contentType: "application/json",
        bytes: Buffer.from(JSON.stringify({ entries: input.entries }), "utf8"),
      },
    ],
  });
}

export async function addScreenshotArtifacts(input: {
  mentraUserId: string;
  reportId: string;
  files: ReportAttachmentInput[];
}): Promise<AddReportArtifactsResult | null> {
  return await addArtifacts({
    reportId: input.reportId,
    mentraUserId: input.mentraUserId,
    payloads: input.files.map((file) => ({
      type: "screenshot" as const,
      source: "phone",
      filename: file.filename,
      contentType: file.contentType,
      bytes: file.bytes,
    })),
  });
}

export async function markReportReady(input: {
  mentraUserId: string;
  reportId: string;
}): Promise<ReportStatus | null> {
  // The pre-update document shows whether this call actually finished
  // collection (repeated /complete calls find "ready" and stay silent) and
  // carries the snapshot the Slack notification summarizes.
  const before = await ReportModel.findOneAndUpdate(
    { reportId: input.reportId, mentraUserId: input.mentraUserId },
    { $set: { status: "ready", updatedAt: new Date() } },
    { returnDocument: "before" },
  ).lean();
  if (!before) return null;
  if (before.status === "collecting") {
    notifyReportSlack({
      reportId: input.reportId,
      mentraUserId: input.mentraUserId,
      kind: before.kind,
      trigger: before.trigger,
      report: before.report,
      feedback: before.feedback,
      artifactCount: before.artifacts?.length ?? 0,
    }).catch(() => {});
  }
  return "ready";
}

interface ReportArtifactPayload {
  type: "logs" | "screenshot" | "state_snapshot";
  source: string;
  filename: string | null;
  contentType: string;
  bytes: Uint8Array;
}

interface StoredReportAsset {
  artifactId: string;
  storageKey: string;
}

/**
 * Store artifact payloads and attach their metadata to the owning report.
 *
 * Order: ownership check (so an unknown reportId 404s without touching
 * storage), then blob + asset row per payload, then one metadata push onto the
 * report. Any failure after the first blob write rolls back everything stored
 * so far, so a failed call leaves no orphaned blobs or asset rows behind.
 */
async function addArtifacts(input: {
  reportId: string;
  mentraUserId: string;
  payloads: ReportArtifactPayload[];
}): Promise<AddReportArtifactsResult | null> {
  const { reportId, mentraUserId } = input;
  const owned = await ReportModel.exists({ reportId, mentraUserId });
  if (!owned) return null;

  const now = new Date();
  const stored: StoredReportAsset[] = [];
  const artifacts: Array<{
    artifactId: string;
    type: ReportArtifactPayload["type"];
    source: string;
    filename: string | null;
    contentType: string;
    sizeBytes: number;
    createdAt: Date;
  }> = [];
  try {
    for (const payload of input.payloads) {
      const artifactId = `art_${ulid()}`;
      // Only server-generated ids appear in the key; the client-supplied
      // filename stays metadata so it can never shape a storage path.
      const storageKey = `reports/${reportId}/${artifactId}`;
      const object = await getStorage().putObject({
        key: storageKey,
        body: payload.bytes,
        contentType: payload.contentType,
      });
      stored.push({ artifactId, storageKey });
      await ReportAssetModel.create({
        artifactId,
        reportId,
        mentraUserId,
        storageKey,
        fileName: payload.filename,
        contentType: object.contentType,
        sizeBytes: object.sizeBytes,
        sha256: object.sha256,
      });
      artifacts.push({
        artifactId,
        type: payload.type,
        source: payload.source,
        filename: payload.filename,
        contentType: payload.contentType,
        sizeBytes: object.sizeBytes,
        createdAt: now,
      });
    }

    const result = await ReportModel.updateOne(
      { reportId, mentraUserId },
      {
        $push: { artifacts: { $each: artifacts } },
        $set: { updatedAt: now },
      },
    );
    if (result.matchedCount !== 1) {
      // The report vanished between the ownership check and the metadata
      // write; treat it as not-found and leave nothing orphaned.
      await discardReportAssets(reportId, stored);
      return null;
    }
    return { stored: artifacts.length };
  } catch (error) {
    if (stored.length > 0) {
      // The metadata push may have failed AMBIGUOUSLY (e.g. a network error
      // after the server applied it), which would leave the report pointing at
      // payloads the rollback below removes. Sweep the pushed artifactIds
      // first so both ambiguous outcomes converge on "nothing stored".
      await ReportModel.updateOne(
        { reportId, mentraUserId },
        { $pull: { artifacts: { artifactId: { $in: stored.map((asset) => asset.artifactId) } } } },
      ).catch((cleanupError) => {
        logger.error(
          { cleanupError, reportId },
          "failed to sweep report artifact metadata during rollback",
        );
      });
      await discardReportAssets(reportId, stored);
    }
    throw error;
  }
}

/**
 * Best-effort rollback of stored blobs and asset rows; failures are logged,
 * never thrown. The blob goes first, and its asset row is only removed once
 * the blob delete succeeded: a surviving row keeps a failed blob delete
 * discoverable (and retryable), whereas removing the row first would leave an
 * unreferenced blob nothing can find again.
 */
async function discardReportAssets(reportId: string, assets: StoredReportAsset[]): Promise<void> {
  for (const asset of assets) {
    try {
      await getStorage().deleteObject(asset.storageKey);
    } catch (cleanupError) {
      logger.error(
        { cleanupError, reportId, storageKey: asset.storageKey },
        "failed to delete stored report artifact; keeping its asset row so the blob stays discoverable",
      );
      continue;
    }
    await ReportAssetModel.deleteOne({ artifactId: asset.artifactId }).catch((cleanupError) => {
      logger.error(
        { cleanupError, reportId, artifactId: asset.artifactId },
        "failed to roll back report asset row",
      );
    });
  }
}

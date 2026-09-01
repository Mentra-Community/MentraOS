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
import { UserModel } from "../models/user.model";
import { getUserById } from "./account/gotrue.client";
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
  metadata?: Record<string, unknown>;
}

export interface ReportAttachmentInput {
  filename: string;
  contentType: string;
  bytes: Uint8Array;
}

export interface AddReportArtifactsResult {
  stored: number;
}

/**
 * Best-effort account email for a report's Slack post: V1 showed the
 * submitter's email, and an opaque mu_ id is useless to a human triaging the
 * channel. First-party users' tenantUserId is their GoTrue id, so it resolves
 * through the admin API; anything that can't resolve (OEM tenants, missing
 * service-role key, GoTrue outage) yields null and the message falls back to
 * the mentraUserId. Never throws — this runs on the fire-and-forget path.
 */
async function reportUserEmail(mentraUserId: string): Promise<string | null> {
  // The catch is attached to the lookup itself, not around the race: once
  // the timer wins, a later rejection of the still-running lookup would
  // otherwise be unhandled.
  const lookup = lookupUserEmail(mentraUserId).catch(() => null);
  return await Promise.race([
    lookup,
    // The email is a nicety: neither Mongo nor the GoTrue fetch carries a
    // timeout, and a hung lookup would stall the Slack post itself (the
    // API response is already decoupled). Give up and post the mu_ id
    // instead of waiting.
    new Promise<null>((resolve) => {
      const timer = setTimeout(() => resolve(null), EMAIL_LOOKUP_TIMEOUT_MS);
      timer.unref?.();
    }),
  ]);
}

const EMAIL_LOOKUP_TIMEOUT_MS = 5_000;

async function lookupUserEmail(mentraUserId: string): Promise<string | null> {
  const user = await UserModel.findOne({ mentraUserId }).lean();
  // Only first-party rows store a GoTrue id in tenantUserId (same gate as
  // account.api's tenantUserIdFor); an OEM sub is a different identifier
  // space, and a stray collision would resolve some unrelated account's
  // email.
  if (!user || user.tenantId !== "mentra") return null;
  const identity = await getUserById(user.tenantUserId);
  return identity?.email || null;
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
  // collection finishes. Fire-and-forget: the response never waits on Slack
  // or the email lookup.
  if (status === "ready") {
    reportUserEmail(input.mentraUserId)
      .then((userEmail) =>
        notifyReportSlack({
          reportId,
          mentraUserId: input.mentraUserId,
          userEmail,
          kind: input.kind,
          feedback,
          context: input.context,
        }),
      )
      .catch(() => {});
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
    reportUserEmail(input.mentraUserId)
      .then((userEmail) =>
        notifyReportSlack({
          reportId: input.reportId,
          mentraUserId: input.mentraUserId,
          userEmail,
          kind: before.kind,
          trigger: before.trigger,
          report: before.report,
          feedback: before.feedback,
          context: before.context,
          artifactCount: before.artifacts?.length ?? 0,
        }),
      )
      .catch(() => {});
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

// === Admin read surface ===
// Consumed by the adminAuth-gated routes behind the internal admin console.

export interface AdminReportArtifact {
  artifactId: string;
  type: "logs" | "screenshot" | "state_snapshot";
  source: string;
  filename: string | null;
  contentType: string | null;
  sizeBytes: number | null;
  createdAt: string | null;
}

export interface AdminReportSummary {
  reportId: string;
  kind: ReportKind;
  status: ReportStatus;
  mentraUserId: string;
  trigger: ReportTrigger | null;
  report: (ReportDetails & Record<string, unknown>) | null;
  feedback: Record<string, unknown> | null;
  artifacts: AdminReportArtifact[];
  createdAt: string | null;
  updatedAt: string | null;
}

export interface AdminReportDetail extends AdminReportSummary {
  context: Record<string, unknown>;
}

export interface AdminReportAsset {
  artifactId: string;
  storageKey: string;
  fileName: string | null;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  createdAt: string | null;
}

export interface ListReportsFilter {
  kind?: ReportKind;
  status?: ReportStatus;
  limit?: number;
  before?: Date;
}

export async function listReports(filter: ListReportsFilter = {}): Promise<AdminReportSummary[]> {
  const query: Record<string, unknown> = {};
  if (filter.kind) query.kind = filter.kind;
  if (filter.status) query.status = filter.status;
  if (filter.before) query.createdAt = { $lt: filter.before };
  const limit = Math.min(Math.max(Math.trunc(filter.limit ?? 50), 1), 200);
  // Context is the one potentially chunky field and the list view never shows
  // it; everything else on a report is metadata-sized.
  const rows = await ReportModel.find(query, { context: 0 })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();
  return rows.map(serializeReportSummary);
}

export async function getReport(
  reportId: string,
): Promise<{ report: AdminReportDetail; assets: AdminReportAsset[] } | null> {
  const row = await ReportModel.findOne({ reportId }).lean();
  if (!row) return null;
  const assets = await ReportAssetModel.find({ reportId }).sort({ createdAt: 1 }).lean();
  return {
    report: {
      ...serializeReportSummary(row),
      context: (row.context ?? {}) as Record<string, unknown>,
    },
    assets: assets.map((asset) => ({
      artifactId: asset.artifactId,
      storageKey: asset.storageKey,
      fileName: asset.fileName ?? null,
      contentType: asset.contentType,
      sizeBytes: asset.sizeBytes,
      sha256: asset.sha256,
      createdAt: toIso(asset.createdAt),
    })),
  };
}

/**
 * Payload bytes for one artifact, or null when no such asset row exists.
 * Throws when the row exists but the blob cannot be read (deleted or storage
 * outage) — the API layer decides how to present that.
 */
export async function readReportArtifactPayload(
  reportId: string,
  artifactId: string,
): Promise<{ bytes: Uint8Array; contentType: string; fileName: string | null } | null> {
  const asset = await ReportAssetModel.findOne({ reportId, artifactId }).lean();
  if (!asset) return null;
  const bytes = await getStorage().getObject(asset.storageKey);
  return { bytes, contentType: asset.contentType, fileName: asset.fileName ?? null };
}

function serializeReportSummary(row: {
  reportId: string;
  kind: string;
  status: string;
  mentraUserId: string;
  trigger?: unknown;
  report?: unknown;
  feedback?: unknown;
  artifacts?: Array<{
    artifactId: string;
    type: string;
    source: string;
    filename?: string | null;
    contentType?: string | null;
    sizeBytes?: number | null;
    createdAt?: Date | null;
  }> | null;
  createdAt?: Date | null;
  updatedAt?: Date | null;
}): AdminReportSummary {
  return {
    reportId: row.reportId,
    kind: row.kind as ReportKind,
    status: row.status as ReportStatus,
    mentraUserId: row.mentraUserId,
    trigger: (row.trigger ?? null) as AdminReportSummary["trigger"],
    report: (row.report ?? null) as AdminReportSummary["report"],
    feedback: (row.feedback ?? null) as AdminReportSummary["feedback"],
    artifacts: (row.artifacts ?? []).map((artifact) => ({
      artifactId: artifact.artifactId,
      type: artifact.type as AdminReportArtifact["type"],
      source: artifact.source,
      filename: artifact.filename ?? null,
      contentType: artifact.contentType ?? null,
      sizeBytes: artifact.sizeBytes ?? null,
      createdAt: toIso(artifact.createdAt),
    })),
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  };
}

function toIso(value: Date | null | undefined): string | null {
  return value ? new Date(value).toISOString() : null;
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

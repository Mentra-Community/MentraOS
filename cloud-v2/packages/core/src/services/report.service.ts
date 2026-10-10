/**
 * @fileoverview Report service for Cloud V2 core.
 *
 * Artifact payloads (screenshot/video bytes, serialized log bundles) never live in
 * the report document: each one is written to blob storage and described by a
 * `report_assets` row (same pattern as miniapp assets), while the report
 * embeds only artifact metadata. List reads project an artifact count so reports
 * with many attachments do not transfer their full inventory during triage.
 */

import { ulid } from "ulid";
import { createHash } from "node:crypto";
import { createLogger } from "@mentra/cloud-shared";
import { ReportModel } from "../models/report.model";
import { ReportAssetModel } from "../models/report-asset.model";
import { TestAssetModel } from "../models/test-run.model";
import type { RecordedFrameworkRun } from "../types/framework-run.types";
import { notifyReportSlack } from "./report-slack.service";
import { REPORT_TESTING_SOURCE, type ReportCategory } from "./report-category";
import type {ReportSlackDelivery} from './report-slack-delivery.service';
import { UserModel } from "../models/user.model";
import { findUsersByEmailFilters, getUserById } from "./account/gotrue.client";
import { getAdminEmailAllowlist, isAdminEmail } from "./admin-email-policy";
import { createStorageService, type StorageService } from "./storage/storage.service";
import type { ByteRange } from "./storage/byte-range";
import {REPORT_LOG_SOURCES, initialReportLogCollection, isReportLogSource, visibleReportLogCollection, type ReportLogCollection, type ReportLogSource} from './report-log-collection';
import {reportAutomationCorrelation, type ReportAutomationCorrelation} from '@mentra/cloud-protocol/report-automation';

const logger = createLogger("core").child({ service: "report.service" });
const attachmentWriteConcern = { w: "majority" as const, j: true, wtimeout: 10_000 };

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

export type SubmitReportInput = (
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
      automationCorrelation?: ReportAutomationCorrelation;
      trigger: Extract<ReportTrigger, { type: "automatic" }>;
      report: ReportDetails;
      context: ReportContext;
    }
  | {
      mentraUserId: string;
      kind: "feedback";
      feedback: string | Record<string, unknown>;
      context: ReportContext;
    }) & {
  /** Device identity of one event; repeats return the user's existing report. */
  incidentKey?: string;
};

export interface SubmitReportResult {
  reportId: string;
  status: ReportStatus;
  /** Present only when an existing report for the incident key was returned. */
  deduplicated?: true;
}

export interface ReportLogEntry {
  timestamp: number;
  level: string;
  message: string;
  source?: string;
}

export type ReportArtifactType = "logs" | "screenshot" | "state_snapshot" | "video";

export interface ReportAttachmentInput {
  filename: string;
  contentType: string;
  bytes: Uint8Array;
}

export interface AddReportArtifactsResult {
  stored: number;
  receipt?: { artifactId: string; sha256: string; sizeBytes: number };
}

export class ReportArtifactError extends Error {
  constructor(readonly status: 409 | 503, message: string) { super(message); }
}

// 128 digest bits in the existing short alphanumeric ID shape. Keeping IDs short
// also preserves the scoped incident reader's credential-shaped-text guard.
function stableReportId(prefix: "rep" | "art", binding: string): string {
  const hex = createHash("sha256").update(binding).digest("hex").slice(0, 32);
  return `${prefix}_${BigInt(`0x${hex}`).toString(32).padStart(26, "0").toUpperCase()}`;
}

/** Server-owned incident for a published run without a device-filed report. The unique
 * reportId deduplicates concurrent creation and retries without changing the TestRun. */
export async function ensureTestRunReport(testRunId: string, payloadSha256: string,
  details?: {actualBehavior: string; expectedBehavior: string; context: Record<string, unknown>}) {
  const reportId = stableReportId("rep", `test-run\n${testRunId}\n${payloadSha256}`);
  const mentraUserId = "automation:test-run";
  const logCollection = initialReportLogCollection(new Date());
  // A fallback has no device-filed report or trusted customer identity. Keep
  // these gaps visible without querying server logs for the automation owner.
  for (const [source, receipt] of Object.entries(logCollection)) {
    receipt.state = 'unavailable';
    receipt.reason = source === 'cloud' || source === 'miniapp_server'
      ? 'No trusted Mentra user identity is available for server log correlation'
      : 'No device-filed report is available to request device log collection';
  }
  const document = { reportId, mentraUserId, kind: "automatic", status: "collecting", artifacts: [],
    logCollection,
    trigger: { type: "automatic", source: REPORT_TESTING_SOURCE, reason: details ? "routine-run-failed" : "worker-diagnostics" },
    report: details ? {actualBehavior: details.actualBehavior, expectedBehavior: details.expectedBehavior} :
      { actualBehavior: "Automation worker diagnostics for a completed test run." },
    context: { ...details?.context, testRunId, payloadSha256 } };
  try {
    await ReportModel.updateOne({ reportId }, { $setOnInsert: document }, { upsert: true, writeConcern: attachmentWriteConcern });
  } catch (error) { if ((error as { code?: number }).code !== 11000) throw error; }
  const row = await ReportModel.findOne({ reportId }).lean();
  const context = row?.context as Record<string, unknown> | undefined;
  if (!row || row.mentraUserId !== mentraUserId || row.kind !== "automatic"
    || context?.testRunId !== testRunId || context.payloadSha256 !== payloadSha256)
    throw new ReportArtifactError(409, "automation incident binding conflicts");
  return { reportId, mentraUserId, ...(details ? {context: context!, report: row.report as {actualBehavior: string; expectedBehavior: string}} : {}) };
}

/** Read an existing server-owned incident by its indexed identity; never creates a report. */
export async function findTestRunReport(testRunId: string, payloadSha256: string): Promise<string | null> {
  const reportId = stableReportId('rep', `test-run\n${testRunId}\n${payloadSha256}`);
  const row = await ReportModel.findOne({reportId, mentraUserId: 'automation:test-run', kind: 'automatic',
    'context.testRunId': testRunId, 'context.payloadSha256': payloadSha256}).select({reportId: 1, _id: 0})
    .setOptions({timeoutMS: 3000}).lean();
  return row?.reportId ?? null;
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
  const rawCorrelation = 'automationCorrelation' in input ? input.automationCorrelation : undefined;
  const correlation = rawCorrelation === undefined ? null : reportAutomationCorrelation(rawCorrelation);
  if (rawCorrelation !== undefined && (!correlation || input.kind !== 'automatic'
    || input.trigger.source !== REPORT_TESTING_SOURCE || input.trigger.reason !== 'incident_report_requested'))
    throw new ReportArtifactError(409, 'Invalid automated incident correlation');
  const {incidentKey} = input;
  if (incidentKey !== undefined) {
    // Bound the dedup lookup to the same 10s budget as the commit wait: an
    // unresponsive primary must surface temporarily_unavailable, not hang.
    const existing = await committedRead(timeoutMs => findIncidentKeyReport(input.mentraUserId, incidentKey, timeoutMs),
      committedReadWait.timeoutMs);
    if (existing) return existing;
  }
  const reportId = `rep_${ulid()}`;
  const status: ReportStatus = input.kind === "feedback" ? "ready" : "collecting";
  const feedback = "feedback" in input
    ? typeof input.feedback === "string"
      ? { message: input.feedback }
      : input.feedback
    : null;
  const document = {
    reportId,
    mentraUserId: input.mentraUserId,
    kind: input.kind,
    trigger: "trigger" in input ? input.trigger : null,
    report: "report" in input ? input.report : null,
    feedback,
    context: input.context,
    ...(correlation ? {automationCorrelation: correlation} : {}),
    ...(incidentKey !== undefined ? {incidentKey} : {}),
    artifacts: [],
    ...(input.kind !== 'feedback' ? {logCollection: initialReportLogCollection(new Date())} : {}),
    status,
  };
  try {
    // The recovery reader requires majority visibility. A correlated creation
    // must not be acknowledged before its binding is committed at that level.
    // A keyed creation is held to the same bar, since its key may be answered
    // to a retry as an existing report.
    if (correlation || incidentKey !== undefined) await ReportModel.create([document], {writeConcern: attachmentWriteConcern});
    else await ReportModel.create(document);
  } catch (error) {
    // A concurrent submission with the same incident key won the unique index.
    // Its write may still be pending or roll back, so answer only once it is committed.
    if (incidentKey === undefined || (error as {code?: number}).code !== 11000) throw error;
    const existing = await awaitCommitted(timeoutMs => findIncidentKeyReport(input.mentraUserId, incidentKey, timeoutMs));
    if (!existing) throw new ReportArtifactError(503, "incident report is not committed yet");
    return existing;
  }

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

async function findIncidentKeyReport(mentraUserId: string, incidentKey: string, timeoutMs: number): Promise<SubmitReportResult | null> {
  // serverSelectionTimeoutMS bounds only connection setup, not an in-flight
  // query, so carry the remaining deadline onto the operation itself.
  const row = await ReportModel.findOne({mentraUserId, incidentKey}, {_id: 0, reportId: 1, status: 1})
    .read('primary').readConcern('majority').setOptions({timeoutMS: timeoutMs})
    .lean<{reportId: string; status: ReportStatus}>();
  return row ? {reportId: row.reportId, status: row.status, deduplicated: true} : null;
}

/** Bound for waiting on a concurrent winner's majority commit; matches its write timeout. */
export const committedReadWait = {timeoutMs: attachmentWriteConcern.wtimeout, pollMs: 100};

/** Mongo surfaces an exhausted operation deadline as maxTimeMS (code 50) or the
 * driver's client-side operation timeout. A keyed submission/upload must then
 * observe temporarily_unavailable rather than a primary that never answers. */
function isQueryTimeout(error: unknown): boolean {
  return (error as {code?: number}).code === 50 || (error as Error).name === "MongoOperationTimeoutError";
}

/** Run one committed read under the remaining deadline, translating an exhausted
 * query deadline into a 503 instead of letting the caller hang on the primary. */
async function committedRead<T>(read: (timeoutMs: number) => Promise<T | null>, timeoutMs: number): Promise<T | null> {
  try {
    return await read(timeoutMs);
  } catch (error) {
    if (isQueryTimeout(error)) throw new ReportArtifactError(503, "incident read exceeded its deadline");
    throw error;
  }
}

async function awaitCommitted<T>(read: (timeoutMs: number) => Promise<T | null>): Promise<T | null> {
  const deadline = Date.now() + committedReadWait.timeoutMs;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return null;
    const row = await committedRead(read, remaining);
    if (row || Date.now() >= deadline) return row;
    await new Promise(resolve => setTimeout(resolve, committedReadWait.pollMs));
  }
}

/** Exact durable device-report link only. No collection-success inference and no
 * choosing a winner when duplicate requests/accounts used the same binding. */
export async function findDeviceIncidentReport(correlation: ReportAutomationCorrelation): Promise<string | null> {
  const valid = reportAutomationCorrelation(correlation);
  if (!valid) return null;
  const rows = await ReportModel.find({'automationCorrelation.testRunId': valid.testRunId,
    'automationCorrelation.alertId': valid.alertId}).select({reportId: 1, kind: 1, trigger: 1, _id: 0})
    .limit(2).read('primary').readConcern('majority').setOptions({timeoutMS: 3000}).lean();
  const row = rows.length === 1 ? rows[0] : undefined;
  const trigger = row?.trigger as {source?: unknown; reason?: unknown} | undefined;
  return row?.kind === 'automatic' && trigger?.source === REPORT_TESTING_SOURCE
    && trigger.reason === 'incident_report_requested' && /^rep_[A-Za-z0-9]{1,80}$/.test(row.reportId)
    ? row.reportId : null;
}

export async function addLogArtifact(input: {
  mentraUserId: string;
  reportId: string;
  source: string;
  entries: ReportLogEntry[];
}, retry?: { key: string; storage?: StorageService }): Promise<AddReportArtifactsResult | null> {
  if (retry) return addRetryableLogArtifact(input, retry.key, retry.storage ?? getStorage());
  return await addArtifacts({
    reportId: input.reportId,
    mentraUserId: input.mentraUserId,
    payloads: [
      {
        type: "logs",
        source: input.source,
        filename: null,
        contentType: "application/json",
        logEntryCount: input.entries.length,
        bytes: Buffer.from(JSON.stringify({ entries: input.entries }), "utf8"),
      },
    ],
  });
}

/** Read only collection receipts for the authenticated report owner. */
export async function getReportLogCollection(input: {mentraUserId: string; reportId: string}): Promise<{
  reportId: string;
  logCollection: Partial<Record<ReportLogSource, ReportLogCollection>>;
} | null> {
  const row = await ReportModel.findOne(
    {reportId: input.reportId, mentraUserId: input.mentraUserId},
    {_id: 0, reportId: 1, logCollection: 1},
  ).lean<{reportId: string; logCollection?: Partial<Record<ReportLogSource, ReportLogCollection>> | null}>();
  if (!row) return null;
  const logCollection: Partial<Record<ReportLogSource, ReportLogCollection>> = {};
  for (const source of REPORT_LOG_SOURCES) {
    const receipt = row.logCollection?.[source];
    if (!receipt) continue;
    logCollection[source] = {
      state: receipt.state, requestedAt: receipt.requestedAt, deadlineAt: receipt.deadlineAt,
      ...(typeof receipt.reason === 'string' ? {reason: receipt.reason} : {}),
      ...(typeof receipt.receivedAt === 'string' ? {receivedAt: receipt.receivedAt} : {}),
      ...(typeof receipt.artifactId === 'string' ? {artifactId: receipt.artifactId} : {}),
      ...(typeof receipt.entryCount === 'number' ? {entryCount: receipt.entryCount} : {}),
    };
  }
  return {reportId: row.reportId, logCollection: visibleReportLogCollection(logCollection)};
}

/** Only actual storage acceptance marks a source received. A late device failure never erases it. */
export async function updateReportLogCollection(input: {
  mentraUserId: string; reportId: string; source: ReportLogSource;
  state: 'requested' | 'unavailable' | 'failed'; reason?: string;
}): Promise<boolean> {
  const owner = {reportId: input.reportId, mentraUserId: input.mentraUserId};
  if (!await ReportModel.exists(owner)) return false;
  const source = `logCollection.${input.source}`;
  const result = await ReportModel.updateOne({...owner, [`${source}.state`]: {$nin: ['received', 'failed', 'unavailable']}}, {
    $set: {[`${source}.state`]: input.state, ...(input.reason ? {[`${source}.reason`]: input.reason} : {})},
  });
  if (result.modifiedCount) logger.info({...owner, source: input.source, state: input.state, reason: input.reason}, 'Report log collection outcome');
  return true;
}

/** Attach all already-acknowledged native diagnostic and screenshot bytes by reference, never
 * copying recordings or reading unbounded device output into the report. */
export async function referenceTestRunDiagnostics(owner: {reportId: string; mentraUserId: string}, run: RecordedFrameworkRun) {
  const declared = run.assets.filter(asset => asset.kind === "diagnostic" || asset.kind === "report" || asset.kind === "screenshot");
  // A timed-out write may already have committed. Verify and reuse those rows
  // on retry instead of issuing the entire frozen export's upserts again.
  const batchSize = 100;
  for (let offset = 0; offset < declared.length; offset += batchSize) {
    const batch = declared.slice(offset, offset + batchSize);
    const screenshotIds = new Set(batch.filter(asset => asset.kind === "screenshot").map(asset => asset.id));
    const stored = await TestAssetModel.find({runId: run.result.runId, assetId: {$in: batch.map(asset => asset.id)}})
      .read("primary").readConcern("majority").setOptions({timeoutMS: 10_000}).lean();
    const byId = new Map(stored.map(asset => [asset.assetId, asset]));
    const references = batch.map(asset => {
      const blob = byId.get(asset.id);
      if (!blob || blob.sha256 !== asset.sha256 || blob.sizeBytes !== asset.size)
        throw new ReportArtifactError(503, "Routine diagnostic custody differs from its frozen manifest");
      return {artifactId: stableReportId("art", `${owner.reportId}\nnative-diagnostic\n${asset.id}`), ...owner,
        storageKey: blob.storageKey, sourceTestRunId: run.result.runId, sourceTestAssetId: asset.id, fileName: asset.path.split('/').at(-1),
        contentType: asset.mimeType, sizeBytes: asset.size, sha256: asset.sha256};
    });
    const readRows = () => ReportAssetModel.find({artifactId: {$in: references.map(reference => reference.artifactId)}})
      .read("primary").readConcern("majority").setOptions({timeoutMS: 10_000}).lean();
    let rows = await readRows();
    const matches = (row: typeof rows[number], reference: typeof references[number]) =>
      row.reportId === reference.reportId && row.mentraUserId === reference.mentraUserId && row.storageKey === reference.storageKey
      && row.sha256 === reference.sha256 && row.sizeBytes === reference.sizeBytes && row.sourceTestRunId === reference.sourceTestRunId
      && row.sourceTestAssetId === reference.sourceTestAssetId && row.fileName === reference.fileName && row.contentType === reference.contentType;
    const existing = new Map(rows.map(row => [row.artifactId, row]));
    const missing = references.filter(reference => {
      const row = existing.get(reference.artifactId);
      if (row && !matches(row, reference)) throw new ReportArtifactError(409, "Routine diagnostic reference already binds different content");
      return !row;
    });
    if (missing.length) {
      await ReportAssetModel.bulkWrite(missing.map(reference => ({updateOne: {filter: {artifactId: reference.artifactId},
        update: {$setOnInsert: reference}, upsert: true}})), {writeConcern: attachmentWriteConcern, ordered: false, timeoutMS: 10_000});
      rows = await readRows();
    }
    const byArtifactId = new Map(rows.map(row => [row.artifactId, row]));
    const metadata = references.map(reference => {
      const row = byArtifactId.get(reference.artifactId);
      if (!row) throw new ReportArtifactError(503, "Routine diagnostic reference is unavailable");
      if (!matches(row, reference)) throw new ReportArtifactError(409, "Routine diagnostic reference already binds different content");
      const screenshot = screenshotIds.has(reference.sourceTestAssetId);
      return {artifactId: row.artifactId, type: screenshot ? "screenshot" : "state_snapshot",
        source: screenshot ? "framework-screenshot" : "framework-diagnostic", filename: row.fileName,
        contentType: row.contentType, sizeBytes: row.sizeBytes, createdAt: row.createdAt};
    });
    const result = await ReportModel.updateOne(owner, {$addToSet: {artifacts: {$each: metadata}}},
      {writeConcern: attachmentWriteConcern, timeoutMS: 10_000});
    if (result.matchedCount !== 1) throw new ReportArtifactError(503, "Routine incident is unavailable");
  }
  return declared.length;
}

/** Keyed retry path through the same report/asset models and blob provider. Reserve the
 * digest and source before writing: a concurrent different body or source cannot
 * overwrite the winning blob or publish a second artifact under the same key.
 * Interrupted uploads keep their reservation so an identical retry can finish it. */
async function addRetryableLogArtifact(input: {
  mentraUserId: string; reportId: string; source: string; entries: ReportLogEntry[];
}, key: string, storage: StorageService): Promise<AddReportArtifactsResult | null> {
  const { reportId, mentraUserId } = input;
  if (!await ReportModel.exists({ reportId, mentraUserId })) return null;
  const bytes = Buffer.from(JSON.stringify({ entries: input.entries }), "utf8");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const artifactId = stableReportId("art", `${reportId}\n${key}`);
  const storageKey = `reports/${reportId}/${artifactId}`, contentType = "application/json";
  try {
    await ReportAssetModel.create([{ artifactId, reportId, mentraUserId, storageKey, fileName: null,
      contentType, sizeBytes: bytes.byteLength, sha256, source: input.source }], { writeConcern: attachmentWriteConcern });
  } catch (error) { if ((error as { code?: number }).code !== 11000) throw error; }
  // Bind only against a committed reservation: a concurrent winner's may still roll back.
  // Carry the remaining deadline onto the lookup so a stalled primary cannot hang the upload.
  const asset = await awaitCommitted(timeoutMs => ReportAssetModel.findOne({ artifactId })
    .read("primary").readConcern("majority").setOptions({timeoutMS: timeoutMs}).lean());
  if (!asset) throw new ReportArtifactError(503, "attachment reservation is not committed yet");
  // Reservations made before sources were bound carry none.
  if (asset.reportId !== reportId || asset.mentraUserId !== mentraUserId || asset.storageKey !== storageKey
    || asset.sha256 !== sha256 || asset.sizeBytes !== bytes.byteLength || asset.contentType !== contentType
    || (asset.source != null && asset.source !== input.source))
    throw new ReportArtifactError(409, "attachment key already binds different content");
  // Published metadata proves an earlier verified write. A retry only reads it;
  // an unavailable/corrupt completed object must not trigger a destructive rewrite.
  const completed = await ReportModel.exists({ reportId, mentraUserId, "artifacts.artifactId": artifactId })
    .read("primary").readConcern("majority");
  if (!completed) {
    const object = await storage.putObject({ key: storageKey, body: bytes, contentType });
    if (object.key !== storageKey || object.sha256 !== sha256 || object.sizeBytes !== bytes.byteLength || object.contentType !== contentType)
      throw new ReportArtifactError(503, "attachment storage receipt did not match");
  }
  const readback = await storage.getObject(storageKey);
  if (readback.byteLength !== bytes.byteLength || createHash("sha256").update(readback).digest("hex") !== sha256)
    throw new ReportArtifactError(503, "attachment storage verification failed");
  const metadata = { artifactId, type: "logs", source: input.source, filename: null, contentType,
    sizeBytes: bytes.byteLength, createdAt: asset.createdAt };
  // Same reservation timestamp means concurrent/repeated metadata writes are identical.
  const result = await ReportModel.updateOne({ reportId, mentraUserId }, { $addToSet: { artifacts: metadata } },
    { writeConcern: attachmentWriteConcern });
  if (result.matchedCount !== 1) return null;
  if (isReportLogSource(input.source)) {
    const receipt = `logCollection.${input.source}`;
    // The first accepted artifact for a source owns its receipt; identical retries leave it unchanged.
    const marked = await ReportModel.updateOne({ reportId, mentraUserId, [`${receipt}.state`]: { $ne: "received" } }, {
      $set: { [`${receipt}.state`]: "received", [`${receipt}.receivedAt`]: new Date().toISOString(),
        [`${receipt}.artifactId`]: artifactId, [`${receipt}.entryCount`]: input.entries.length },
      $unset: { [`${receipt}.reason`]: "", [`${receipt}.leaseUntil`]: "" },
    }, { writeConcern: attachmentWriteConcern });
    if (marked.modifiedCount) logger.info({ reportId, mentraUserId, source: input.source, artifactId, sizeBytes: bytes.byteLength }, "Report log artifact received");
  }
  return { stored: 1, receipt: { artifactId, sha256, sizeBytes: bytes.byteLength } };
}

/**
 * Multipart file attachments: screenshots, or MP4 videos with the capture
 * source the uploader declared. The upload route validates type, MIME and size.
 */
export async function addAttachmentArtifacts(input: {
  mentraUserId: string;
  reportId: string;
  type: Extract<ReportArtifactType, "screenshot" | "video">;
  source: string;
  files: ReportAttachmentInput[];
}): Promise<AddReportArtifactsResult | null> {
  return await addArtifacts({
    reportId: input.reportId,
    mentraUserId: input.mentraUserId,
    payloads: input.files.map((file) => ({
      type: input.type,
      source: input.source,
      filename: file.filename,
      contentType: file.contentType,
      bytes: file.bytes,
    })),
  });
}

export async function markReportReady(input: {
  mentraUserId: string;
  reportId: string;
  onlyCollecting?: boolean;
}): Promise<ReportStatus | null> {
  // The pre-update document shows whether this call actually finished
  // collection (repeated /complete calls find "ready" and stay silent) and
  // carries the snapshot the Slack notification summarizes.
  const before = await ReportModel.findOneAndUpdate(
    { reportId: input.reportId, mentraUserId: input.mentraUserId, ...(input.onlyCollecting ? { status: "collecting" } : {}) },
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
  type: ReportArtifactType;
  source: string;
  filename: string | null;
  contentType: string;
  bytes: Uint8Array;
  logEntryCount?: number;
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
    logEntryCount?: number;
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
        ...(payload.logEntryCount !== undefined ? {logEntryCount: payload.logEntryCount} : {}),
      });
    }

    const result = await ReportModel.updateOne(
      { reportId, mentraUserId },
      {
        $push: { artifacts: { $each: artifacts.map(({logEntryCount: _count, ...artifact}) => artifact) } },
        $set: { updatedAt: now, ...Object.fromEntries(artifacts.filter(artifact => artifact.type === 'logs' && isReportLogSource(artifact.source)).flatMap(artifact => [
          [`logCollection.${artifact.source}.state`, 'received'],
          [`logCollection.${artifact.source}.receivedAt`, now.toISOString()],
          [`logCollection.${artifact.source}.artifactId`, artifact.artifactId],
          [`logCollection.${artifact.source}.entryCount`, artifact.logEntryCount],
        ])) },
        $unset: Object.fromEntries(artifacts.filter(artifact => artifact.type === 'logs' && isReportLogSource(artifact.source)).flatMap(artifact => [
          [`logCollection.${artifact.source}.reason`, ''], [`logCollection.${artifact.source}.leaseUntil`, ''],
        ])),
      },
    );
    if (result.matchedCount !== 1) {
      // The report vanished between the ownership check and the metadata
      // write; treat it as not-found and leave nothing orphaned.
      await discardReportAssets(reportId, stored);
      return null;
    }
    for (const artifact of artifacts.filter(artifact => artifact.type === 'logs')) {
      logger.info({reportId, mentraUserId, source: artifact.source, artifactId: artifact.artifactId, sizeBytes: artifact.sizeBytes}, 'Report log artifact received');
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
      for (const source of [...new Set(artifacts.filter(artifact => artifact.type === 'logs' && isReportLogSource(artifact.source))
        .map(artifact => artifact.source))]) {
        const receipt = `logCollection.${source}`;
        // A later accepted upload may already own this source. Roll back only this call's receipt.
        await ReportModel.updateOne({reportId, mentraUserId, [`${receipt}.artifactId`]: {
          $in: artifacts.filter(artifact => artifact.source === source).map(artifact => artifact.artifactId),
        }}, {
          $set: {[`${receipt}.state`]: 'failed', [`${receipt}.reason`]: 'Artifact storage acceptance was rolled back'},
          $unset: Object.fromEntries(['receivedAt', 'artifactId', 'entryCount', 'leaseUntil'].map(field => [`${receipt}.${field}`, ''])),
        }).catch(cleanupError => logger.error({cleanupError, reportId, source}, 'failed to roll back report log receipt'));
      }
      await discardReportAssets(reportId, stored);
    }
    throw error;
  }
}

// === Admin read surface ===
// Consumed by the adminAuth-gated routes behind the internal admin console.

export interface AdminReportArtifact {
  artifactId: string;
  type: ReportArtifactType;
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
  artifactCount: number;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface AdminReportDetail extends Omit<AdminReportSummary, "artifactCount"> {
  artifacts: AdminReportArtifact[];
  context: Record<string, unknown>;
  slackDelivery?: ReportSlackDelivery;
  logCollection?: Partial<Record<ReportLogSource, ReportLogCollection>>;
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
  // Internal and Testing are triage categories, not submitted/stored report kinds.
  category?: ReportCategory;
  status?: ReportStatus;
  limit?: number;
  before?: Date;
}

export async function listReports(filter: ListReportsFilter = {}): Promise<AdminReportSummary[]> {
  const query: Record<string, unknown> = {};
  if (filter.kind) query.kind = filter.kind;
  if (filter.category) {
    const category: Record<string, unknown> = {};
    // The incident automation contract uses this trigger source.
    // Apply category membership before the database limit, including old reports.
    category["trigger.source"] = filter.category === "testing"
      ? REPORT_TESTING_SOURCE
      : { $ne: REPORT_TESTING_SOURCE };
    if (filter.category === "automatic") {
      category.kind = "automatic";
    } else if (filter.category !== "testing") {
      const internalUserIds = await internalReporterIds();
      category.mentraUserId = filter.category === "internal" ? { $in: internalUserIds } : { $nin: internalUserIds };
      category.kind = filter.category === "internal" ? { $in: ["bug", "feedback"] } : filter.category;
    }
    // Compose with a supplied stored kind instead of replacing its predicate.
    query.$and = [category];
  }
  if (filter.status) query.status = filter.status;
  if (filter.before) query.createdAt = { $lt: filter.before };
  const limit = Math.min(Math.max(Math.trunc(filter.limit ?? 50), 1), 200);
  // Count in Mongo: the list needs no artifact metadata, context, or collection
  // receipts. Apply membership and the page bound before projecting each row.
  const rows = await ReportModel.aggregate<Parameters<typeof serializeReportSummary>[0] & {artifactCount: number}>([
    {$match: query},
    {$sort: {createdAt: -1}},
    {$limit: limit},
    {$project: {_id: 0, reportId: 1, kind: 1, status: 1, mentraUserId: 1,
      trigger: 1, report: 1, feedback: 1, createdAt: 1, updatedAt: 1,
      artifactCount: {$size: {$ifNull: ["$artifacts", []]}}}},
  ]);
  return rows.map(row => ({...serializeReportSummary(row), artifactCount: row.artifactCount}));
}

/** Resolve current admin accounts, including reporters of historical incidents.
 * The report's contact email/context are user supplied and cannot identify an admin.
 * All kinds, Automatic, Testing, and detail remain available without a directory lookup.
 */
async function internalReporterIds(): Promise<string[]> {
  const allowlist = getAdminEmailAllowlist();
  // GoTrue searches substrings: the full base email would miss local+tag@domain.
  // Search the local part, then apply the complete email/domain policy below.
  const filters = [...allowlist.emails.map(email => email.split("@")[0]!), ...allowlist.domains.map(domain => `@${domain}`)];
  if (filters.length === 0) return [];
  const identities = await findUsersByEmailFilters(filters);
  const adminIds = identities.filter(identity => isAdminEmail(identity.email, allowlist)).map(identity => identity.id);
  if (adminIds.length === 0) return [];
  // OEM subject IDs are a different identity namespace, even if the strings collide.
  const users = await UserModel.find({ tenantId: "mentra", tenantUserId: { $in: adminIds } }, { mentraUserId: 1 }).lean();
  return users.map(user => user.mentraUserId);
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
      artifacts: (row.artifacts ?? []).map(artifact => ({
        artifactId: artifact.artifactId,
        type: artifact.type as AdminReportArtifact["type"],
        source: artifact.source,
        filename: artifact.filename ?? null,
        contentType: artifact.contentType ?? null,
        sizeBytes: artifact.sizeBytes ?? null,
        createdAt: toIso(artifact.createdAt),
      })),
      context: (row.context ?? {}) as Record<string, unknown>,
      ...(row.slackDelivery ? {slackDelivery: row.slackDelivery as ReportSlackDelivery} : {}),
      ...(row.logCollection ? {logCollection: visibleReportLogCollection(row.logCollection)} : {}),
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
 * Frozen metadata and a lazy storage stream, or null when no asset row exists.
 * Verify the current object's size before serving its original storage key.
 */
export async function readReportArtifact(
  reportId: string,
  artifactId: string,
): Promise<{ sizeBytes: number; contentType: string; fileName: string | null; sha256: string;
  stream: (range?: ByteRange) => Promise<ReadableStream<Uint8Array> | Blob> } | null> {
  const asset = await ReportAssetModel.findOne({ reportId, artifactId }).lean();
  if (!asset) return null;
  const storage = getStorage();
  if ((await storage.statObject(asset.storageKey)).sizeBytes !== asset.sizeBytes) throw new Error("stored report artifact size changed");
  return { sizeBytes: asset.sizeBytes, contentType: asset.contentType, fileName: asset.fileName ?? null, sha256: asset.sha256,
    stream: (range) => storage.streamObject(asset.storageKey, range) };
}

function serializeReportSummary(row: {
  reportId: string;
  kind: string;
  status: string;
  mentraUserId: string;
  trigger?: unknown;
  report?: unknown;
  feedback?: unknown;
  createdAt?: Date | null;
  updatedAt?: Date | null;
}): Omit<AdminReportSummary, "artifactCount"> {
  return {
    reportId: row.reportId,
    kind: row.kind as ReportKind,
    status: row.status as ReportStatus,
    mentraUserId: row.mentraUserId,
    trigger: (row.trigger ?? null) as AdminReportSummary["trigger"],
    report: (row.report ?? null) as AdminReportSummary["report"],
    feedback: (row.feedback ?? null) as AdminReportSummary["feedback"],
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
      // Native references share test-owned blobs. Rollback must preserve them.
      if (await ReportAssetModel.exists({artifactId: asset.artifactId, sourceTestRunId: {$exists: true}})) continue;
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

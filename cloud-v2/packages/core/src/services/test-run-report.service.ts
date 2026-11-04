/**
 * The old device-testing system's reports: fallback incidents for failed framework runs and the
 * references that attach their diagnostics. Only the framework result path calls this.
 */

import {ReportModel} from '../models/report.model';
import {TestRunModel} from '../models/test-run.model';
import {reportAutomationCorrelation, type ReportAutomationCorrelation} from '@mentra/cloud-protocol/report-automation';
import type {RecordedFrameworkRun} from '../types/framework-run.types';
import {readStoredRun} from './framework-run-detail.service';
import {REPORT_TESTING_SOURCE} from './report-category';
import {initialReportLogCollection} from './report-log-collection';
import {NativeReportError, readNativeReportAssets, reportNativeSnapshotSchema} from './report-native-detail.service';
import {attachmentWriteConcern, ReportArtifactError, stableReportId} from './report.service';
import {requestInputDigest} from './test-request.service';
import {TestRunError} from './test-result-error';
import {TestingDetailStorage} from './testing-detail-storage.service';

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

/** Attach all already-acknowledged native diagnostic and screenshot bytes by reference, never
 * copying recordings or reading unbounded device output into the report. */
export async function referenceTestRunDiagnostics(owner: {reportId: string; mentraUserId: string}, run: RecordedFrameworkRun) {
  const existing = await ReportModel.findOne(owner).read('primary').readConcern('majority').lean();
  if (!existing) throw new ReportArtifactError(503, 'Routine incident is unavailable');
  if (existing.nativeDiagnostics) {
    const reference = existing.nativeDiagnostics as {runId?: unknown; payloadSha256?: unknown};
    if (reference.runId !== run.result.runId || reference.payloadSha256 !== requestInputDigest(run))
      throw new ReportArtifactError(409, 'Routine incident already binds another result');
    try {return (await readNativeReportAssets(existing)).artifacts.length;}
    catch (error) {throw error instanceof NativeReportError ? new TestRunError(error.status, error.message) : error;}
  }
  const row = await TestRunModel.findOne({resultSchemaVersion: 1, runId: run.result.runId, uploadsComplete: true})
    .read('primary').readConcern('majority').lean();
  if (!row) throw new ReportArtifactError(503, 'Routine result authority is unavailable');
  const envelope = await readStoredRun(row);
  if (envelope.payloadSha256 !== requestInputDigest(run)) throw new ReportArtifactError(409, 'Routine incident result differs');
  const declared = run.assets.filter(asset => asset.kind === 'diagnostic' || asset.kind === 'report' || asset.kind === 'screenshot');
  const snapshot = reportNativeSnapshotSchema.parse({version: 1, reportId: owner.reportId, mentraUserId: owner.mentraUserId, runId: run.result.runId,
    payloadSha256: envelope.payloadSha256, artifacts: declared.map(asset => ({
      artifactId: stableReportId('art', `${owner.reportId}\nnative-diagnostic\n${asset.id}`), assetId: asset.id,
      createdAt: new Date(existing.createdAt).toISOString(), type: asset.kind === 'screenshot' ? 'screenshot' : 'state_snapshot',
      source: asset.kind === 'screenshot' ? 'framework-screenshot' : 'framework-diagnostic'}))});
  const detail = await new TestingDetailStorage().write('report-native', owner.reportId, snapshot);
  const reference = {runId: snapshot.runId, payloadSha256: snapshot.payloadSha256, count: snapshot.artifacts.length, detail};
  await ReportModel.updateOne({...owner, nativeDiagnostics: {$exists: false}}, {$set: {nativeDiagnostics: reference}},
    {writeConcern: attachmentWriteConcern, timeoutMS: 10_000});
  const settled = await ReportModel.findOne(owner).read('primary').readConcern('majority').lean();
  if (!settled || requestInputDigest(settled.nativeDiagnostics) !== requestInputDigest(reference))
    throw new ReportArtifactError(409, 'Routine incident source publication conflicts');
  return declared.length;
}

/** Bind acknowledged run evidence to the existing device report's authenticated owner.
 * A host-provided report ID alone never authorizes an attachment. */
export async function referenceDeviceIncidentDiagnostics(reportId: string, correlation: ReportAutomationCorrelation,
  run: RecordedFrameworkRun) {
  const valid = reportAutomationCorrelation(correlation);
  if (!valid || valid.testRunId !== run.result.runId || !/^rep_[A-Za-z0-9]{1,80}$/.test(reportId))
    throw new ReportArtifactError(409, "Device incident does not belong to this frozen run");
  const row = await ReportModel.findOne({reportId, 'automationCorrelation.testRunId': valid.testRunId,
    'automationCorrelation.alertId': valid.alertId}).select({reportId: 1, mentraUserId: 1, kind: 1, trigger: 1, _id: 0})
    .read('primary').readConcern('majority').setOptions({timeoutMS: 3000}).lean();
  const trigger = row?.trigger as {source?: unknown; reason?: unknown} | undefined;
  if (!row || !row.mentraUserId || row.kind !== 'automatic' || trigger?.source !== REPORT_TESTING_SOURCE
    || trigger.reason !== 'incident_report_requested')
    throw new ReportArtifactError(409, "Device incident does not belong to this frozen run");
  return referenceTestRunDiagnostics({reportId: row.reportId, mentraUserId: row.mentraUserId}, run);
}

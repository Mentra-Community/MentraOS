import { ReportModel } from "../models/report.model";
import { TestRunModel } from "../models/test-run.model";
import { testRunIdSchema, testRunSchema } from "../types/test-run.types";
import { testFailureOccurrenceIdSchema } from "../types/test-failure.types";
import { workerDiagnosticsSchema, WORKER_DIAGNOSTICS_MAX_BYTES } from "../types/worker-diagnostics.types";
import { addLogArtifact, ensureTestRunReport, markReportReady, ReportArtifactError } from "./report.service";
import { TestRunError } from "./test-run.service";
import type { StorageService } from "./storage/storage.service";

/** Transport adapter only: normal report assets/storage, with server-resolved ownership.
 * The accepted test payload, occurrence, verdict and evidence completeness never change. */
export class WorkerDiagnosticsService {
  constructor(private readonly storage?: StorageService) {}

  async forRun(runId: string, input: unknown) {
    if (!testRunIdSchema.safeParse(runId).success) throw new TestRunError(400, "invalid runId");
    return this.attach({ runId }, input, "routine-worker");
  }

  async forOccurrence(occurrenceId: string, input: unknown) {
    if (!testFailureOccurrenceIdSchema.safeParse(occurrenceId).success) throw new TestRunError(400, "invalid occurrenceId");
    return this.attach({ "failureOccurrences.occurrenceId": occurrenceId }, input, "fixer-worker");
  }

  private async attach(selector: { runId: string } | { "failureOccurrences.occurrenceId": string }, raw: unknown,
    source: "routine-worker" | "fixer-worker") {
    const parsed = workerDiagnosticsSchema.safeParse(raw);
    if (!parsed.success) throw new TestRunError(400, "invalid worker diagnostics");
    const input = parsed.data;
    if (Buffer.byteLength(JSON.stringify(input)) > WORKER_DIAGNOSTICS_MAX_BYTES)
      throw new TestRunError(413, "worker diagnostics exceed byte limit");
    const row = await TestRunModel.findOne(selector).read("primary").lean();
    if (!row) throw new TestRunError(404, "published test run or occurrence not found");
    if (row.payloadSha256 !== input.payloadSha256) throw new TestRunError(409, "test run payload binding differs");
    const run = testRunSchema.safeParse(row.payload);
    if (!run.success || run.data.runId !== row.runId || !row.uploadsComplete)
      throw new TestRunError(409, "completed test run with settled asset uploads required");
    const originalIds = [...new Set((run.data.failures ?? []).flatMap(failure => failure.incidentIds))];
    try {
      // Immutable failure order selects the canonical original incident for the run;
      // multiple failed steps never force callers to invent a report or owner.
      const reportId = row.diagnosticsReportId ?? originalIds[0]
        ?? (await ensureTestRunReport(row.runId, row.payloadSha256)).reportId;
      const report = await ReportModel.findOne({ reportId }).select({ mentraUserId: 1, status: 1 }).lean();
      if (!report) throw new TestRunError(404, "associated incident not found");
      // Freeze once on this accepted run. Original device-filed reports keep their owner.
      await TestRunModel.updateOne({ runId: row.runId, payloadSha256: row.payloadSha256,
        diagnosticsReportId: { $exists: false } }, { $set: { diagnosticsReportId: reportId } },
        { writeConcern: { w: "majority", j: true, wtimeout: 10_000 } });
      const bound = await TestRunModel.findOne({ runId: row.runId }).select({ diagnosticsReportId: 1 }).lean();
      if (bound?.diagnosticsReportId !== reportId) throw new TestRunError(409, "incident binding changed");
      const result = await addLogArtifact({ mentraUserId: report.mentraUserId, reportId, source, entries: input.entries },
        { key: `${row.runId}\n${source}\n${input.attachmentKey}`, storage: this.storage });
      if (!result?.receipt) throw new TestRunError(503, "incident attachment was not acknowledged");
      // Only finish the incident created by this adapter; an original app report may
      // still be collecting phone/glasses logs and owns its own completion boundary.
      if (originalIds.length === 0 && report.status === "collecting")
        await markReportReady({ mentraUserId: report.mentraUserId, reportId, onlyCollecting: true });
      return { schemaVersion: 1 as const, runId: row.runId, payloadSha256: row.payloadSha256,
        attachmentKey: input.attachmentKey, reportId, ...result.receipt, stored: true as const };
    } catch (error) {
      if (error instanceof TestRunError) throw error;
      if (error instanceof ReportArtifactError) throw new TestRunError(error.status, error.message);
      // Provider/database errors may contain endpoints or credentials. Leave the reserved
      // attachment retryable and return only this bounded error; never claim success.
      throw new TestRunError(503, "incident attachment storage unavailable; retry identical request");
    }
  }
}

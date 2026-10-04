import {createHash} from "node:crypto";
import {z} from "zod";
import {ReportModel} from "../models/report.model";
import {frameworkIdentitySchema} from "../types/framework-request.types";
import {addLogArtifact, markReportReady, ReportArtifactError} from "./report.service";
import {REPORT_TESTING_SOURCE} from "./report-category";
import {requestInputDigest} from "./test-request.service";
import {TestRunError} from "./test-result-error";

export const STATE_REPAIR_DIAGNOSTIC_BYTES = 10 * 1024 * 1024;
export const stateRepairDiagnosticSchema = z.object({
  ownerId: frameworkIdentitySchema,
  generation: z.number().int().nonnegative().safe(),
  source: z.literal("state-repair"),
  originalFailure: z.unknown(),
  entries: z.array(z.object({timestamp: z.number().finite(), level: z.string().min(1).max(40),
    message: z.string().max(STATE_REPAIR_DIAGNOSTIC_BYTES), source: z.string().max(200).optional()}).strict()).min(1).max(1000),
  key: frameworkIdentitySchema,
  payloadSha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
type ReportOwner = {reportId: string; mentraUserId: string};

/** Repair diagnostics use the existing incident and blob stores; they never alter a run's frozen evidence. */
async function ensureRepairReport(hostId: string, interruptionId: string, failure: unknown): Promise<ReportOwner> {
  const digest = createHash("sha256").update(`state-repair\n${hostId}\n${interruptionId}`).digest("hex").slice(0, 32);
  const reportId = `rep_${BigInt(`0x${digest}`).toString(32).padStart(26, "0").toUpperCase()}`;
  const mentraUserId = "automation:state-repair", failureSha256 = requestInputDigest(failure);
  const context = {hostId, interruptionId, failureSha256};
  const document = {reportId, mentraUserId, kind: "automatic", status: "collecting", artifacts: [], context,
    trigger: {type: "automatic", source: REPORT_TESTING_SOURCE, reason: "lane-state-restoration"},
    report: {actualBehavior: "Testing lane state required restoration.", originalFailure: failure}};
  try {
    await ReportModel.updateOne({reportId}, {$setOnInsert: document},
      {upsert: true, writeConcern: {w: "majority", j: true, wtimeout: 10_000}});
  } catch (error) {if ((error as {code?: number}).code !== 11000) throw error;}
  const row = await ReportModel.findOne({reportId}).read("primary").readConcern("majority").lean();
  if (!row || row.mentraUserId !== mentraUserId || row.kind !== "automatic" || requestInputDigest(row.context) !== requestInputDigest(context))
    throw new ReportArtifactError(409, "Repair incident identity or original failure changed");
  return {reportId, mentraUserId};
}

type Dependencies = {
  ensure: typeof ensureRepairReport;
  attach: typeof addLogArtifact;
  ready: typeof markReportReady;
};

export class StateRepairDiagnosticsService {
  constructor(private readonly dependencies: Dependencies = {ensure: ensureRepairReport, attach: addLogArtifact, ready: markReportReady}) {}

  async publish(hostId: string, interruptionId: string, input: unknown) {
    if (!frameworkIdentitySchema.safeParse(hostId).success || !frameworkIdentitySchema.safeParse(interruptionId).success)
      throw new TestRunError(400, "Invalid repair identity");
    const parsed = stateRepairDiagnosticSchema.safeParse(input);
    if (!parsed.success || !Object.hasOwn(input as object, "originalFailure"))
      throw new TestRunError(400, "Invalid repair diagnostics");
    // Hash the original finite JSON envelope. Schema normalization must not silently discard submitted data.
    const {payloadSha256, ...payload} = input as z.infer<typeof stateRepairDiagnosticSchema>;
    let digest: string;
    try {digest = requestInputDigest(payload);} catch {throw new TestRunError(400, "Repair diagnostics must be finite JSON");}
    if (digest !== payloadSha256) throw new TestRunError(409, "Repair diagnostic digest differs");
    // SQLite and JSON callers can reorder keys. Use the report log format for the byte receipt.
    const entries = payload.entries.map(({timestamp, level, message, source}) =>
      ({timestamp, level, message, ...(source === undefined ? {} : {source})}));
    const bytes = Buffer.from(JSON.stringify({entries}), "utf8");
    if (bytes.byteLength > STATE_REPAIR_DIAGNOSTIC_BYTES) throw new TestRunError(413, "Repair diagnostic attachment exceeds its bound");
    const report = await this.dependencies.ensure(hostId, interruptionId, payload.originalFailure);
    const key = requestInputDigest({ownerId: payload.ownerId, generation: payload.generation, key: payload.key});
    const result = await this.dependencies.attach({...report, source: payload.source, entries}, {key});
    const expectedSha256 = createHash("sha256").update(bytes).digest("hex");
    if (!result?.receipt || result.stored !== 1 || result.receipt.sha256 !== expectedSha256 || result.receipt.sizeBytes !== bytes.byteLength)
      throw new ReportArtifactError(503, "Repair diagnostic storage acknowledgement differs");
    // A duplicate may already be ready. The attachment receipt, not a second notification, establishes custody.
    await this.dependencies.ready({...report, onlyCollecting: true});
    return {hostId, interruptionId, ownerId: payload.ownerId, generation: payload.generation,
      reportId: report.reportId, ...result.receipt, payloadSha256};
  }
}

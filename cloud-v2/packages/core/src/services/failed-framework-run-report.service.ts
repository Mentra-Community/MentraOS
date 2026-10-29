import {createHash} from "node:crypto"
import {
  frameworkEvidenceComplete,
  frameworkRunOutcome,
  recordedFrameworkRunSchema,
  type RecordedFrameworkRun,
} from "../types/framework-run.types"
import {addLogArtifact, ensureTestRunReport, referenceTestRunDiagnostics, ReportArtifactError} from "./report.service"
import {ReportSlackDeliveryService} from "./report-slack-delivery.service"
import {REPORT_TESTING_SOURCE} from "./report-category"
import {requestInputDigest} from "./test-request.service"

const MAX_FAILURES = 20,
  MAX_ASSET_LINKS = 50,
  MAX_MESSAGE_CHARS = 1000
export const FAILED_RUN_DIAGNOSTIC_BYTES = 128 * 1024
export function failedRunNeedsReport(run: RecordedFrameworkRun) {
  return (
    run.result.setup.status === "failed" ||
    run.result.test === "failed" ||
    (!run.result.teardown.ready && run.result.test !== "cancelled" && run.result.setup.status !== "cancelled") ||
    run.result.failures.length > 0
  )
}
function adminBase() {
  const configured = process.env.CLOUD_ADMIN_CONSOLE_URL
  if (configured) {
    const url = new URL(/^https?:\/\//i.test(configured) ? configured : `https://${configured}`)
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
      throw new ReportArtifactError(503, "Incident run link origin is unavailable")
    return url.origin
  }
  const env = process.env.CLOUD_CORE_ENVIRONMENT
  return env === "prod" || env === "production"
    ? "https://admin.mentraglass.com"
    : env === "dev" || env === "staging"
    ? `https://admin.${env}.mentraglass.com`
    : null
}
export function failedRunDiagnostics(run: RecordedFrameworkRun) {
  const failures = run.result.failures.slice(0, MAX_FAILURES).map(({phase, actionId, message}) => ({
    phase,
    actionId,
    message: message.slice(0, MAX_MESSAGE_CHARS),
    ...(message.length > MAX_MESSAGE_CHARS ? {messageTruncated: true} : {}),
  }))
  const base = adminBase(),
    runId = run.result.runId
  const failedSteps = run.result.steps.filter((step) => step.status === "failed").map(({id}) => id)
  const assetPriority = (asset: RecordedFrameworkRun["assets"][number]) =>
    asset.kind === "screenshot" ? 0 : asset.kind === "recording" ? 2 : 1
  const selectedAssets = [...run.assets]
    .sort((a, b) => assetPriority(a) - assetPriority(b))
    .slice(0, MAX_ASSET_LINKS)
  const source = run.build.source as {channel?: unknown; buildRunId?: unknown; publicationAttempt?: unknown} | undefined
  const blobIdentity = (value: unknown) => {
    const blob = value as {sha256?: unknown; size?: unknown} | null
    return blob &&
      typeof blob.sha256 === "string" &&
      /^[a-f0-9]{64}$/.test(blob.sha256) &&
      typeof blob.size === "number" &&
      Number.isSafeInteger(blob.size) &&
      blob.size > 0
      ? {sha256: blob.sha256, size: blob.size}
      : undefined
  }
  const archive = blobIdentity(run.build.archive),
    receipt = blobIdentity(run.build.receipt)
  const build = {
    repository: run.build.repository,
    channel: run.build.channel,
    headSha: run.build.headSha,
    ...(archive ? {archive} : {}),
    ...(receipt ? {receipt} : {}),
    ...(run.build.prNumber ? {prNumber: run.build.prNumber} : {}),
    ...(typeof run.build.releaseIdentity === "string"
      ? {releaseIdentity: run.build.releaseIdentity.slice(0, 200)}
      : {}),
    ...(source && Number.isSafeInteger(source.buildRunId) && Number.isSafeInteger(source.publicationAttempt)
      ? {
          source: {
            channel: run.build.channel,
            buildRunId: source.buildRunId,
            publicationAttempt: source.publicationAttempt,
          },
        }
      : {}),
  }
  return {
    runId,
    requestId: run.requestId,
    hostId: run.hostId,
    laneId: run.laneId,
    routineId: run.routineId,
    platform: run.platform,
    definitionRevision: run.definitionRevision,
    ...(run.routineSource ? {routineSourceRevision: run.routineSource.commit} : {}),
    ...(run.frameworkBinding ? {frameworkRevision: run.frameworkBinding.revision} : {}),
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    build,
    outcome: frameworkRunOutcome(run),
    evidenceComplete: frameworkEvidenceComplete(run),
    phases: [...new Set(run.result.failures.map((failure) => failure.phase))],
    failures,
    omittedFailures: Math.max(0, run.result.failures.length - MAX_FAILURES),
    failedStepIds: failedSteps.slice(0, 100),
    omittedFailedSteps: Math.max(0, failedSteps.length - 100),
    setup: run.result.setup.status,
    test: run.result.test,
    teardownReady: run.result.teardown.ready,
    ...(base
      ? {
          runUrl: `${base}/?testRun=${encodeURIComponent(runId)}`,
          assetManifestUrl: `${base}/api/admin/routine-catalog/results/by-run/${encodeURIComponent(runId)}`,
        }
      : {}),
    assets: selectedAssets.map(({id, kind, size, sha256}) => ({
      id,
      kind,
      size,
      sha256,
      ...(base
        ? {
            url: `${base}/api/admin/routine-catalog/results/by-run/${encodeURIComponent(
              runId,
            )}/assets/${encodeURIComponent(id)}`,
          }
        : {}),
    })),
    omittedAssets: Math.max(0, run.assets.length - MAX_ASSET_LINKS),
    diagnosticAttachments: run.assets.filter((asset) => asset.kind === "diagnostic" || asset.kind === "report" || asset.kind === "screenshot").length,
    assetAccess:
      "Every native diagnostic/report and screenshot blob is attached by reference with its original bytes. Recordings remain in the authenticated run manifest; this summary caps individual links.",
  }
}
function boundedDiagnostics(run: RecordedFrameworkRun) {
  const diagnostic = failedRunDiagnostics(run)
  const size = () =>
    Buffer.byteLength(
      JSON.stringify({
        entries: [
          {
            timestamp: Date.parse(run.finishedAt),
            level: "error",
            source: "framework-result",
            message: JSON.stringify(diagnostic),
          },
        ],
      }),
    )
  // Reserve headroom for the report binding added by ensureTestRunReport. JSON
  // escaping and multi-byte cause text count toward the actual byte budget.
  while (size() > FAILED_RUN_DIAGNOSTIC_BYTES - 1024 && diagnostic.assets.length) {
    diagnostic.assets.pop()
    diagnostic.omittedAssets++
  }
  while (size() > FAILED_RUN_DIAGNOSTIC_BYTES - 1024 && diagnostic.failures.length > 1) {
    diagnostic.failures.pop()
    diagnostic.omittedFailures++
  }
  return diagnostic
}
type Dependencies = {
  ensure: typeof ensureTestRunReport
  attach: typeof addLogArtifact
  references: typeof referenceTestRunDiagnostics
  delivery: Pick<ReportSlackDeliveryService, "complete">
}
export class FailedFrameworkRunReportService {
  constructor(
    private readonly dependencies: Dependencies = {
      ensure: ensureTestRunReport,
      attach: addLogArtifact,
      references: referenceTestRunDiagnostics,
      delivery: new ReportSlackDeliveryService(),
    },
  ) {}

  async complete(payload: RecordedFrameworkRun, payloadSha256: string) {
    const run = recordedFrameworkRunSchema.parse(payload)
    if (requestInputDigest(run) !== payloadSha256)
      throw new ReportArtifactError(409, "Routine incident frozen result digest differs")
    if (!failedRunNeedsReport(run)) return undefined
    let diagnostic: Record<string, unknown> = boundedDiagnostics(run)
    const first = run.result.failures[0]
    let actualBehavior = `${run.routineId} (${run.platform}) completed with ${diagnostic.outcome}${
      first ? `: ${first.phase}/${first.actionId}: ${first.message.slice(0, MAX_MESSAGE_CHARS)}` : "."
    }`
    let expectedBehavior = "The complete routine setup, product steps, teardown and evidence publication succeed."
    const owner = await this.dependencies.ensure(run.result.runId, payloadSha256, {
      actualBehavior,
      expectedBehavior,
      context: diagnostic,
    })
    // Retries use the first durable snapshot, even when deployment link config changes.
    diagnostic = owner.context ?? diagnostic
    actualBehavior = owner.report?.actualBehavior ?? actualBehavior
    expectedBehavior = owner.report?.expectedBehavior ?? expectedBehavior
    const entries = [
      {
        timestamp: Date.parse(run.finishedAt),
        level: "error",
        source: "framework-result",
        message: JSON.stringify(diagnostic),
      },
    ]
    const bytes = Buffer.from(JSON.stringify({entries}), "utf8")
    if (bytes.byteLength > FAILED_RUN_DIAGNOSTIC_BYTES)
      throw new ReportArtifactError(503, "Routine incident diagnostic exceeds its bound")
    const referenced = await this.dependencies.references(owner, run)
    const attachment = await this.dependencies.attach(
      {...owner, source: "framework-result", entries},
      {key: "frozen-run-failure-v1"},
    )
    if (
      !attachment?.receipt ||
      attachment.stored !== 1 ||
      attachment.receipt.sha256 !== createHash("sha256").update(bytes).digest("hex") ||
      attachment.receipt.sizeBytes !== bytes.byteLength
    )
      throw new ReportArtifactError(503, "Routine incident diagnostic acknowledgement differs")
    const slack = await this.dependencies.delivery.complete({
      reportId: owner.reportId,
      mentraUserId: owner.mentraUserId,
      kind: "automatic",
      trigger: {type: "automatic", source: REPORT_TESTING_SOURCE, reason: "routine-run-failed"},
      report: {actualBehavior, expectedBehavior},
      context: diagnostic,
      artifactCount: 1 + referenced,
    })
    return {reportId: owner.reportId, artifactId: attachment.receipt.artifactId, slack}
  }
}

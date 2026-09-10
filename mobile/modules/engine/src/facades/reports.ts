/**
 * reports facade — `engine.reports`: user/system report submission over the
 * Cloud V2 core client.
 *
 * Host/OEM code owns UI and wording. Engine owns MentraOS mechanics: context
 * collection, recent phone logs, Cloud V2 calls, local automatic throttling,
 * screenshots, and notifying connected glasses.
 */
import BluetoothSdk from "@mentra/bluetooth-sdk/internal"
import type {ReportAttachmentInput, ReportContext, ReportStatus, SubmitReportInput} from "@mentra/cloud-client"
import {useGlassesStore} from "../stores/glasses"
import {isGlassesConnected} from "../services/GlassesReadiness"
import {cloudClientService} from "../services/CloudClientService"
import {collectDiagnosticContext} from "../utils/diagnosticContext"
import {logBuffer} from "../utils/devLogging"

export type {
  ReportAttachmentInput,
  ReportContext,
  ReportDetails,
  ReportStatus,
  ReportTrigger,
} from "@mentra/cloud-client"

export type EngineSubmitReportInput =
  | (Omit<Extract<SubmitReportInput, {kind: "bug"}>, "context"> & {
      context?: Partial<ReportContext>
      screenshots?: ReportAttachmentInput[]
    })
  | (Omit<Extract<SubmitReportInput, {kind: "feedback"}>, "context"> & {
      context?: Partial<ReportContext>
    })

export type EngineSubmitAutomaticReportInput = Omit<Extract<SubmitReportInput, {kind: "automatic"}>, "context"> & {
  context?: Partial<ReportContext>
  screenshots?: ReportAttachmentInput[]
  throttleKey?: string
  throttleWindowMs?: number
}

type InternalSubmitReportInput = EngineSubmitReportInput | EngineSubmitAutomaticReportInput

export type ReportSubmitResult =
  | {status: "submitted"; reportId: string; reportStatus: ReportStatus}
  | {status: "skipped"; reason: "throttled_within_window"}
  | {status: "failed"; error: string}

const DEFAULT_AUTOMATIC_REPORT_THROTTLE_MS = 90_000
const automaticReportThrottleRegistry = new Map<string, number>()

function automaticThrottleShouldSkip(key: string, nowMs: number, windowMs: number): boolean {
  const previous = automaticReportThrottleRegistry.get(key)
  if (previous !== undefined && nowMs - previous < windowMs) {
    return true
  }
  pruneAutomaticThrottleRegistry(nowMs, windowMs)
  return false
}

function markAutomaticThrottleSuccess(key: string, nowMs: number, windowMs: number): void {
  automaticReportThrottleRegistry.set(key, nowMs)
  pruneAutomaticThrottleRegistry(nowMs, windowMs)
}

function pruneAutomaticThrottleRegistry(nowMs: number, windowMs: number): void {
  for (const [entryKey, entryTime] of automaticReportThrottleRegistry) {
    if (nowMs - entryTime > windowMs * 3) {
      automaticReportThrottleRegistry.delete(entryKey)
    }
  }
}

function notifyGlasses(reportId: string, apiBaseUrl?: string | null): void {
  if (!isGlassesConnected(useGlassesStore.getState().connection)) return
  void (async () => {
    try {
      await cloudClientService.syncCoreTokenToBluetooth()
      await BluetoothSdk.sendIncidentId(reportId, apiBaseUrl ?? cloudClientService.getCoreUrl())
    } catch (error) {
      console.warn("reports.submit: notify glasses failed:", error instanceof Error ? error.message : error)
    }
  })()
}

async function submitReportInternal(input: InternalSubmitReportInput): Promise<ReportSubmitResult> {
  if (!cloudClientService.hasCore()) {
    return {status: "failed", error: "Reports are unavailable in this deployment"}
  }
  const throttle =
    input.kind === "automatic" && input.throttleKey
      ? {
          key: input.throttleKey,
          windowMs: input.throttleWindowMs ?? DEFAULT_AUTOMATIC_REPORT_THROTTLE_MS,
        }
      : null

  if (input.kind === "automatic" && input.throttleKey) {
    const shouldSkip = automaticThrottleShouldSkip(
      input.throttleKey,
      Date.now(),
      throttle?.windowMs ?? DEFAULT_AUTOMATIC_REPORT_THROTTLE_MS,
    )
    if (shouldSkip) return {status: "skipped", reason: "throttled_within_window"}
  }

  const context = await collectDiagnosticContext(input.context)
  let reportId: string
  let reportStatus: ReportStatus
  let artifactsComplete = true
  try {
    const res =
      input.kind === "feedback"
        ? await cloudClientService.core.reports.submit({
            kind: "feedback",
            feedback: input.feedback,
            context,
          })
        : input.kind === "bug"
          ? await cloudClientService.core.reports.submit({
              kind: "bug",
              trigger: input.trigger,
              report: input.report,
              context,
            })
          : await cloudClientService.core.reports.submit({
              kind: "automatic",
              trigger: input.trigger,
              report: input.report,
              context,
            })
    reportId = res.reportId
    reportStatus = res.status
  } catch (error) {
    return {status: "failed", error: error instanceof Error ? error.message : String(error)}
  }

  if (input.kind !== "feedback") {
    const logs = logBuffer.getRecentLogs()
    if (logs.length > 0) {
      try {
        await cloudClientService.core.reports.addLogs(reportId, "phone", logs)
      } catch (error) {
        artifactsComplete = false
        console.warn("reports.submit: add phone logs failed:", error instanceof Error ? error.message : error)
      }
    }

    notifyGlasses(reportId, cloudClientService.getCoreUrl())

    if (input.screenshots && input.screenshots.length > 0) {
      try {
        await cloudClientService.core.reports.addScreenshots(reportId, input.screenshots)
      } catch (error) {
        artifactsComplete = false
        console.warn("reports.submit: add screenshots failed:", error instanceof Error ? error.message : error)
      }
    }

    try {
      const completed = await cloudClientService.core.reports.complete(reportId)
      reportStatus = completed.status
    } catch (error) {
      artifactsComplete = false
      console.warn("reports.submit: complete report failed:", error instanceof Error ? error.message : error)
    }
  }

  if (throttle && artifactsComplete) {
    markAutomaticThrottleSuccess(throttle.key, Date.now(), throttle.windowMs)
  }

  return {status: "submitted", reportId, reportStatus}
}

export const reports = {
  submit(input: EngineSubmitReportInput): Promise<ReportSubmitResult> {
    return submitReportInternal(input)
  },
}

export function submitAutomaticReport(input: EngineSubmitAutomaticReportInput): Promise<ReportSubmitResult> {
  return submitReportInternal(input)
}

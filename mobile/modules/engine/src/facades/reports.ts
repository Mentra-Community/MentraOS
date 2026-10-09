/**
 * reports facade — `engine.reports`: user/system report submission over the
 * Cloud V2 core client.
 *
 * Host/OEM code owns UI and wording. Engine owns MentraOS mechanics: context
 * collection, recent phone logs, Cloud V2 calls, local automatic throttling,
 * screenshots, and notifying connected glasses.
 */
import BluetoothSdk from "@mentra/bluetooth-sdk/internal"
import type {
  ReportAttachmentInput,
  ReportContext,
  ReportLogCollectionUpdate,
  ReportLogSource,
  ReportStatus,
  SubmitReportInput,
} from "@mentra/cloud-client"
import {useGlassesStore} from "../stores/glasses"
import {isGlassesConnected} from "../services/GlassesReadiness"
import {cloudClientService} from "../services/CloudClientService"
import {collectDiagnosticContext} from "../utils/diagnosticContext"
import {logBuffer} from "../utils/devLogging"
import {BgTimer} from "../utils/timers"

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
const INCIDENT_DISPATCH_TIMEOUT_MS = 10_000
const MAX_PHONE_DELIVERY_LOGS = 500
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

async function notifyGlasses(reportId: string): Promise<ReportLogCollectionUpdate> {
  if (!isGlassesConnected(useGlassesStore.getState().connection)) {
    return {state: "unavailable", reason: "glasses_disconnected"}
  }
  let expired = false
  let stage: "core_token_sync" | "incident_dispatch" = "core_token_sync"
  let timer: number | undefined
  const dispatch = (async (): Promise<ReportLogCollectionUpdate> => {
    try {
      await cloudClientService.syncCoreTokenToBluetooth()
      if (expired) return {state: "failed", reason: "incident_dispatch_timeout"}
      if (!isGlassesConnected(useGlassesStore.getState().connection)) {
        return {state: "unavailable", reason: "glasses_disconnected"}
      }
      stage = "incident_dispatch"
      await BluetoothSdk.sendIncidentId(reportId, cloudClientService.getCoreUrl())
      // This confirms only the local SDK invocation, not BLE delivery or upload.
      return {state: "requested", reason: "local_sdk_dispatch_completed"}
    } catch {
      return {state: "failed", reason: `${stage}_failed`}
    }
  })()
  try {
    return await Promise.race([
      dispatch,
      new Promise<ReportLogCollectionUpdate>((resolve) => {
        timer = BgTimer.setTimeout(() => {
          expired = true
          resolve({state: "failed", reason: "incident_dispatch_timeout"})
        }, INCIDENT_DISPATCH_TIMEOUT_MS)
      }),
    ])
  } finally {
    if (timer !== undefined) BgTimer.clearTimeout(timer)
  }
}

async function updateLogCollection(
  reportId: string,
  source: ReportLogSource,
  update: ReportLogCollectionUpdate,
): Promise<boolean> {
  try {
    await cloudClientService.core.reports.updateLogCollection(reportId, source, update)
    return true
  } catch {
    logBuffer.append({
      level: "warn",
      source: "reports",
      message: `Report ${reportId}: ${source} collection status could not be stored`,
    })
    return false
  }
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
    const originalLogs = new Set(logs)
    try {
      await cloudClientService.core.reports.addLogs(reportId, "phone", logs)
    } catch {
      artifactsComplete = false
      await updateLogCollection(reportId, "phone", {state: "failed", reason: "phone_log_upload_failed"})
    }

    const dispatch = await notifyGlasses(reportId)
    for (const source of ["glasses", "glasses_firmware"] as const) {
      if (!(await updateLogCollection(reportId, source, dispatch))) artifactsComplete = false
    }
    logBuffer.append({
      level: dispatch.state === "failed" ? "warn" : "info",
      source: "reports",
      message: `Report ${reportId}: glasses log notification ${dispatch.state} (${dispatch.reason})`,
    })
    let deliveryLogs = logBuffer.getRecentLogs().filter((entry) => !originalLogs.has(entry))
    if (deliveryLogs.length > MAX_PHONE_DELIVERY_LOGS) {
      deliveryLogs = [
        ...deliveryLogs.slice(-(MAX_PHONE_DELIVERY_LOGS - 1)),
        {
          timestamp: Date.now(),
          level: "warn",
          source: "reports",
          message: `Report ${reportId}: phone delivery logs omitted ${deliveryLogs.length - MAX_PHONE_DELIVERY_LOGS + 1} earlier entries`,
        },
      ]
    }
    try {
      await cloudClientService.core.reports.addLogs(reportId, "phone_delivery", deliveryLogs)
    } catch {
      artifactsComplete = false
      console.warn(`reports.submit: Report ${reportId}: phone delivery diagnostics could not be stored`)
    }

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

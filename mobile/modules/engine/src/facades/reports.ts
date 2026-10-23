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
  ReportLogCollection,
  ReportLogCollectionUpdate,
  ReportLogSource,
  ReportStatus,
  SubmitReportInput,
} from "@mentra/cloud-client"
import {useGlassesStore} from "../stores/glasses"
import {isGlassesConnected} from "../services/GlassesReadiness"
import {cloudClientService} from "../services/CloudClientService"
import {projectPairingIdentity} from "../services/PairingIdentity"
import {requiredDeviceReportLogSources} from "../services/reportLogSources"
import {DeviceTypes} from "../types"
import {collectDiagnosticContext} from "../utils/diagnosticContext"
import {logBuffer} from "../utils/devLogging"
import {assertReportNotAborted} from "../utils/reportAbort"
import {BgTimer} from "../utils/timers"

export type {
  ReportAttachmentInput,
  ReportContext,
  ReportDetails,
  ReportLogCollection,
  ReportLogSource,
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

type AutomaticSubmitReportInput = Extract<SubmitReportInput, {kind: "automatic"}> & {incidentKey?: string}

export type EngineSubmitAutomaticReportInput = Omit<AutomaticSubmitReportInput, "context"> & {
  context?: Partial<ReportContext>
  screenshots?: ReportAttachmentInput[]
  throttleKey?: string
  throttleWindowMs?: number
  /**
   * Request glasses log upload (`upload_incident_logs`) for the new report.
   * Defaults to true. Pass false when the caller must first hand the reportId
   * to the glasses, then call `requestGlassesReportLogs` itself.
   */
  notifyGlasses?: boolean
}

type ReportSubmissionOptions = {signal: AbortSignal; onCreated: (reportId: string) => void}

type InternalSubmitReportInput = EngineSubmitReportInput | EngineSubmitAutomaticReportInput

export type ReportSubmitResult =
  | {status: "submitted"; reportId: string; reportStatus: ReportStatus}
  | {status: "skipped"; reason: "throttled_within_window"}
  | {status: "failed"; error: string}

export type ReportCollectionResult = {
  reportId: string
  state: "complete" | "failed" | "timed-out" | "unavailable"
  logCollection: Partial<Record<ReportLogSource, ReportLogCollection>>
}

/** Collection failure retains safe receipts without exposing transport errors or source log contents. */
export class ReportCollectionError extends Error {
  constructor(readonly collection: ReportCollectionResult) {
    super("Report log collection did not complete")
    this.name = "ReportCollectionError"
  }
}

const DEFAULT_AUTOMATIC_REPORT_THROTTLE_MS = 90_000
const INCIDENT_DISPATCH_TIMEOUT_MS = 10_000
const MAX_PHONE_DELIVERY_LOGS = 500
const REPORT_COLLECTION_TIMEOUT_MS = 20_000
const REPORT_COLLECTION_POLL_MS = 500
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

async function notifyGlasses(reportId: string, signal?: AbortSignal): Promise<ReportLogCollectionUpdate> {
  assertReportNotAborted(signal)
  if (!requiredDeviceReportLogSources(projectPairingIdentity()).some((source) => source === "glasses")) {
    return {state: "unavailable", reason: "no_paired_mentra_live"}
  }
  if (!isGlassesConnected(useGlassesStore.getState().connection)) {
    return {state: "unavailable", reason: "glasses_disconnected"}
  }
  let expired = false
  let stage: "core_token_sync" | "connection_read" | "incident_dispatch" = "core_token_sync"
  let timer: number | undefined
  let abortDispatch: (() => void) | undefined
  const dispatch = (async (): Promise<ReportLogCollectionUpdate> => {
    try {
      await cloudClientService.syncCoreTokenToBluetooth()
      if (expired || signal?.aborted) return {state: "failed", reason: "incident_dispatch_timeout"}
      if (!requiredDeviceReportLogSources(projectPairingIdentity()).some((source) => source === "glasses")) {
        return {state: "unavailable", reason: "no_paired_mentra_live"}
      }
      if (!isGlassesConnected(useGlassesStore.getState().connection)) {
        return {state: "unavailable", reason: "glasses_disconnected"}
      }
      // The engine mirror can be stale after a native disconnect. Read the SDK
      // immediately before dispatch; the native sender checks the link again.
      stage = "connection_read"
      const native = await BluetoothSdk.getGlassesStatus()
      if (expired || signal?.aborted) return {state: "failed", reason: "incident_dispatch_timeout"}
      if (!isGlassesConnected(native.connection)) {
        return {state: "unavailable", reason: "glasses_disconnected"}
      }
      // Live's deviceModel can be its hardware variant (for example K900).
      // Pairing identity supplies the canonical product; reject Phone Mode's
      // simulated native link without inventing a second hardware-model map.
      if (
        native.deviceModel.includes(DeviceTypes.SIMULATED) ||
        !requiredDeviceReportLogSources(projectPairingIdentity()).some((source) => source === "glasses")
      ) {
        return {state: "unavailable", reason: "no_connected_mentra_live"}
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
        abortDispatch = () => {
          expired = true
          resolve({state: "failed", reason: "incident_dispatch_timeout"})
        }
        timer = BgTimer.setTimeout(abortDispatch, INCIDENT_DISPATCH_TIMEOUT_MS)
        signal?.addEventListener("abort", abortDispatch, {once: true})
        if (signal?.aborted) abortDispatch()
      }),
    ])
  } finally {
    if (timer !== undefined) BgTimer.clearTimeout(timer)
    if (abortDispatch) signal?.removeEventListener("abort", abortDispatch)
  }
}

async function updateLogCollection(
  reportId: string,
  source: ReportLogSource,
  update: ReportLogCollectionUpdate,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    assertReportNotAborted(signal)
    if (signal) await cloudClientService.core.reports.updateLogCollection(reportId, source, update, signal)
    else await cloudClientService.core.reports.updateLogCollection(reportId, source, update)
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

function automaticSubmitBody(
  input: EngineSubmitAutomaticReportInput,
  context: ReportContext,
): AutomaticSubmitReportInput {
  return {
    kind: "automatic",
    ...(input.automationCorrelation ? {automationCorrelation: input.automationCorrelation} : {}),
    ...(input.incidentKey ? {incidentKey: input.incidentKey} : {}),
    trigger: input.trigger,
    report: input.report,
    context,
  }
}

/**
 * Ask the connected glasses to upload their logs for `reportId` and record the
 * dispatch outcome on the report's glasses log-collection receipts.
 */
export async function requestGlassesReportLogs(
  reportId: string,
  signal?: AbortSignal,
): Promise<{
  dispatch: ReportLogCollectionUpdate
  receiptsStored: boolean
}> {
  const dispatch = await notifyGlasses(reportId, signal)
  let receiptsStored = true
  for (const source of ["glasses", "glasses_firmware"] as const) {
    if (!(await updateLogCollection(reportId, source, dispatch, signal))) receiptsStored = false
  }
  logBuffer.append({
    level: dispatch.state === "failed" ? "warn" : "info",
    source: "reports",
    message: `Report ${reportId}: glasses log notification ${dispatch.state} (${dispatch.reason})`,
  })
  return {dispatch, receiptsStored}
}

async function submitReportInternal(
  input: InternalSubmitReportInput,
  options?: ReportSubmissionOptions,
): Promise<ReportSubmitResult> {
  const signal = options?.signal
  assertReportNotAborted(signal)
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
  assertReportNotAborted(signal)
  let reportId: string
  let reportStatus: ReportStatus
  let artifactsComplete = true
  try {
    const payload: SubmitReportInput =
      input.kind === "feedback"
        ? {kind: "feedback", feedback: input.feedback, context}
        : input.kind === "bug"
          ? {kind: "bug", trigger: input.trigger, report: input.report, context}
          : automaticSubmitBody(input, context)
    const res = signal
      ? await cloudClientService.core.reports.submit(payload, signal)
      : await cloudClientService.core.reports.submit(payload)
    reportId = res.reportId
    options?.onCreated(reportId)
    assertReportNotAborted(signal)
    reportStatus = res.status
  } catch (error) {
    return {status: "failed", error: error instanceof Error ? error.message : String(error)}
  }

  if (input.kind !== "feedback") {
    const logs = logBuffer.getRecentLogs()
    const originalLogs = new Set(logs)
    // Dispatch immediately; slow phone HTTP must not delay the glasses relay.
    const notification = (async () => {
      if (input.kind === "automatic" && input.notifyGlasses === false) return
      const {receiptsStored} = await requestGlassesReportLogs(reportId, signal)
      if (!receiptsStored) artifactsComplete = false
    })()
    const phoneUpload = (async () => {
      try {
        if (signal) await cloudClientService.core.reports.addLogs(reportId, "phone", logs, {signal})
        else await cloudClientService.core.reports.addLogs(reportId, "phone", logs)
      } catch {
        artifactsComplete = false
        await updateLogCollection(reportId, "phone", {state: "failed", reason: "phone_log_upload_failed"}, signal)
      }
    })()
    const screenshotUpload = (async () => {
      if (!input.screenshots?.length) return
      try {
        assertReportNotAborted(signal)
        await cloudClientService.core.reports.addScreenshots(reportId, input.screenshots, signal)
      } catch (error) {
        artifactsComplete = false
        console.warn("reports.submit: add screenshots failed:", error instanceof Error ? error.message : error)
      }
    })()
    // A failed source never skips another independent upload.
    const attachments = await Promise.allSettled([notification, phoneUpload, screenshotUpload])
    assertReportNotAborted(signal)
    if (attachments.some((result) => result.status === "rejected")) artifactsComplete = false
    let deliveryLogs = logBuffer.getRecentLogs().filter((entry) => !originalLogs.has(entry))
    if (deliveryLogs.length > MAX_PHONE_DELIVERY_LOGS) {
      deliveryLogs = [
        ...deliveryLogs.slice(-(MAX_PHONE_DELIVERY_LOGS - 1)),
        {
          timestamp: Date.now(),
          level: "warn",
          source: "reports",
          message: `Report ${reportId}: phone delivery logs omitted ${
            deliveryLogs.length - MAX_PHONE_DELIVERY_LOGS + 1
          } earlier entries`,
        },
      ]
    }
    try {
      assertReportNotAborted(signal)
      if (signal) await cloudClientService.core.reports.addLogs(reportId, "phone_delivery", deliveryLogs, {signal})
      else await cloudClientService.core.reports.addLogs(reportId, "phone_delivery", deliveryLogs)
    } catch {
      artifactsComplete = false
      console.warn(`reports.submit: Report ${reportId}: phone delivery diagnostics could not be stored`)
    }

    try {
      assertReportNotAborted(signal)
      const completed = await cloudClientService.core.reports.complete(reportId, signal)
      reportStatus = completed.status
    } catch (error) {
      artifactsComplete = false
      console.warn("reports.submit: complete report failed:", error instanceof Error ? error.message : error)
    }
  }

  if (throttle && artifactsComplete) {
    markAutomaticThrottleSuccess(throttle.key, Date.now(), throttle.windowMs)
  }

  assertReportNotAborted(signal)
  if (options && !artifactsComplete)
    return {status: "failed", error: "Incident attachment or completion did not finish"}
  return {status: "submitted", reportId, reportStatus}
}

const collectionTimestamp = (value: unknown): value is string =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString().slice(0, 19) === value.slice(0, 19)

/** Resolve only when every selected source has a stored artifact; failures reject with partial receipts. */
async function waitForCollection(
  reportId: string,
  options: {sources: ReportLogSource[]; timeoutMs?: number; signal?: AbortSignal},
): Promise<ReportCollectionResult> {
  const result: ReportCollectionResult = {reportId, state: "unavailable", logCollection: {}}
  const timeoutMs = options?.timeoutMs ?? REPORT_COLLECTION_TIMEOUT_MS
  if (
    !cloudClientService.hasCore() ||
    typeof reportId !== "string" ||
    !/^rep_[A-Za-z0-9]+$/.test(reportId) ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0 ||
    !Array.isArray(options?.sources)
  )
    throw new ReportCollectionError(result)
  const sources = [...new Set(options.sources)]
  if (!sources.every((source) => ["phone", "glasses", "glasses_firmware", "cloud", "miniapp_server"].includes(source)))
    throw new ReportCollectionError(result)
  if (sources.length === 0) return {...result, state: "complete"}

  if (options.signal?.aborted) throw new ReportCollectionError({...result, state: "timed-out"})
  const controller = new AbortController()
  const deadlineAt = Date.now() + timeoutMs
  let timeoutTimer: number | undefined
  let pollTimer: number | undefined
  let abortWait!: () => void
  const expired = new Promise<never>((_, reject) => {
    abortWait = () => {
      controller.abort(options.signal?.reason)
      reject(new ReportCollectionError({...result, state: "timed-out"}))
    }
    timeoutTimer = BgTimer.setTimeout(abortWait, timeoutMs)
  })
  options.signal?.addEventListener("abort", abortWait, {once: true})
  if (options.signal?.aborted) abortWait()
  try {
    while (!controller.signal.aborted) {
      const snapshot = await Promise.race([
        cloudClientService.core.reports.getLogCollection(reportId, controller.signal),
        expired,
      ])
      if (Date.now() >= deadlineAt) throw new ReportCollectionError({...result, state: "timed-out"})
      if (
        !snapshot ||
        snapshot.reportId !== reportId ||
        !snapshot.logCollection ||
        typeof snapshot.logCollection !== "object" ||
        Array.isArray(snapshot.logCollection)
      )
        throw new ReportCollectionError(result)
      const logCollection: ReportCollectionResult["logCollection"] = {}
      for (const source of ["phone", "glasses", "glasses_firmware", "cloud", "miniapp_server"] as const) {
        const receipt = snapshot.logCollection[source]
        if (receipt === undefined) continue
        if (
          !receipt ||
          typeof receipt !== "object" ||
          Array.isArray(receipt) ||
          !["requested", "received", "unavailable", "failed", "timed-out"].includes(receipt.state) ||
          !collectionTimestamp(receipt.requestedAt) ||
          !collectionTimestamp(receipt.deadlineAt) ||
          (receipt.receivedAt !== undefined && !collectionTimestamp(receipt.receivedAt)) ||
          (receipt.artifactId !== undefined &&
            (typeof receipt.artifactId !== "string" || !/^art_[A-Za-z0-9]{1,80}$/.test(receipt.artifactId))) ||
          (receipt.entryCount !== undefined &&
            (typeof receipt.entryCount !== "number" ||
              !Number.isSafeInteger(receipt.entryCount) ||
              receipt.entryCount < 0))
        )
          throw new ReportCollectionError(result)
        logCollection[source] = {
          state: receipt.state,
          requestedAt: receipt.requestedAt,
          deadlineAt: receipt.deadlineAt,
          ...(typeof receipt.receivedAt === "string" ? {receivedAt: receipt.receivedAt} : {}),
          ...(typeof receipt.artifactId === "string" ? {artifactId: receipt.artifactId} : {}),
          ...(typeof receipt.entryCount === "number" ? {entryCount: receipt.entryCount} : {}),
          ...(typeof receipt.reason === "string" ? {reason: receipt.reason.slice(0, 500)} : {}),
        }
      }
      result.logCollection = logCollection
      for (const source of sources) {
        const receipt = logCollection[source]
        if (!receipt) continue
        if (receipt.state === "received" && receipt.artifactId === undefined) throw new ReportCollectionError(result)
      }
      if (sources.every((source) => logCollection[source]?.state === "received")) return {...result, state: "complete"}
      if (sources.every((source) => logCollection[source] && logCollection[source]?.state !== "requested")) {
        const failure = sources
          .map((source) => logCollection[source])
          .find(
            (receipt) =>
              receipt?.state === "failed" || receipt?.state === "unavailable" || receipt?.state === "timed-out",
          )
        if (failure?.state === "failed" || failure?.state === "unavailable" || failure?.state === "timed-out")
          throw new ReportCollectionError({...result, state: failure.state})
      }
      await Promise.race([
        new Promise<void>((resolve) => {
          pollTimer = BgTimer.setTimeout(
            resolve,
            Math.min(REPORT_COLLECTION_POLL_MS, Math.max(0, deadlineAt - Date.now())),
          )
        }),
        expired,
      ])
      pollTimer = undefined
    }
    throw new ReportCollectionError({...result, state: "timed-out"})
  } catch (error) {
    if (error instanceof ReportCollectionError) throw error
    throw new ReportCollectionError({...result, state: controller.signal.aborted ? "timed-out" : "unavailable"})
  } finally {
    if (timeoutTimer !== undefined) BgTimer.clearTimeout(timeoutTimer)
    if (pollTimer !== undefined) BgTimer.clearTimeout(pollTimer)
    options.signal?.removeEventListener("abort", abortWait)
    controller.abort()
  }
}

export const reports = {
  submit(input: EngineSubmitReportInput): Promise<ReportSubmitResult> {
    return submitReportInternal(input)
  },
  waitForCollection,
}

export function submitAutomaticReport(
  input: EngineSubmitAutomaticReportInput,
  options?: ReportSubmissionOptions,
): Promise<ReportSubmitResult> {
  return submitReportInternal(input, options)
}

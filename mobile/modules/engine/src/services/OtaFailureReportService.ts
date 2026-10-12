import type {OtaProgress, OtaStatus} from "@mentra/bluetooth-sdk"

import {redactOtaDiagnosticError} from "../utils/otaDiagnosticRedaction"

export type OtaFailureReason =
  | "download_stuck"
  | "progress_stalled"
  | "session_timeout"
  | "restart_timeout"
  | "start_failed"
  | "hotspot_preflight_failed"
  | "device_failed"

export interface OtaFailureEvidence {
  attemptId: string
  deviceRevision: number
  reason: OtaFailureReason
  transport: "wifi" | "hotspot" | null
  hotspotPhase: string
  connected: boolean
  wifiState: string
  buildNumber: string | null
  besFirmwareVersion: string
  mtkFirmwareVersion: string
  targetBesVersion: string | null
  targetRelease: string | null
  targetBuild: number | null
  updates: string[]
  retryCount: number
  sawReconnectEdge: boolean
  besRestartExpected: boolean
  besRestartDisconnectObserved: boolean
  versionChangeInstallStarted: boolean
  otaStatus: OtaStatus | null
  otaProgress: OtaProgress | null
}

const inFlight = new Set<string>()
const submittedOccurrences = new Set<string>()

/** Snapshot synchronously so cleanup, retries and reconnects cannot rewrite failure evidence. */
export async function submitOtaFailureReport(evidence: OtaFailureEvidence): Promise<void> {
  const snapshot = JSON.parse(JSON.stringify(evidence)) as OtaFailureEvidence
  if (snapshot.otaStatus?.error) {
    snapshot.otaStatus.error = redactOtaDiagnosticError(snapshot.otaStatus.error) as string
  }
  if (snapshot.otaProgress?.errorMessage) {
    snapshot.otaProgress.errorMessage = redactOtaDiagnosticError(snapshot.otaProgress.errorMessage) as string
  }
  const key = `ota_failure:${snapshot.deviceRevision}:${snapshot.otaStatus?.sessionId || snapshot.attemptId}:${snapshot.reason}`
  if (inFlight.has(key) || submittedOccurrences.has(key)) return
  inFlight.add(key)
  try {
    const {submitAutomaticReport} = require("../facades/reports") as typeof import("../facades/reports")
    const result = await submitAutomaticReport({
      kind: "automatic",
      trigger: {type: "automatic", source: "glasses_ota", reason: snapshot.reason},
      report: {
        expectedBehavior: "The glasses update completes and confirms the target version after restarting.",
        actualBehavior: JSON.stringify(snapshot, null, 2),
        systemPriority: "high",
      },
      context: {otaFailure: snapshot},
      throttleKey: key,
    })
    if (result.status === "submitted") {
      submittedOccurrences.add(key)
      // Retain recent occurrences across remounts, without an unbounded process-lifetime registry.
      if (submittedOccurrences.size > 128) submittedOccurrences.delete(submittedOccurrences.values().next().value!)
    }
    if (result.status === "submitted") console.log("[OtaFailureReport] Report filed:", result.reportId)
    else if (result.status === "failed") console.warn("[OtaFailureReport] submission failed")
  } catch (error) {
    console.warn("[OtaFailureReport] submission failed", error instanceof Error ? error.name : "unknown")
  } finally {
    inFlight.delete(key)
  }
}

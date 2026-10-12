import type {OtaProgress, OtaStatus} from "@mentra/bluetooth-sdk"

import {submitAutomaticReport} from "../facades/reports"
import {redactOtaDiagnosticError} from "../utils/otaDiagnosticRedaction"
import {logAutomaticReportSubmissionStatus, toAutomaticReportSubmissionStatus} from "./AutomaticReportResult"

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
  if (inFlight.has(key)) return
  inFlight.add(key)
  try {
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
    logAutomaticReportSubmissionStatus("OtaFailureReport", toAutomaticReportSubmissionStatus(result))
  } catch (error) {
    console.warn("[OtaFailureReport] submission failed", error instanceof Error ? error.name : "unknown")
  } finally {
    inFlight.delete(key)
  }
}

import type {OtaProgress, OtaProgressStatus, OtaStatus} from "@mentra/bluetooth-sdk"

/** Normalized ota_status fields (snake_case) after bridging Core/expo (snake or camel). */
export type NormalizedOtaStatusEvent = {
  session_id: string
  total_steps: number
  current_step: number
  step_type: string
  phase: "download" | "install"
  step_percent: number
  overall_percent: number
  status: string
  error_message?: string
}

/**
 * Core may deliver ota_status with snake_case (Android) or camelCase (some bridge paths).
 * Use this for Mantle and legacy otaProgress mapping.
 */
export function normalizeOtaStatusEvent(event: Record<string, unknown>): NormalizedOtaStatusEvent {
  const e = event as Record<string, any>
  const phase: "download" | "install" = e?.phase === "install" ? "install" : "download"
  const err = e?.error_message ?? e?.errorMessage
  return {
    session_id: String(e?.session_id ?? e?.sessionId ?? ""),
    total_steps: Number(e?.total_steps ?? e?.totalSteps ?? 0),
    current_step: Number(e?.current_step ?? e?.currentStep ?? 0),
    step_type: String(e?.step_type ?? e?.stepType ?? "apk"),
    phase,
    step_percent: Number(e?.step_percent ?? e?.stepPercent ?? 0),
    overall_percent: Number(e?.overall_percent ?? e?.overallPercent ?? 0),
    status: String(e?.status ?? "idle"),
    error_message: err == null || err === "" ? undefined : String(err),
  }
}

export function otaStatusFromNormalized(n: NormalizedOtaStatusEvent): OtaStatus {
  return {
    sessionId: n.session_id,
    totalSteps: n.total_steps,
    currentStep: n.current_step,
    stepType: n.step_type as OtaStatus["stepType"],
    phase: n.phase,
    stepPercent: n.step_percent,
    overallPercent: n.overall_percent,
    status: n.status as OtaStatus["status"],
    error: n.error_message,
  }
}

/** Maps unified ota_status from Core into the legacy otaProgress store shape (progress-legacy, settings). */
export function legacyOtaProgressFromOtaStatusEvent(
  event: Record<string, unknown> | NormalizedOtaStatusEvent,
): OtaProgress {
  const n = normalizeOtaStatusEvent(event as Record<string, unknown>)
  const raw = (n.overall_percent ?? n.step_percent ?? 0) as number
  let st: OtaProgressStatus = "PROGRESS"
  // Native K900 BES OTA (sr_adota) sends step_complete, not complete, on success — map for progress-legacy FINISHED.
  if (n.status === "complete" || n.status === "step_complete") st = "FINISHED"
  else if (n.status === "failed") st = "FAILED"
  else if (n.status === "idle") st = "STARTED"
  return {
    stage: n.phase === "install" ? "install" : "download",
    status: st,
    progress: Math.round(raw),
    bytesDownloaded: 0,
    totalBytes: 0,
    currentUpdate: n.step_type || "apk",
    errorMessage: n.error_message,
  }
}

/**
 * incidents facade — `toolkit.incidents`: bug-report / feedback submission over the
 * cloud-v2 core client.
 *
 * `file()` is the one-call submission: island orchestrates createIncident → upload
 * logs → notify the glasses → upload screenshots. The OEM writes its own report
 * SCREEN and gathers the diagnostics (phone-state snapshot, recent logs, screenshots)
 * — that gathering is genuinely native-coupled (NetInfo/Constants/Location/ImagePicker
 * + console interception), so it stays host-side and is passed in. The lower-level
 * primitives are also exposed for callers that want to drive the steps themselves.
 */
import BluetoothSdk from "../../../bluetooth-sdk/build/_internal"
import type {IncidentBugFeedback} from "@mentra/cloud-client"
import {useGlassesStore} from "../stores/glasses"
import {isGlassesConnected} from "../services/GlassesReadiness"
import {cloudClientService} from "../services/CloudClientService"

export type IncidentBugFeedbackData = IncidentBugFeedback

export interface IncidentLogEntry {
  timestamp: number
  level: string
  message: string
  source?: string
}

export interface IncidentAttachmentInput {
  uri: string
  fileName?: string | null
  mimeType?: string | null
}

export interface IncidentFileInput {
  /** The user's report fields (description/expected/actual/severity/contactEmail…). */
  feedbackData: IncidentBugFeedbackData
  /** The gathered phone-state diagnostics snapshot (host-built; native-coupled). */
  phoneState: Record<string, unknown>
  /** Recent phone logs to attach. */
  logs?: IncidentLogEntry[]
  /** Optional screenshot attachments. */
  screenshots?: IncidentAttachmentInput[]
}

export interface IncidentAutomaticInput extends IncidentFileInput {
  dedupeKey?: string
  dedupeWindowMs?: number
}

export interface IncidentFeedbackInput {
  feedback: string | Record<string, unknown>
  phoneState?: Record<string, unknown>
}

const DEFAULT_AUTOMATIC_INCIDENT_DEDUPE_MS = 90_000
const automaticIncidentDedupeRegistry = new Map<string, number>()

function automaticDedupeShouldSkip(key: string, nowMs: number, windowMs: number): boolean {
  const previous = automaticIncidentDedupeRegistry.get(key)
  if (previous !== undefined && nowMs - previous < windowMs) return true

  automaticIncidentDedupeRegistry.set(key, nowMs)
  for (const [entryKey, entryTime] of automaticIncidentDedupeRegistry) {
    if (nowMs - entryTime > windowMs * 3) {
      automaticIncidentDedupeRegistry.delete(entryKey)
    }
  }
  return false
}

export const incidents = {
  /**
   * File an incident end-to-end: create it, upload logs, notify the connected
   * glasses, and upload screenshots. Returns the new incident id (or an error).
   */
  async file(input: IncidentFileInput): Promise<{incidentId?: string; error?: string}> {
    let incidentId: string
    try {
      const res = await cloudClientService.core.incidents.create(input.feedbackData, input.phoneState)
      incidentId = res.incidentId
    } catch (error) {
      return {error: error instanceof Error ? error.message : String(error)}
    }

    if (input.logs && input.logs.length > 0) {
      try {
        await cloudClientService.core.incidents.uploadLogs(incidentId, input.logs)
      } catch (error) {
        console.warn("incidents.file: upload logs failed:", error instanceof Error ? error.message : error)
      }
    }
    // Reference the object directly (not `this`) so a detached call —
    // `const {file} = toolkit.incidents; file(input)` — still notifies the glasses.
    incidents.notifyGlasses(incidentId, cloudClientService.getCoreUrl())
    if (input.screenshots && input.screenshots.length > 0) {
      try {
        await cloudClientService.core.incidents.uploadAttachments(incidentId, input.screenshots)
      } catch (error) {
        console.warn("incidents.file: upload attachments failed:", error instanceof Error ? error.message : error)
      }
    }
    return {incidentId}
  },

  async fileAutomatic(input: IncidentAutomaticInput): Promise<
    | {status: "filed"; incidentId: string}
    | {status: "skipped"; reason: string}
    | {status: "failed"; error: string}
  > {
    if (input.dedupeKey) {
      const shouldSkip = automaticDedupeShouldSkip(
        input.dedupeKey,
        Date.now(),
        input.dedupeWindowMs ?? DEFAULT_AUTOMATIC_INCIDENT_DEDUPE_MS,
      )
      if (shouldSkip) return {status: "skipped", reason: "duplicate_within_window"}
    }

    const result = await incidents.file(input)
    if (result.error || !result.incidentId) {
      return {status: "failed", error: result.error ?? "incident creation failed"}
    }
    return {status: "filed", incidentId: result.incidentId}
  },

  // --- lower-level primitives (drive the steps yourself) ---
  /**
   * Notify the connected glasses of an incident id (no-op if disconnected).
   * Defaults the API base URL to the island's current REST URL.
   */
  notifyGlasses(incidentId: string, apiBaseUrl?: string | null): void {
    if (!isGlassesConnected(useGlassesStore.getState().connection)) return
    BluetoothSdk.sendIncidentId(incidentId, apiBaseUrl ?? cloudClientService.getCoreUrl())
  },
  /** Create an incident (returns its id); pass the gathered phone-state snapshot. */
  create: (...args: Parameters<typeof cloudClientService.core.incidents.create>) =>
    cloudClientService.core.incidents.create(...args),
  /** Upload the captured phone logs against an incident id. */
  uploadLogs: (...args: Parameters<typeof cloudClientService.core.incidents.uploadLogs>) =>
    cloudClientService.core.incidents.uploadLogs(...args),
  /** Upload screenshot/image attachments against an incident id. */
  uploadAttachments: (...args: Parameters<typeof cloudClientService.core.incidents.uploadAttachments>) =>
    cloudClientService.core.incidents.uploadAttachments(...args),
  /** Send freeform feedback (non-incident). */
  sendFeedback(input: IncidentFeedbackInput) {
    return cloudClientService.core.incidents.sendFeedback(input.feedback, input.phoneState)
  },
}

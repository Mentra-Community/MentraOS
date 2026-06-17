/**
 * incidents facade — `toolkit.incidents`: bug-report / feedback submission over the
 * now-island RestComms (the incident REST calls moved in with the settings+RestComms
 * keystone).
 *
 * `file()` is the one-call submission: island orchestrates createIncident → upload
 * logs → notify the glasses → upload screenshots. The OEM writes its own report
 * SCREEN and gathers the diagnostics (phone-state snapshot, recent logs, screenshots)
 * — that gathering is genuinely native-coupled (NetInfo/Constants/Location/ImagePicker
 * + console interception), so it stays host-side and is passed in. The lower-level
 * primitives are also exposed for callers that want to drive the steps themselves.
 */
import restComms from "../services/RestComms"
import BluetoothSdk from "../../../bluetooth-sdk/build/_internal"
import {useGlassesStore} from "../stores/glasses"
import {isGlassesConnected} from "../services/GlassesReadiness"
import {useSettingsStore} from "../stores/settings"

export interface IncidentFileInput {
  /** The user's report fields (description/expected/actual/severity/contactEmail…). */
  feedbackData: Record<string, unknown>
  /** The gathered phone-state diagnostics snapshot (host-built; native-coupled). */
  phoneState: Record<string, unknown>
  /** Recent phone logs to attach. */
  logs?: Parameters<typeof restComms.uploadIncidentLogs>[1]
  /** Optional screenshot attachments. */
  screenshots?: Parameters<typeof restComms.uploadIncidentAttachments>[1]
}

export const incidents = {
  /**
   * File an incident end-to-end: create it, upload logs, notify the connected
   * glasses, and upload screenshots. Returns the new incident id (or an error).
   */
  async file(input: IncidentFileInput): Promise<{incidentId?: string; error?: string}> {
    const backendUrl = useSettingsStore.getState().getRestUrl()
    const res = await restComms.createIncident(input.feedbackData, input.phoneState)
    if (res.is_error()) return {error: res.error.message}

    const {incidentId} = res.value
    if (input.logs && input.logs.length > 0) {
      const r = await restComms.uploadIncidentLogs(incidentId, input.logs)
      if (r.is_error()) console.warn("incidents.file: upload logs failed:", r.error?.message)
    }
    this.notifyGlasses(incidentId, backendUrl)
    if (input.screenshots && input.screenshots.length > 0) {
      const r = await restComms.uploadIncidentAttachments(incidentId, input.screenshots)
      if (r.is_error()) console.warn("incidents.file: upload attachments failed:", r.error?.message)
    }
    return {incidentId}
  },

  // --- lower-level primitives (drive the steps yourself) ---
  /**
   * Notify the connected glasses of an incident id (no-op if disconnected).
   * Defaults the API base URL to the island's current REST URL.
   */
  notifyGlasses(incidentId: string, apiBaseUrl?: string | null): void {
    if (!isGlassesConnected(useGlassesStore.getState().connection)) return
    BluetoothSdk.sendIncidentId(incidentId, apiBaseUrl ?? useSettingsStore.getState().getRestUrl())
  },
  /** Create an incident (returns its id); pass the gathered phone-state snapshot. */
  create: (...args: Parameters<typeof restComms.createIncident>) => restComms.createIncident(...args),
  /** Upload the captured phone logs against an incident id. */
  uploadLogs: (...args: Parameters<typeof restComms.uploadIncidentLogs>) => restComms.uploadIncidentLogs(...args),
  /** Upload screenshot/image attachments against an incident id. */
  uploadAttachments: (...args: Parameters<typeof restComms.uploadIncidentAttachments>) =>
    restComms.uploadIncidentAttachments(...args),
  /** Send freeform feedback (non-incident). */
  sendFeedback: (...args: Parameters<typeof restComms.sendFeedback>) => restComms.sendFeedback(...args),
}

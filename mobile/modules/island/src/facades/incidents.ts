/**
 * incidents facade — `toolkit.incidents`: bug-report / feedback submission over the
 * now-island RestComms (the incident REST calls moved in with the settings+RestComms
 * keystone). Thin passthrough (args forwarded with exact types via Parameters<>),
 * so the facade never drifts from RestComms.
 *
 * The OEM writes its own bug-report SCREEN and gathers user input + diagnostics
 * (phone state, recent logs, screenshots); island owns the submission. A single-call
 * `file()` that ALSO bundles diagnostics island-side is a follow-up — it needs the
 * host's native diagnostics-gathering (NetInfo/Constants/Location/ImagePicker + the
 * console logBuffer) moved into island first.
 */
import restComms from "../services/RestComms"

export const incidents = {
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

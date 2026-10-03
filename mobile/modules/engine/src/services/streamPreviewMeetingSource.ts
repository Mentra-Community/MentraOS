/**
 * The read-only view of the active meeting that the stream-preview coordinator authorizes against.
 * Nothing here can change the meeting.
 */

import acsMeetingService from "./AcsMeetingService"

export interface StreamPreviewMeetingSource {
  /** The active meeting's owner and per-meeting id, or null when there is none. */
  current(): {ownerPackage: string; instanceId: string} | null
  onReleased(listener: (instanceId: string) => void): () => void
}

export const acsMeetingPreviewSource: StreamPreviewMeetingSource = {
  current: () => acsMeetingService.meetingInstance(),
  onReleased: (listener) => acsMeetingService.onMeetingReleased(listener),
}

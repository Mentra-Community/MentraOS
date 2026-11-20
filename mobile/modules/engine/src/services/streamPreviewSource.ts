import acsMeetingService from "./AcsMeetingService"
import {phoneStreamCoordinator} from "./PhoneStreamCoordinator"
import {createStreamPreviewSource, type StreamPreviewMeetingSource} from "./streamPreviewMeetingSource"

/** What a miniapp may preview on this phone: its ACS meeting, else the managed relay it owns. */
export const streamPreviewSource: StreamPreviewMeetingSource = createStreamPreviewSource({
  acs: {
    current: () => acsMeetingService.meetingInstance(),
    onReleased: (listener) => acsMeetingService.onMeetingReleased(listener),
  },
  relay: {
    current: () => phoneStreamCoordinator.relayPreviewSource(),
    onReleased: (listener) => phoneStreamCoordinator.onRelayPreviewReleased(listener),
  },
})

/**
 * P8 scratch miniapp background. Pack with @mentra/miniapp-cli against a
 * Mentra App host that implements MEETING_* (this module + AcsMeetingService).
 * On an older host, join() fails fast with "Update the Mentra App to use Teams calling".
 */
import {MiniappSession} from "@mentra/miniapp/background"

const session = new MiniappSession()

session.meeting.onState((state) => {
  console.log("[acs-scratch] state", state)
})

export async function joinTeams(args: {meetingUrl: string; whepUrl: string; token: string}): Promise<void> {
  await session.meeting.join({
    provider: "acs-teams",
    meetingUrl: args.meetingUrl,
    videoSource: {type: "whep", url: args.whepUrl},
    token: args.token,
    displayName: "Mentra scratch",
  })
}

export async function leaveTeams(): Promise<void> {
  await session.meeting.leave()
}

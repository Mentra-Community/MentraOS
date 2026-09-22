import type {Command, Snapshot} from "./driver"
import type {Step} from "./suite"

export const OTA_AUDIO_NOTICE_TITLE = "Glasses audio disconnected"
export const OTA_AUDIO_NOTICE_BODY =
  "Your glasses are connected to the app, but the Bluetooth audio device is not connected."

/** This iOS Home notice's Ignore callback only suppresses the notice for this app session.
 * Duplicate AXStaticText wrappers are normal; the two actionable buttons must be unique. */
export function otaAudioNotice(state: Snapshot): "absent" | "dismissible" | "blocked" {
  const shown = state.elements.filter((element) => element.visible)
  const title = shown.filter((element) => element.description === OTA_AUDIO_NOTICE_TITLE)
  const body = shown.filter((element) => element.description === OTA_AUDIO_NOTICE_BODY)
  if (!title.length && !body.length) return "absent"
  const button = (description: string) => {
    const matches = shown.filter((element) => element.role === "AXButton" && element.description === description)
    return matches.length === 1 && matches[0].enabled && matches[0].actions.includes("AXPress")
  }
  return title.some((element) => element.role === "AXStaticText") &&
    body.some((element) => element.role === "AXStaticText") &&
    shown.some((element) => element.identifier === "home.miniapp.com.mentra.settings") &&
    button("Ignore") &&
    button("Connect")
    ? "dismissible"
    : "blocked"
}

export function otaAudioNoticeCommand(state: Snapshot): Command {
  if (otaAudioNotice(state) !== "dismissible") throw new Error("Expected the exact dismissible glasses audio notice")
  return {op: "press", selector: {role: "AXButton", description: "Ignore", enabled: true}}
}

export function otaAudioNoticeStep(id: string): Step {
  return {
    id,
    instruction: "Dismiss the Bluetooth audio notice; this OTA routine uses the existing app connection.",
    expected: "The audio notice closes without changing Bluetooth pairing.",
    action: (_context, state) => otaAudioNoticeCommand(state),
    checks: [
      {selector: {description: OTA_AUDIO_NOTICE_TITLE}, absent: true},
      {selector: {description: OTA_AUDIO_NOTICE_BODY}, absent: true},
      {selector: {identifier: "home.miniapp.com.mentra.settings"}},
    ],
    timeoutMs: 5000,
  }
}

import i18n from "i18next"

import en from "./en"
import {translate} from "./translate"

/** Every Fleet string, word for word: the design board (round 2), then the Fleet Phase 11 plan where the board is silent. */
const BOARD = {
  "fleet:invitationTitle": [
    "Ridgeline Field Services invited you to join their workspace",
    {workspace: "Ridgeline Field Services"},
  ],
  "fleet:invitationTerms": ["If you join, they manage your device and can install miniapps on your phone."],
  "fleet:invitationJoin": ["Join"],
  "fleet:invitationDecline": ["Decline"],
  "fleet:invitationLeaveFirst": [
    "You're in Northwind Labs. Leave it to join Ridgeline Field Services.",
    {current: "Northwind Labs", workspace: "Ridgeline Field Services"},
  ],
  "fleet:invitationLeaveCurrent": ["Leave Northwind Labs", {current: "Northwind Labs"}],
  "fleet:canSeeTitle": ["Your workspace can see"],
  "fleet:canSeeGlassesAndPhones": ["Your glasses and phones"],
  "fleet:canSeeMiniapps": ["Miniapps you use"],
  "fleet:cantSeeTitle": ["Your workspace can't see"],
  "fleet:cantSeePhotosAndVideos": ["Your photos and videos"],
  "fleet:cantSeeSpeech": ["What you say and hear"],
  "fleet:cantSeePasswords": ["Your passwords"],
  "fleet:leaveConfirmTitle": ["Leave Ridgeline Field Services?", {workspace: "Ridgeline Field Services"}],
  "fleet:leaveConfirmMessage": ["Its miniapps come off this phone."],
  "fleet:leaveConfirmLeave": ["Leave"],
  "fleet:leaveConfirmCancel": ["Cancel"],
  "fleet:noticeTitle": [
    "You've now joined the Ridgeline Field Services workspace",
    {workspace: "Ridgeline Field Services"},
  ],
  "fleet:noticeBody": [
    "By joining the Ridgeline Field Services workspace, you agree to let them manage your device.",
    {workspace: "Ridgeline Field Services"},
  ],
  "fleet:noticeOk": ["OK"],
  "fleet:managementTitle": ["Mentra Fleet Management"],
  "fleet:managementSubtitle": ["Managed by your workspace's admins"],
  "fleet:settingsGroup": ["Workspace"],
  "fleet:pageTitle": ["Workspace"],
  "fleet:leaveWorkspace": ["Leave workspace"],
  "fleet:roleMember": ["Member"],
  "fleet:lastOwner": [
    "You're this workspace's only Owner. Hand over ownership or delete the workspace in Mentra Portal first.",
  ],
  "fleet:somethingWentWrong": ["Something went wrong. Try again."],
  "fleet:updatePromptTitle": ["Update Notes?", {name: "Notes"}],
  "fleet:updatePromptMessage": ["Notes will restart.", {name: "Notes"}],
  "fleet:updatePromptNotNow": ["Not now"],
  "fleet:updatePromptUpdate": ["Update"],
  "fleet:updateFailedTitle": ["Couldn't update Notes", {name: "Notes"}],
  "fleet:updateFailedMessage": ["You're still on version 1.4.0.", {version: "1.4.0"}],
  "fleet:accessRevoked": ["You no longer have access to Notes.", {name: "Notes"}],
} as const

describe("Fleet copy", () => {
  beforeAll(async () => {
    await i18n.init({lng: "en", resources: {en: en as never}, interpolation: {escapeValue: false}})
  })

  it.each(Object.entries(BOARD))("%s is verbatim", (key, [expected, options]) => {
    expect(translate(key as never, options as never)).toBe(expected)
  })

  it("words the update-failed notice as one sentence pair, 'Couldn't update <name>. You're still on version <version>.'", () => {
    const title = translate("fleet:updateFailedTitle", {name: "Notes"})
    const message = translate("fleet:updateFailedMessage", {version: "1.4.0"})
    expect(`${title}. ${message}`).toBe("Couldn't update Notes. You're still on version 1.4.0.")
  })
})

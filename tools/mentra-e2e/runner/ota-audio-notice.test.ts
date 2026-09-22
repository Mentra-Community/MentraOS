import {expect, test} from "bun:test"
import type {Command, Element, Snapshot} from "./driver"
import {
  OTA_AUDIO_NOTICE_BODY,
  OTA_AUDIO_NOTICE_TITLE,
  otaAudioNotice,
  otaAudioNoticeCommand,
  otaAudioNoticeStep,
} from "./ota-audio-notice"
import type {Report} from "./report"
import {checkPairedHome} from "./return-observer"
import {executeSteps} from "./suite"

const element = (patch: Partial<Element>): Element => ({
  path: "0",
  role: "AXGroup",
  subrole: "",
  title: "",
  description: "",
  placeholder: "",
  identifier: "",
  value: "",
  enabled: true,
  focused: false,
  visible: true,
  actions: ["AXPress"],
  ...patch,
})
const home: Snapshot = {
  pid: 1,
  frontmostBundleId: "com.apple.Safari",
  window: {x: 3468, y: 679, width: 288.4182908545727, height: 513},
  elements: [
    element({role: "AXGenericElement", description: "Mentra Live, \uea31, 100%, \uecea"}),
    element({identifier: "home.miniapp.com.mentra.settings"}),
  ],
}
// Sanitized semantic shape from discovery-d3f967 / ASG-05: custom AXGroups,
// duplicated static labels and unique actionable buttons; no AXDialog is exposed.
const noticeRows = [
  element({path: "0.0.0.0.0.0.0.0.0.0"}),
  ...["0", "0.0"].map((suffix) =>
    element({path: "0.0.0.0.0.0.0.0.0.0.0." + suffix, role: "AXStaticText", description: OTA_AUDIO_NOTICE_TITLE}),
  ),
  ...["1", "1.0"].map((suffix) =>
    element({path: "0.0.0.0.0.0.0.0.0.0.0." + suffix, role: "AXStaticText", description: OTA_AUDIO_NOTICE_BODY}),
  ),
  element({path: "0.0.0.0.0.0.0.0.0.0.1.0.0", role: "AXButton", description: "Ignore"}),
  element({path: "0.0.0.0.0.0.0.0.0.0.1.0.1", role: "AXButton", description: "Connect"}),
]
const notice = (): Snapshot => ({...home, elements: [...home.elements, ...noticeRows]})

test("captured custom notice requires exact copy and unique enabled buttons", () => {
  expect(otaAudioNotice(notice())).toBe("dismissible")
  expect(otaAudioNoticeCommand(notice())).toEqual({
    op: "press",
    selector: {role: "AXButton", description: "Ignore", enabled: true},
  })
  for (const changed of [
    notice().elements.filter((row) => row.description !== OTA_AUDIO_NOTICE_BODY),
    notice().elements.filter((row) => row.identifier !== "home.miniapp.com.mentra.settings"),
    notice().elements.filter((row) => row.description !== "Connect"),
    [...notice().elements, element({role: "AXButton", description: "Ignore"})],
    notice().elements.map((row) => (row.description === "Ignore" ? {...row, enabled: false} : row)),
    notice().elements.map((row) => (row.description === "Ignore" ? {...row, actions: []} : row)),
  ]) {
    const state = {...home, elements: changed}
    expect(otaAudioNotice(state)).toBe("blocked")
    expect(() => otaAudioNoticeCommand(state)).toThrow("exact dismissible")
  }
})

test("no notice, hidden old labels and unrelated Ignore dialogs never authorize a dismissal", () => {
  for (const state of [
    home,
    {...home, elements: [...home.elements, ...noticeRows.map((row) => ({...row, visible: false}))]},
    {...home, elements: [...home.elements, element({role: "AXButton", description: "Ignore"})]},
  ]) {
    expect(otaAudioNotice(state)).toBe("absent")
    expect(() => otaAudioNoticeCommand(state)).toThrow("exact dismissible")
  }
})

test("final connected-home proof rejects the captured AXGroup notice and its partial form", () => {
  const info = {
    ...home,
    elements: [
      element({description: "MAC address, CC:E7:DE:E0:03:BE"}),
      element({description: "Build number, 303006291"}),
    ],
  }
  expect(checkPairedHome(home, info, "CC:E7:DE:E0:03:BE", 303006291)).toBe(true)
  expect(checkPairedHome(notice(), info, "CC:E7:DE:E0:03:BE", 303006291)).toBe(false)
  expect(
    checkPairedHome(
      {...home, elements: [...home.elements, element({description: OTA_AUDIO_NOTICE_TITLE})]},
      info,
      "CC:E7:DE:E0:03:BE",
      303006291,
    ),
  ).toBe(false)
})

test("English step rechecks the current notice, presses once and preserves a failed action", async () => {
  for (const fail of [false, true]) {
    let current = notice()
    const commands: Command[] = []
    const report = {metadata: {}, record: async (step: unknown) => step} as Report
    const passed = await executeSteps(
      [otaAudioNoticeStep("OTA-AUDIO")],
      {fixture: "test", email: "", password: ""},
      report,
      {
        snapshot: async () => current,
        command: async <T>(command: Command) => {
          commands.push(command)
          if (fail) throw new Error("simulated interrupted Ignore press")
          current = home
          return {method: "AXPress"} as T
        },
      },
    )
    expect(passed).toBe(!fail)
    expect(commands).toHaveLength(1)
    expect(commands[0].selector?.description).toBe("Ignore")
  }
  const step = otaAudioNoticeStep("OTA-AUDIO")
  const action = step.action
  expect(typeof action).toBe("function")
  if (typeof action === "function")
    expect(() => action({fixture: "test", email: "", password: ""}, home)).toThrow()
})

import {expect, mock, test} from "bun:test"
import {visible, type Snapshot} from "./driver"
import {OTA_AUDIO_NOTICE_BODY, OTA_AUDIO_NOTICE_TITLE} from "./ota-audio-notice"
import type {OtaCustomerActions} from "./ota-customer-sequence"
import type {OtaRecordingFixture} from "./ota-recording"
import type {Step} from "./suite"
import {createJanuaryPairVerifier, januaryDeviceInfoChecks} from "./ota-january-pairing"

const fixture: OtaRecordingFixture = {
  serial: "TEST012345",
  wifiEndpoint: "192.0.2.10:5555",
  cid: "0123456789abcdef0123456789abcdef",
  bluetooth: "AA:BB:CC:DD:EE:01",
  before: {firmware: "20260113", asgVersion: 27, bootId: "original-boot", slot: "_b"},
}
const ref = {path: "/verified/after.json", sha256: "a".repeat(64)}
const home = {elements: [{visible: true, identifier: "home.miniapp.com.mentra.settings"}]} as Snapshot
const info = {
  elements: januaryDeviceInfoChecks(fixture)
    .filter((check) => !check.absent)
    .map((check) => ({...check.selector, visible: true})),
} as Snapshot
const hardware = {
  serial: fixture.serial,
  cid: fixture.cid,
  bluetooth: fixture.bluetooth,
  bootId: fixture.before.bootId,
  slot: "_b",
  firmware: "MentraLive_20260113",
  asgVersion: 27,
  persistedBluetooth: "",
  bluetoothProvenance: {
    kind: "original-January-boot BLE-to-WiFi-to-ADB recovery binding",
    endpoint: fixture.wifiEndpoint,
    recoveryAfter: ref,
    owner: "same-owner",
  },
}
function scenario(changedInfo: Snapshot = info, initial: Snapshot = home) {
  const complete = (state: Snapshot): Snapshot => ({
    ...state,
    elements: state.elements.map((row) => ({
      ...row,
      title: row.title ?? "",
      description: row.description ?? "",
      value: row.value ?? "",
      placeholder: row.placeholder ?? "",
      identifier: row.identifier ?? "",
    })),
  })
  let current = complete(initial)
  const identity = structuredClone(hardware)
  const original = mock(async () => {})
  const actions = {
    hardware: mock(async () => identity),
    snapshot: mock(async () => complete(current)),
    observe: mock(async (_instruction: string, _state: Snapshot) => {}),
    verifyAppPair: original,
    executeStep: mock(async (step: Omit<Step, "id">) => {
      const action = step.action
      if (typeof action === "function") {
        action({fixture: fixture.serial, email: "", password: ""}, current)
        current = home
      } else if (action?.selector?.identifier === "home.miniapp.com.mentra.settings")
        current = {elements: [{visible: true, role: "AXGenericElement", description: "Device info"}]} as Snapshot
      else if (action?.selector?.contains === "Device info") current = changedInfo
      else if (action?.selector?.identifier === "miniapp.close") current = home
      else throw Error("Unexpected action")
      current = complete(current)
      const checks =
        typeof step.checks === "function"
          ? step.checks({fixture: fixture.serial, email: "", password: ""})
          : step.checks
      return checks.every((check) =>
        check.absent
          ? visible(current, check.selector).length === 0
          : visible(current, check.selector).length === (check.count ?? 1),
      )
    }),
  }
  return {
    actions,
    identity,
    original,
    verify: createJanuaryPairVerifier(actions as unknown as OtaCustomerActions, fixture, ref),
  }
}

test("ASG27 uses exact visible ID/build/IP plus same-boot BLE provenance, never claims a visible full MAC", async () => {
  const s = scenario()
  await s.verify()
  expect(s.actions.hardware).toHaveBeenCalledTimes(2)
  expect(s.original).not.toHaveBeenCalled()
  expect(s.actions.executeStep).toHaveBeenCalledTimes(3)
  expect(s.actions.observe).toHaveBeenCalledTimes(1)
  expect(s.actions.observe.mock.calls[0][0]).toContain("full MAC is supplied by the BLE recovery proof")
  expect(s.actions.observe.mock.calls[0][0]).toContain("UI omits it")
})

test("absent/wrong IP, wrong build and an unexpected MAC row fail without closing or retrying", async () => {
  for (const elements of [
    info.elements.filter((row) => !row.description?.startsWith("Local IP")),
    info.elements.map((row) =>
      row.description?.startsWith("Local IP") ? {...row, description: "Local IP address, 192.0.2.11"} : row,
    ),
    info.elements.map((row) =>
      row.description === "Build number, 27" ? {...row, description: "Build number, 31"} : row,
    ),
    [...info.elements, {visible: true, role: "AXGenericElement", description: "MAC address, 11:22:33:44:55:66"}],
  ]) {
    const s = scenario({...info, elements} as Snapshot)
    await expect(s.verify()).rejects.toThrow("do not retry")
    expect(s.actions.hardware).toHaveBeenCalledTimes(1)
    expect(s.actions.executeStep).toHaveBeenCalledTimes(2)
    expect(s.actions.observe).not.toHaveBeenCalled()
  }
})

test("modern, later ASG, nonempty-property or another original-boot proof delegates unchanged", async () => {
  for (const patch of [
    {asgVersion: 31},
    {firmware: "MentraLive_20260921.0", asgVersion: 303006291},
    {persistedBluetooth: fixture.bluetooth},
    {bootId: "other-boot"},
    {bluetoothProvenance: {...hardware.bluetoothProvenance, recoveryAfter: {...ref, sha256: "b".repeat(64)}}},
  ]) {
    const s = scenario()
    Object.assign(s.identity, patch)
    await s.verify()
    expect(s.original).toHaveBeenCalledTimes(1)
    expect(s.actions.executeStep).not.toHaveBeenCalled()
    expect(s.actions.observe).not.toHaveBeenCalled()
  }
})

test("known audio notice is dismissed once through the existing exact helper; post-UI identity drift fails", async () => {
  const notice = {
    ...home,
    elements: [
      ...home.elements,
      ...[OTA_AUDIO_NOTICE_TITLE, OTA_AUDIO_NOTICE_BODY].map((description) => ({
        role: "AXStaticText",
        description,
        visible: true,
      })),
      ...["Ignore", "Connect"].map((description) => ({
        role: "AXButton",
        description,
        visible: true,
        enabled: true,
        actions: ["AXPress"],
      })),
    ],
  } as Snapshot
  const s = scenario(info, notice)
  await s.verify()
  expect(s.actions.executeStep).toHaveBeenCalledTimes(4)
  expect(s.actions.executeStep.mock.calls[0][0].instruction).toContain("Bluetooth audio")
  const changed = scenario()
  changed.actions.hardware.mockImplementationOnce(async () => changed.identity)
  changed.actions.hardware.mockImplementationOnce(async () => ({...changed.identity, bootId: "changed-boot"}))
  await expect(changed.verify()).rejects.toThrow("identity changed")
  expect(changed.actions.observe).not.toHaveBeenCalled()
  expect(changed.actions.executeStep).toHaveBeenCalledTimes(2)
})

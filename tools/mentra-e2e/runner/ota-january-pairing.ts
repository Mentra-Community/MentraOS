/** Initial-ASG27 UI proof. Caller keeps the same lease and original
 * January hardware reader. Modern/final pairing remains the original verifier. */
import {visible, type Snapshot} from "./driver"
import {otaAudioNotice, otaAudioNoticeStep} from "./ota-audio-notice"
import type {OtaCustomerActions} from "./ota-customer-sequence"
import type {OtaRecordingFixture} from "./ota-recording"
import {normalizeFirmware} from "./ota-state"
import type {Check, Step} from "./suite"
import type {JsonReference} from "./ota-january-identity"

type Hardware = Awaited<ReturnType<OtaCustomerActions["hardware"]>> & {
  persistedBluetooth?: string
  bluetoothProvenance?: {kind: string; endpoint: string; recoveryAfter: JsonReference; owner: string}
}
const sameRef = (a?: JsonReference, b?: JsonReference) => a?.path === b?.path && a?.sha256 === b?.sha256

export function januaryDeviceInfoChecks(fixture: OtaRecordingFixture): Check[] {
  if (
    !/^(?:[A-F0-9]{2}:){5}[A-F0-9]{2}$/i.test(fixture.bluetooth) ||
    !/^\d{1,3}(?:\.\d{1,3}){3}:5555$/.test(fixture.wifiEndpoint ?? "")
  )
    throw new Error("January UI proof requires the full MAC and verified Wi-Fi endpoint")
  const rows = [
    "Model, Mentra Live",
    `Device ID, ${fixture.bluetooth.replaceAll(":", "").slice(-4).toUpperCase()}`,
    "Build number, 27",
    "App version, 27.0",
    `Local IP address, ${fixture.wifiEndpoint!.split(":")[0]}`,
  ]
  return [
    ...rows.map((description) => ({selector: {role: "AXGenericElement", description}, count: 1})),
    {selector: {contains: "MAC address"}, absent: true},
  ]
}
function infoMatches(state: Snapshot, checks: Check[]) {
  return checks.every((check) => {
    const count = visible(state, check.selector).length
    return check.absent ? count === 0 : count === check.count
  })
}

export function createJanuaryPairVerifier(
  actions: OtaCustomerActions,
  selected: OtaRecordingFixture,
  expectedRecoveryAfter: JsonReference,
) {
  const fixture = structuredClone(selected)
  const recoveryAfter = structuredClone(expectedRecoveryAfter)
  const originalVerifyAppPair = actions.verifyAppPair
  const checks = januaryDeviceInfoChecks(fixture)
  const isInitialJanuary = (state: Hardware) =>
    state.persistedBluetooth === "" &&
    state.asgVersion === 27 &&
    state.bootId === fixture.before.bootId &&
    normalizeFirmware(state.firmware) === "MentraLive_20260113" &&
    state.slot === fixture.before.slot &&
    state.cid.toLowerCase() === fixture.cid.toLowerCase() &&
    state.serial === fixture.serial &&
    state.bluetooth.toUpperCase() === fixture.bluetooth.toUpperCase() &&
    state.bluetoothProvenance?.kind === "original-January-boot BLE-to-WiFi-to-ADB recovery binding" &&
    state.bluetoothProvenance.endpoint === fixture.wifiEndpoint &&
    sameRef(state.bluetoothProvenance.recoveryAfter, recoveryAfter)
  const execute = async (step: Omit<Step, "id">) => {
    if (!(await actions.executeStep(step)))
      throw new Error("January paired-device verification failed; do not retry its UI action automatically")
  }
  return async () => {
    const before: Hardware = await actions.hardware()
    if (!isInitialJanuary(before)) return originalVerifyAppPair()
    const notice = otaAudioNotice(await actions.snapshot())
    if (notice === "blocked") throw new Error("The glasses audio notice is incomplete or ambiguous")
    if (notice === "dismissible") {
      const {id: _, ...step} = otaAudioNoticeStep("assigned-by-recording")
      await execute(step)
    }
    await execute({
      instruction: "Open Settings to identify the original January ASG27 glasses.",
      expected: "Device info is available for the connected glasses.",
      action: {op: "press", selector: {identifier: "home.miniapp.com.mentra.settings"}},
      checks: [{selector: {role: "AXGenericElement", contains: "Device info"}}],
    })
    await execute({
      instruction: "Match January’s visible device ID, ASG27 build and local IP to the verified original-boot glasses.",
      expected:
        "Device ID, build27 and IP match; January omits the MAC row, so its full MAC comes from the frozen BLE recovery proof.",
      action: {op: "press", selector: {role: "AXGenericElement", contains: "Device info"}},
      checks,
    })
    const after: Hardware = await actions.hardware()
    if (!isInitialJanuary(after) || after.bluetoothProvenance!.owner !== before.bluetoothProvenance!.owner)
      throw new Error("Original January pairing identity changed during the UI observation")
    const state = await actions.snapshot()
    if (!infoMatches(state, checks))
      throw new Error("January Device info changed during the independent hardware check")
    await actions.observe(
      "Verify January’s visible device ID, ASG27 and IP; the full MAC is supplied by the BLE recovery proof because January’s UI omits it. Independent ADB checks match the same original boot, CID and serial before and after.",
      state,
    )
    await execute({
      instruction: "Close January Device info and return to paired home.",
      expected: "Device info closes and the home Settings entry returns.",
      action: {op: "press", selector: {identifier: "miniapp.close"}},
      checks: [
        {selector: {identifier: "miniapp.close"}, absent: true},
        {selector: {identifier: "home.miniapp.com.mentra.settings"}},
      ],
    })
  }
}

import {expect, test} from "bun:test"
import {verifyAndroidFixture} from "./android-fixture"

function row(suffix: string, classic = "Y", ble = "Y") {
  const address = `XX:XX:XX:XX:${suffix.slice(0, 2)}:${suffix.slice(2)}`
  return `    ${address}(Public ) => ${address}(Public ) [ DUAL ] [0x240404] [ACL BR/EDR:${classic} LE:${ble}] [ Encryption status(BR/EDR): null LE: null] Mentra_Live_${suffix}`
}
const dump = (...rows: string[]) => `BluetoothRemoteDevices\n  Bonded devices: 3\n${rows.join("\n")}\nNextSection\n`

test("rejects the observed Fold mismatch even when the requested pair has a saved bond", () => {
  const result = verifyAndroidFixture(dump(row("03BE", "N", "N"), row("023B")), "Mentra_Live_03BE")
  expect(result.passed).toBe(false)
  expect(result.reason).toContain("Wrong glasses connected: Mentra_Live_023B")
})

test("accepts exactly one expected pair with both transports, ignoring disconnected pairs", () => {
  expect(verifyAndroidFixture(dump(row("03BE"), row("023B", "N", "N")), "Mentra_Live_03BE").passed).toBe(true)
})

test("requires both BLE and Classic, not just a bond or a BLE connection", () => {
  for (const [classic, ble] of [
    ["N", "N"],
    ["N", "Y"],
    ["Y", "N"],
  ])
    expect(verifyAndroidFixture(dump(row("03BE", classic, ble)), "Mentra_Live_03BE").passed).toBe(false)
})

test("rejects multiple active pairs and duplicate names", () => {
  expect(verifyAndroidFixture(dump(row("03BE"), row("023B", "N", "Y")), "Mentra_Live_03BE").passed).toBe(false)
  expect(verifyAndroidFixture(dump(row("03BE"), row("03BE")), "Mentra_Live_03BE").passed).toBe(false)
})

test("does not accept stale connection rows outside the current-device table", () => {
  const history = `${row("03BE")}\n${dump(row("03BE", "N", "N"))}${row("03BE")}`
  expect(verifyAndroidFixture(history, "Mentra_Live_03BE").passed).toBe(false)
})

test("ignores Samsung's saved bond metadata interleaved with live device rows", () => {
  const metadata = "    XX:XX:XX:XX:03:BE | Mentra_Live_03BE | 2 | 3 | SPP,AudioSink,Handsfree"
  const result = verifyAndroidFixture(dump(row("03BE", "N", "N"), metadata, row("023B")), "Mentra_Live_03BE")
  expect(result.reason).toContain("Wrong glasses connected: Mentra_Live_023B")
  expect(verifyAndroidFixture(dump(metadata), "Mentra_Live_03BE").passed).toBe(false)
})

test("fails closed for missing, empty or unsupported device tables", () => {
  for (const text of ["", row("03BE"), dump(), dump(row("03BE").replace("LE:Y", "LE:unknown"))])
    expect(verifyAndroidFixture(text, "Mentra_Live_03BE").passed).toBe(false)
})

test("requires a suffix match between device address and name", () => {
  expect(
    verifyAndroidFixture(dump(row("023B").replace("Mentra_Live_023B", "Mentra_Live_03BE")), "Mentra_Live_03BE").passed,
  ).toBe(false)
})

test("rejects a generic model name as fixture identity", () => {
  expect(verifyAndroidFixture(dump(row("03BE")), "Mentra Live").passed).toBe(false)
})

const moto = (links: string, bonds = "    XX:XX:XX:XX:03:BE [ DUAL ][ 0x001F00 ] Mentra_Live_03BE") =>
  `AdapterProperties\n  ConnectionState: STATE_CONNECTED\n  Bonded devices:\n${bonds}\n\nScanMode: SCAN_MODE_CONNECTABLE\n${links}`
const acl = (suffix: string, transport: "LE" | "BR_EDR", up = true) =>
  `shim::acl remote_addr:xx:xx:xx:xx:${suffix.slice(0, 2)}:${suffix.slice(2)} handle:0x0015 transport:BT_TRANSPORT_${transport}\nshim::acl     link_up_issued: ${up}\n`

test("Motorola joins bond identity to current LE and Classic ACLs", () => {
  expect(verifyAndroidFixture(moto(acl("03be", "LE") + acl("03be", "BR_EDR")), "Mentra_Live_03BE").passed).toBe(true)
})

test("Motorola refuses missing/down transports and historical connection text", () => {
  for (const links of [
    acl("03be", "LE"),
    acl("03be", "BR_EDR"),
    acl("03be", "LE", false) + acl("03be", "BR_EDR"),
    "shim::btm 2026-09-17 13:57:07.190 ACL Connection successful : xx:xx:xx:xx:03:be classic\n",
  ])
    expect(verifyAndroidFixture(moto(links), "Mentra_Live_03BE").passed).toBe(false)
})

test("Motorola refuses the wrong pair and ambiguous active pairs", () => {
  const bonds =
    "    XX:XX:XX:XX:03:BE [ DUAL ][ 0x001F00 ] Mentra_Live_03BE\n    XX:XX:XX:XX:E7:FA [ DUAL ][ 0x001F00 ] Mentra_Live_E7FA"
  const other = acl("e7fa", "LE") + acl("e7fa", "BR_EDR")
  expect(verifyAndroidFixture(moto(other, bonds), "Mentra_Live_03BE").reason).toContain("Wrong glasses")
  expect(verifyAndroidFixture(moto(other + acl("03be", "LE"), bonds), "Mentra_Live_03BE").passed).toBe(false)
})

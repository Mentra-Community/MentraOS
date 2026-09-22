import {expect, test} from "bun:test"
import type {Snapshot} from "./driver"
import {checkOtaObservedVersions, freshBesProof, otaFirmwareRoute, otaPage, selectUsbTransport} from "./ota-state"

const screen = (...labels: string[]) =>
  ({elements: labels.map((description) => ({visible: true, description}))} as Snapshot)

test("only versions on the pinned firmware route are valid intermediate boots", () => {
  const before = "MentraLive_20260113"
  const intermediate = "MentraLive_20260709"
  const target = "MentraLive_20260915.0"
  const route = otaFirmwareRoute(before, target, [
    {start_firmware: intermediate, end_firmware: target},
    {start_firmware: before, end_firmware: intermediate},
    {start_firmware: "MentraLive_20260204", end_firmware: "MentraLive_20260626"},
  ])
  expect(route).toEqual([before, intermediate, target])
  expect(() => checkOtaObservedVersions(intermediate, 2, route, [1, 2], false)).not.toThrow()
  expect(() => checkOtaObservedVersions("MentraLive_20260626", 2, route, [1, 2], true)).toThrow("UNEXPECTED_FIRMWARE")
  expect(otaFirmwareRoute(before, target)).toEqual([before, target])
  expect(() =>
    otaFirmwareRoute(before, target, [
      {start_firmware: before, end_firmware: intermediate},
      {start_firmware: intermediate, end_firmware: before},
    ]),
  ).toThrow("Cyclic")
})

test("an intermediate stock ASG can be observed but cannot authorize another install or final pass", () => {
  const route = ["MentraLive_20260709", "MentraLive_20260915.0"]
  expect(() => checkOtaObservedVersions(route[0], 50, route, [100, 200], true)).not.toThrow()
  expect(() => checkOtaObservedVersions(route[0], 50, route, [100, 200], false)).toThrow("UNEXPECTED_ASG_VERSION")
  expect(() => checkOtaObservedVersions(route[0], NaN, route, [100, 200], false)).toThrow("UNEXPECTED_ASG_VERSION")
  expect(() => checkOtaObservedVersions(route[1], 200, route, [100, 200], false)).not.toThrow()
})

test("Done and transient component completion cannot pass the complete OTA routine", () => {
  expect(otaPage(screen("Done", "Update Failed")).kind).toBe("failed")
  expect(otaPage(screen("Done", "Update complete!", "Your glasses are up to date."))).toEqual({
    kind: "pass-complete",
    title: "Update complete!",
    finishControl: "button-Done",
  })
  expect(otaPage(screen("Done", "Update Complete", "Your glasses are running the latest version.")).kind).toBe(
    "complete",
  )
  expect(otaPage(screen("Continue", "Up to Date", "Your glasses are running the latest version.")).kind).toBe("current")
})

test("checking, hotspot transfer and reconnect remain observable without becoming final success", () => {
  expect(otaPage(screen("Checking for updates")).kind).toBe("checking")
  for (const label of [
    "Downloading…",
    "Installing…",
    "Downloading update to phone...",
    "Starting glasses hotspot...",
    "Connecting phone to glasses...",
    "Transferring update to glasses...",
    "Installing update on glasses...",
    "Finishing your update",
  ])
    expect(otaPage(screen(label)).kind).toBe("working")
  expect(otaPage(screen("Glasses disconnected", "Reconnecting...")).kind).toBe("working")
  expect(otaPage(screen("Done")).kind).toBe("unknown")
  expect(otaPage(screen("Done", "Update Failed", "Installing update on glasses...")).kind).toBe("failed")
})

test("USB selection rejects an unauthorized, different or ambiguous pair", () => {
  const row = "ML396102B device usb:1048576X transport_id:9"
  expect(selectUsbTransport("0123456789ABCDEF device usb:other transport_id:4\n" + row, "ML396102B", "1048576X")).toBe(
    "9",
  )
  for (const bad of [row.replace("device", "unauthorized"), row.replace("1048576X", "other"), row + "\n" + row])
    expect(() => selectUsbTransport(bad, "ML396102B", "1048576X")).toThrow()
})

test("BES qualification rejects stale, previous-boot and conflicting current-boot responses", () => {
  const log = "1000.500 10 10 I K: BES_OTA_DIAG version_proof actual=26.9.17.0 current_boot=fixture disposition=ignored"
  expect(freshBesProof(log, "fixture", 1010).version).toBe("26.9.17.0")
  expect(() => freshBesProof(log, "other", 1010)).toThrow()
  expect(() => freshBesProof(log, "fixture", 1040)).toThrow()
  expect(() => freshBesProof(log, "fixture", 900)).toThrow()
  expect(() => freshBesProof(log, "fixture", NaN)).toThrow()
  expect(
    freshBesProof(
      log + "\n1010.000 I K: BES_OTA_DIAG version_proof actual=26.9.15.0 current_boot=fixture",
      "fixture",
      1011,
    ).version,
  ).toBe("26.9.15.0")
})

test("route and observed firmware share canonicalization across mixed prefixes", () => {
  const route = otaFirmwareRoute("20260113", "MentraLive_20260915.0", [
    {start_firmware: "MentraLive_20260113", end_firmware: "20260709"},
    {start_firmware: "20260709", end_firmware: "20260915.0"},
  ])
  for (const version of [
    "20260113",
    "MentraLive_20260113",
    "20260709",
    "MentraLive_20260709",
    "20260915.0",
    "MentraLive_20260915.0",
  ])
    expect(() => checkOtaObservedVersions(version, 2, route, [2], false)).not.toThrow()
  expect(() => checkOtaObservedVersions("MentraLive_20260709", 2, ["20260709"], [2], false)).not.toThrow()
  for (const version of ["20260114", "MentraLive_20260114", "20260915.1", "bad_20260709", "20260709bad"])
    expect(() => checkOtaObservedVersions(version, 2, route, [2], true)).toThrow()
})

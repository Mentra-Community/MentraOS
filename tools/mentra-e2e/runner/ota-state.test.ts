import {expect, test} from "bun:test"
import type {Snapshot} from "./driver"
import {freshBesProof, otaPage, selectUsbTransport} from "./ota-state"

const screen = (...labels: string[]) =>
  ({elements: labels.map((description) => ({visible: true, description}))} as Snapshot)

test("Done and transient component completion cannot pass the complete OTA routine", () => {
  expect(otaPage(screen("Done", "Update Failed")).kind).toBe("failed")
  expect(otaPage(screen("Done", "Update complete!", "Your glasses are up to date.")).kind).toBe("unknown")
  expect(otaPage(screen("Done", "Update Complete", "Your glasses are running the latest version.")).kind).toBe(
    "complete",
  )
  expect(otaPage(screen("Continue", "Up to Date", "Your glasses are running the latest version.")).kind).toBe("current")
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

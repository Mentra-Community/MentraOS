/// <reference types="bun-types" />

import {describe, expect, test} from "bun:test"

import {
  adbReverse,
  closeUsbTunnel,
  hasAdb,
  listDevices,
  missingReversePorts,
  openUsbTunnel,
  parseAdbDevices,
  parseReverseList,
  selectUsbDevice,
  type AdbRunner,
  type AdbRunResult,
} from "./adb"

const ok = (stdout = ""): AdbRunResult => ({exitCode: 0, stdout, stderr: ""})
const err = (stderr = "boom"): AdbRunResult => ({exitCode: 1, stdout: "", stderr})

/** Scripted adb: the handler matches on argv so tests read like adb transcripts. */
function fakeAdb(handler: (args: string[]) => AdbRunResult): {run: AdbRunner; calls: string[][]} {
  const calls: string[][] = []
  const run: AdbRunner = (args) => {
    calls.push(args)
    return handler(args)
  }
  return {run, calls}
}

const reverseCalls = (calls: string[][]) => calls.filter((c) => c.includes("reverse"))

describe("parseAdbDevices", () => {
  test("drops the header and daemon chatter", () => {
    const stdout = [
      "* daemon not running; starting now at tcp:5037",
      "* daemon started successfully",
      "List of devices attached",
      "R58M1234ABC\tdevice",
      "",
    ].join("\n")

    expect(parseAdbDevices(stdout)).toEqual([{serial: "R58M1234ABC", state: "device"}])
  })

  test("preserves unusable states so callers can explain why", () => {
    const stdout = ["List of devices attached", "AAA111\tdevice", "BBB222\tunauthorized", "CCC333\toffline"].join("\n")

    expect(parseAdbDevices(stdout)).toEqual([
      {serial: "AAA111", state: "device"},
      {serial: "BBB222", state: "unauthorized"},
      {serial: "CCC333", state: "offline"},
    ])
  })

  test("returns nothing when no devices are attached", () => {
    expect(parseAdbDevices("List of devices attached\n\n")).toEqual([])
  })

  test("treats a multi-word state as not-`device`", () => {
    // Linux udev misconfiguration produces `no permissions (user in plugdev…)`.
    const parsed = parseAdbDevices("List of devices attached\nDDD444\tno permissions (udev rules)")
    expect(parsed).toHaveLength(1)
    expect(parsed[0]!.state).not.toBe("device")
  })
})

describe("parseReverseList", () => {
  test("extracts the device-side port and dedupes", () => {
    const stdout = [
      "R58M1234ABC tcp:3000 tcp:3000",
      "R58M1234ABC tcp:3001 tcp:3001",
      "R58M1234ABC tcp:3000 tcp:3000",
    ].join("\n")
    expect(parseReverseList(stdout)).toEqual([3000, 3001])
  })

  test("ignores lines without a tcp pair", () => {
    expect(parseReverseList("localabstract:foo localabstract:bar\n\n")).toEqual([])
  })
})

describe("selectUsbDevice", () => {
  test("omits the serial when exactly one device is attached", () => {
    const selection = selectUsbDevice([{serial: "AAA111", state: "device"}])
    if (!selection.ok) throw new Error(`expected success, got: ${selection.reason}`)
    expect(selection.serial).toBeUndefined()
  })

  test("refuses to guess between several devices and lists them", () => {
    const selection = selectUsbDevice([
      {serial: "AAA111", state: "device"},
      {serial: "BBB222", state: "device"},
    ])
    if (selection.ok) throw new Error("expected failure")
    expect(selection.reason).toContain("AAA111")
    expect(selection.reason).toContain("BBB222")
    expect(selection.reason).toContain("--device")
  })

  test("ignores the Mentra Live glasses serial when a phone is also attached", () => {
    const selection = selectUsbDevice([
      {serial: "0123456789ABCDEF", state: "device"},
      {serial: "RFCT31GXXQJ", state: "device"},
    ])
    if (!selection.ok) throw new Error(`expected success, got: ${selection.reason}`)
    expect(selection.serial).toBe("RFCT31GXXQJ")
  })

  test("still requires --device when two phones plus glasses are attached", () => {
    const selection = selectUsbDevice([
      {serial: "0123456789ABCDEF", state: "device"},
      {serial: "AAA111", state: "device"},
      {serial: "BBB222", state: "device"},
    ])
    if (selection.ok) throw new Error("expected failure")
    expect(selection.reason).toContain("AAA111")
    expect(selection.reason).toContain("BBB222")
    expect(selection.reason).not.toContain("0123456789ABCDEF")
  })

  test("uses the glasses when they are the only attached device", () => {
    const selection = selectUsbDevice([{serial: "0123456789ABCDEF", state: "device"}])
    if (!selection.ok) throw new Error(`expected success, got: ${selection.reason}`)
    expect(selection.serial).toBeUndefined()
  })

  test("still honours an explicit glasses serial", () => {
    const selection = selectUsbDevice(
      [
        {serial: "0123456789ABCDEF", state: "device"},
        {serial: "RFCT31GXXQJ", state: "device"},
      ],
      "0123456789ABCDEF",
    )
    if (!selection.ok) throw new Error(`expected success, got: ${selection.reason}`)
    expect(selection.serial).toBe("0123456789ABCDEF")
  })

  test("honours an explicit serial", () => {
    const selection = selectUsbDevice(
      [
        {serial: "AAA111", state: "device"},
        {serial: "BBB222", state: "device"},
      ],
      "BBB222",
    )
    if (!selection.ok) throw new Error(`expected success, got: ${selection.reason}`)
    expect(selection.serial).toBe("BBB222")
  })

  test("rejects an explicit serial that is not attached", () => {
    const selection = selectUsbDevice([{serial: "AAA111", state: "device"}], "NOPE")
    if (selection.ok) throw new Error("expected failure")
    expect(selection.reason).toContain("NOPE")
    expect(selection.reason).toContain("AAA111")
  })

  test("rejects an explicit serial that is attached but unusable", () => {
    const selection = selectUsbDevice([{serial: "AAA111", state: "unauthorized"}], "AAA111")
    if (selection.ok) throw new Error("expected failure")
    expect(selection.reason).toContain("unauthorized")
  })

  test("points at the USB debugging prompt when the only device is unauthorized", () => {
    const selection = selectUsbDevice([{serial: "AAA111", state: "unauthorized"}])
    if (selection.ok) throw new Error("expected failure")
    expect(selection.reason).toContain("USB debugging prompt")
  })

  test("flags USB mode as Android-only when nothing is attached", () => {
    const selection = selectUsbDevice([])
    if (selection.ok) throw new Error("expected failure")
    expect(selection.reason).toContain("Android-only")
  })
})

describe("openUsbTunnel", () => {
  const attached = (serial = "R58M1234ABC") => `List of devices attached\n${serial}\tdevice\n`

  test("reverses every requested port", () => {
    const {run, calls} = fakeAdb((args) => {
      if (args[0] === "version") return ok("Android Debug Bridge version 1.0.41")
      if (args[0] === "devices") return ok(attached())
      if (args[0] === "reverse") return ok()
      return err()
    })

    const result = openUsbTunnel([3000, 3001], {run})
    if (!result.ok) throw new Error(`expected success, got: ${result.reason}`)
    expect(reverseCalls(calls)).toEqual([
      ["reverse", "tcp:3000", "tcp:3000"],
      ["reverse", "tcp:3001", "tcp:3001"],
    ])
  })

  test("targets the chosen device with -s", () => {
    const {run, calls} = fakeAdb((args) => {
      if (args[0] === "version") return ok()
      if (args[0] === "devices") return ok("List of devices attached\nAAA111\tdevice\nBBB222\tdevice\n")
      return ok()
    })

    const result = openUsbTunnel([3000], {device: "BBB222", run})
    if (!result.ok) throw new Error(`expected success, got: ${result.reason}`)
    expect(result.serial).toBe("BBB222")
    expect(reverseCalls(calls)).toEqual([["-s", "BBB222", "reverse", "tcp:3000", "tcp:3000"]])
  })

  test("explains a missing adb binary", () => {
    const {run} = fakeAdb(() => ({exitCode: 127, stdout: "", stderr: "command not found"}))
    const result = openUsbTunnel([3000], {run})
    if (result.ok) throw new Error("expected failure")
    expect(result.reason).toContain("not found on PATH")
  })

  test("rolls back already-opened ports when a later one fails", () => {
    const {run, calls} = fakeAdb((args) => {
      if (args[0] === "version") return ok()
      if (args[0] === "devices") return ok(attached())
      if (args[0] === "reverse" && args[1] === "tcp:3001") return err()
      return ok()
    })

    const result = openUsbTunnel([3000, 3001], {run})
    if (result.ok) throw new Error("expected failure")
    expect(result.reason).toContain("tcp:3001")
    // A half-open tunnel would serve files but break live reload — assert the
    // successful mapping was withdrawn.
    expect(calls).toContainEqual(["reverse", "--remove", "tcp:3000"])
  })
})

describe("missingReversePorts", () => {
  test("reports only the ports absent from the live list", () => {
    const {run} = fakeAdb(() => ok("R58M1234ABC tcp:3000 tcp:3000"))
    expect(missingReversePorts([3000, 3001], {run})).toEqual([3001])
  })

  test("treats an unreachable device as everything missing", () => {
    const {run} = fakeAdb(() => err("error: no devices/emulators found"))
    expect(missingReversePorts([3000, 3001], {run})).toEqual([3000, 3001])
  })
})

describe("thin adb wrappers", () => {
  test("hasAdb reflects the exit code of `adb version`", () => {
    expect(hasAdb(fakeAdb(() => ok()).run)).toBe(true)
    expect(hasAdb(fakeAdb(() => err()).run)).toBe(false)
  })

  test("listDevices returns nothing when the adb call fails", () => {
    expect(listDevices(fakeAdb(() => err()).run)).toEqual([])
  })

  test("adbReverse reports the exit status", () => {
    expect(adbReverse(3000, {run: fakeAdb(() => ok()).run})).toBe(true)
    expect(adbReverse(3000, {run: fakeAdb(() => err()).run})).toBe(false)
  })

  test("closeUsbTunnel removes each port and tolerates failures", () => {
    const {run, calls} = fakeAdb(() => err())
    closeUsbTunnel([3000, 3001], {run})
    expect(calls).toEqual([
      ["reverse", "--remove", "tcp:3000"],
      ["reverse", "--remove", "tcp:3001"],
    ])
  })
})

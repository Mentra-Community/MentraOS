/// <reference types="bun-types" />

import {beforeEach, describe, expect, mock, test} from "bun:test"
import {FleetDeviceBindingSchema} from "@mentra/cloud-protocol"
import {fakeCreateMMKV, resetFakeMmkv} from "./fakeMmkv"

mock.module("react-native-mmkv", () => ({createMMKV: fakeCreateMMKV}))

const {glassesBinding, glassesManufacturer, isPlaceholderSerial} = await import("../glassesIdentity")

const PHONE = "01PHONE000000000000000000"

beforeEach(() => {
  resetFakeMmkv()
})

describe("glassesBinding with a serial number", () => {
  test("binds by serial, with the manufacturer from the model", () => {
    const binding = glassesBinding({deviceModel: "Mentra Live", serialNumber: "SN-LIVE-001"}, PHONE)
    expect(binding).toEqual({kind: "serial", manufacturer: "Mentra", product: "Mentra Live", serial: "SN-LIVE-001"})
    expect(FleetDeviceBindingSchema.parse(binding)).toEqual(binding as never)
  })

  test("trims the serial and the model", () => {
    expect(glassesBinding({deviceModel: " Mentra Live ", serialNumber: "  SN-1\n"}, PHONE)).toEqual({
      kind: "serial",
      manufacturer: "Mentra",
      product: "Mentra Live",
      serial: "SN-1",
    })
  })

  test.each([
    ["Mentra Live", "Mentra"],
    ["Mentra Display", "Mentra"],
    ["Even Realities G1", "Even Realities"],
    ["Even Realities G2", "Even Realities"],
    ["Vuzix Z100", "Vuzix"],
    ["Mentra Mach1", "Vuzix"],
    ["Brilliant Frame", "Brilliant Labs"],
  ])("%s is made by %s", (model, manufacturer) => {
    expect(glassesManufacturer(model)).toBe(manufacturer)
  })

  test("a model the map does not know has manufacturer unknown, and is matched without case", () => {
    expect(glassesManufacturer("Acme Specs 9")).toBe("unknown")
    expect(glassesManufacturer("NIMO")).toBe("unknown")
    expect(glassesManufacturer("mentra live")).toBe("Mentra")
    expect(glassesBinding({deviceModel: "Acme Specs 9", serialNumber: "A9-1"}, PHONE)).toEqual({
      kind: "serial",
      manufacturer: "unknown",
      product: "Acme Specs 9",
      serial: "A9-1",
    })
  })

  test("a serial that is too long for the contract is not used", () => {
    const binding = glassesBinding({deviceModel: "Mentra Live", serialNumber: "S".repeat(129)}, PHONE)
    expect(binding?.kind).toBe("provisional")
  })
})

describe("glassesBinding without a usable serial", () => {
  test.each([
    ["empty", ""],
    ["blank", "   "],
    ["all zeros", "0000000000"],
    ["a single zero", "0"],
    ["unknown", "unknown"],
    ["Unknown", " Unknown "],
    ["N/A", "N/A"],
    ["null", "null"],
    ["undefined", "undefined"],
    ["none", "None"],
    ["a dash", "-"],
    ["default", "DEFAULT"],
  ])("%s serial gives a provisional binding", (_label, serial) => {
    expect(isPlaceholderSerial(serial)).toBe(true)
    const binding = glassesBinding({deviceModel: "Even Realities G1", serialNumber: serial}, PHONE)
    expect(binding?.kind).toBe("provisional")
    if (binding?.kind !== "provisional") throw new Error("expected a provisional binding")
    expect(binding.product).toBe("Even Realities G1")
    expect(binding.bindingId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(FleetDeviceBindingSchema.safeParse(binding).success).toBe(true)
  })

  test("a real serial is not a placeholder", () => {
    expect(isPlaceholderSerial("SN-LIVE-001")).toBe(false)
    expect(isPlaceholderSerial("A0001")).toBe(false)
    expect(isPlaceholderSerial("1000000")).toBe(false)
  })

  test("the same glasses get the same binding on every call", () => {
    const status = {deviceModel: "Even Realities G1", serialNumber: "", bluetoothMacAddress: "AA:BB:CC:DD:EE:01"}
    expect(glassesBinding(status, PHONE)).toEqual(glassesBinding(status, PHONE) as never)
  })

  test("another pair of the same model gets another binding", () => {
    const first = glassesBinding(
      {deviceModel: "Even Realities G1", serialNumber: "", bluetoothMacAddress: "AA:BB:CC:DD:EE:01"},
      PHONE,
    )
    const second = glassesBinding(
      {deviceModel: "Even Realities G1", serialNumber: "", bluetoothMacAddress: "AA:BB:CC:DD:EE:02"},
      PHONE,
    )
    expect(first).not.toEqual(second as never)
  })

  test("the same address in another case is the same pair", () => {
    const upper = glassesBinding({deviceModel: "Mentra Live", serialNumber: "", bluetoothMacAddress: "AA:BB"}, PHONE)
    const lower = glassesBinding({deviceModel: "Mentra Live", serialNumber: "", bluetoothMacAddress: "aa:bb"}, PHONE)
    expect(upper).toEqual(lower as never)
  })

  test("falls back from the Bluetooth address to the left arm and then to the Bluetooth name", () => {
    const byLeft = glassesBinding({deviceModel: "Even Realities G1", serialNumber: "", leftMacAddress: "L-1"}, PHONE)
    const byName = glassesBinding({deviceModel: "Even Realities G1", serialNumber: "", bluetoothName: "G1_77"}, PHONE)
    const byBoth = glassesBinding(
      {deviceModel: "Even Realities G1", serialNumber: "", bluetoothMacAddress: "", leftMacAddress: "L-1"},
      PHONE,
    )
    expect(byLeft).toEqual(byBoth as never)
    expect(byLeft).not.toEqual(byName as never)
    expect(byName?.kind).toBe("provisional")
  })

  test("glasses that show no address at all are one pair per model", () => {
    const a = glassesBinding({deviceModel: "Vuzix Z100", serialNumber: ""}, PHONE)
    const b = glassesBinding({deviceModel: "Vuzix Z100", serialNumber: ""}, PHONE)
    const other = glassesBinding({deviceModel: "Mentra Live", serialNumber: ""}, PHONE)
    expect(a).toEqual(b as never)
    expect(a).not.toEqual(other as never)
  })

  test("the binding does not reveal the address it came from", () => {
    const binding = glassesBinding(
      {deviceModel: "Mentra Live", serialNumber: "", bluetoothMacAddress: "AA:BB:CC:DD:EE:FF"},
      PHONE,
    )
    expect(JSON.stringify(binding)).not.toMatch(/aa:bb:cc/i)
  })
})

describe("glassesBinding for glasses that are not known", () => {
  test.each(["", "   "])("a blank model (%j) gives no binding", (deviceModel) => {
    expect(glassesBinding({deviceModel, serialNumber: "SN-1"}, PHONE)).toBeNull()
  })

  test("a model longer than the contract allows is cut to fit it", () => {
    const binding = glassesBinding({deviceModel: "M".repeat(200), serialNumber: "SN-1"}, PHONE)
    expect(binding && FleetDeviceBindingSchema.safeParse(binding).success).toBe(true)
  })
})

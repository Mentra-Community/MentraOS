/**
 * Which glasses a Fleet record is about.
 *
 * Glasses with a real serial number are bound by it. Glasses without one (placeholder or blank serials, models that
 * report none) get a provisional binding: a random ID this phone made for that pair, kept in `mentra-fleet`, so a
 * pair is one device to Fleet across reconnects without anything in the record revealing its Bluetooth address.
 * The simulated glasses are no device at all.
 *
 * A pair is named by its product, not by whatever model string it reports at the moment: Mentra Live reports its
 * hardware variant once its glasses client answers (see `glassesProduct`).
 */
import type {PublicGlassesStatus} from "@mentra/bluetooth-sdk"
import type {FleetDeviceBinding} from "@mentra/cloud-protocol"
import {DeviceTypes} from "../../types/enums"
import {provisionalBindingId} from "./fleetIds"

/** What the binding reads from the glasses store; the whole store state satisfies it. */
export type GlassesIdentitySource = Pick<PublicGlassesStatus, "deviceModel" | "serialNumber"> &
  Partial<Pick<PublicGlassesStatus, "bluetoothMacAddress" | "leftMacAddress" | "bluetoothName">>

const MAX_TEXT = 128

/**
 * Maker by model. The manufacturer is part of a serial's identity key, so it follows the brand on the box and not
 * the hardware supplier: every "Mentra ..." model is Mentra. Anything else is "unknown", which is honest and valid.
 */
const MANUFACTURERS: Record<string, string> = {
  "even realities g1": "Even Realities",
  "even realities g2": "Even Realities",
  "vuzix z100": "Vuzix",
}
const MENTRA_BRANDED = /^mentra\s/

/** Values glasses send, or the engine leaves, where a serial number should be. */
const PLACEHOLDER_SERIALS = new Set(["unknown", "n/a", "na", "null", "none", "undefined", "default", "-", "(none)"])

/**
 * Mentra Live's glasses client names its hardware variant as the model when it answers (K900, K900Plus, K900PlusV2,
 * "K900 (variant unknown)"), replacing the "Mentra Live" the Bluetooth SDK started the connection with, and the store
 * keeps that name through a reconnect. Every one of them is a Mentra Live.
 */
const MENTRA_LIVE_HARDWARE = /^k900/i

/** The product the glasses are, as Fleet names it: the same for one pair whatever model string it reports. */
export function glassesProduct(model: string): string {
  const trimmed = typeof model === "string" ? model.trim().slice(0, MAX_TEXT) : ""
  return MENTRA_LIVE_HARDWARE.test(trimmed) ? DeviceTypes.LIVE : trimmed
}

export function glassesManufacturer(model: string): string {
  const key = model.trim().toLowerCase()
  if (MENTRA_BRANDED.test(key)) return "Mentra"
  return MANUFACTURERS[key] ?? "unknown"
}

/** The engine's simulated glasses: a development stand-in, never a device in anyone's fleet. */
export function isSimulatedGlasses(model: string): boolean {
  return typeof model === "string" && model.trim().toLowerCase() === DeviceTypes.SIMULATED.toLowerCase()
}

/**
 * What tells one pair of the same model from another: the Bluetooth address, else the left arm's, else the name,
 * trimmed and lower-cased. Null when the glasses show none of them.
 */
export function glassesPeripheral(status: GlassesIdentitySource): string | null {
  const peripheral = [status.bluetoothMacAddress, status.leftMacAddress, status.bluetoothName]
    .map((value) => value?.trim() ?? "")
    .find((value) => value !== "")
  return peripheral ? peripheral.toLowerCase() : null
}

/** True for a blank serial, one of only zeros (the manufacturing default), or a stand-in word. */
export function isPlaceholderSerial(serial: string): boolean {
  const value = serial.trim()
  return value === "" || /^0+$/.test(value) || PLACEHOLDER_SERIALS.has(value.toLowerCase())
}

/** The glasses' serial number, or null when they report none Fleet can use (blank, a placeholder, too long). */
export function usableSerial(status: Pick<GlassesIdentitySource, "serialNumber">): string | null {
  const serial = typeof status.serialNumber === "string" ? status.serialNumber.trim() : ""
  return !isPlaceholderSerial(serial) && serial.length <= MAX_TEXT ? serial : null
}

export function serialBinding(product: string, serial: string): FleetDeviceBinding {
  return {kind: "serial", manufacturer: glassesManufacturer(product), product, serial}
}

/** This phone's provisional binding for the pair of `product` that `peripheral` tells apart (`glassesPeripheral`). */
export function provisionalBinding(product: string, peripheral: string | null): FleetDeviceBinding {
  return {kind: "provisional", bindingId: provisionalBindingId(product, peripheral), product}
}

/**
 * The binding for the glasses described by `status`, or null when no glasses are known (no model) or they are the
 * simulated glasses.
 *
 * `phoneId` names the phone the binding is for. The provisional ID is already per phone, because it lives in this
 * phone's own store, so the ID is not read here; callers pass it so a binding is always asked for on behalf of one
 * phone.
 */
export function glassesBinding(status: GlassesIdentitySource, _phoneId: string): FleetDeviceBinding | null {
  const product = glassesProduct(status.deviceModel)
  if (product === "" || isSimulatedGlasses(product)) return null
  const serial = usableSerial(status)
  return serial !== null ? serialBinding(product, serial) : provisionalBinding(product, glassesPeripheral(status))
}

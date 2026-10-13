/**
 * Which glasses a Fleet record is about.
 *
 * Glasses with a real serial number are bound by it. Glasses without one (placeholder or blank serials, models that
 * report none) get a provisional binding: a random ID this phone made for that pair, kept in `mentra-fleet`, so a
 * pair is one device to Fleet across reconnects without anything in the record revealing its Bluetooth address.
 */
import type {PublicGlassesStatus} from "@mentra/bluetooth-sdk"
import type {FleetDeviceBinding} from "@mentra/cloud-protocol"
import {provisionalBindingId} from "./fleetIds"

/** What the binding reads from the glasses store; the whole store state satisfies it. */
export type GlassesIdentitySource = Pick<PublicGlassesStatus, "deviceModel" | "serialNumber"> &
  Partial<Pick<PublicGlassesStatus, "bluetoothMacAddress" | "leftMacAddress" | "bluetoothName">>

const MAX_TEXT = 128

/** Maker by model, for the models the engine names. Anything else is "unknown", which is honest and valid. */
const MANUFACTURERS: Record<string, string> = {
  "mentra live": "Mentra",
  "mentra display": "Mentra",
  "even realities g1": "Even Realities",
  "even realities g2": "Even Realities",
  "vuzix z100": "Vuzix",
  // Mach1 is the Vuzix Ultralite hardware under Mentra's name.
  "mentra mach1": "Vuzix",
  "brilliant frame": "Brilliant Labs",
}

/** Values glasses send, or the engine leaves, where a serial number should be. */
const PLACEHOLDER_SERIALS = new Set(["unknown", "n/a", "na", "null", "none", "undefined", "default", "-", "(none)"])

export function glassesManufacturer(model: string): string {
  return MANUFACTURERS[model.trim().toLowerCase()] ?? "unknown"
}

/** True for a blank serial, one of only zeros (the manufacturing default), or a stand-in word. */
export function isPlaceholderSerial(serial: string): boolean {
  const value = serial.trim()
  return value === "" || /^0+$/.test(value) || PLACEHOLDER_SERIALS.has(value.toLowerCase())
}

/**
 * The binding for the glasses described by `status`, or null when no glasses are known (no model).
 *
 * `phoneId` names the phone the binding is for. The provisional ID is already per phone, because it lives in this
 * phone's own store, so the ID is not read here; callers pass it so a binding is always asked for on behalf of one
 * phone.
 */
export function glassesBinding(status: GlassesIdentitySource, _phoneId: string): FleetDeviceBinding | null {
  const model = status.deviceModel.trim().slice(0, MAX_TEXT)
  if (model === "") return null

  const serial = status.serialNumber.trim()
  if (!isPlaceholderSerial(serial) && serial.length <= MAX_TEXT) {
    return {kind: "serial", manufacturer: glassesManufacturer(model), product: model, serial}
  }

  const peripheral = [status.bluetoothMacAddress, status.leftMacAddress, status.bluetoothName]
    .map((value) => value?.trim() ?? "")
    .find((value) => value !== "")
  return {kind: "provisional", bindingId: provisionalBindingId(model, peripheral ?? null), product: model}
}

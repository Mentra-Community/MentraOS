/**
 * Which glasses a Fleet record is about.
 *
 * Glasses with a real serial number are bound by it. Glasses without one (placeholder or blank serials, models that
 * report none) get a provisional binding: a random ID this phone made for that pair, kept in `mentra-fleet`, so a
 * pair is one device to Fleet across reconnects without anything in the record revealing its Bluetooth address.
 * The simulated glasses are no device at all.
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

/**
 * The binding for the glasses described by `status`, or null when no glasses are known (no model) or they are the
 * simulated glasses.
 *
 * `phoneId` names the phone the binding is for. The provisional ID is already per phone, because it lives in this
 * phone's own store, so the ID is not read here; callers pass it so a binding is always asked for on behalf of one
 * phone.
 */
export function glassesBinding(status: GlassesIdentitySource, _phoneId: string): FleetDeviceBinding | null {
  const model = status.deviceModel.trim().slice(0, MAX_TEXT)
  if (model === "" || isSimulatedGlasses(model)) return null

  const serial = status.serialNumber.trim()
  if (!isPlaceholderSerial(serial) && serial.length <= MAX_TEXT) {
    return {kind: "serial", manufacturer: glassesManufacturer(model), product: model, serial}
  }
  return {kind: "provisional", bindingId: provisionalBindingId(model, glassesPeripheral(status)), product: model}
}

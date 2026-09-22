/// <reference types="bun-types" />

import {mock} from "bun:test"

/**
 * One BluetoothSdk stub for the whole bun process.
 *
 * bun's `mock.module` patches a process-wide registry — last factory wins — so
 * every suite that replaced `@mentra/bluetooth-sdk/internal` with its own object
 * silently deleted the methods the other suites installed. The factory here is
 * registered once and always returns this same object; each file just assigns
 * the methods it cares about.
 */
export const bluetoothSdk: Record<string, unknown> = {}

mock.module("@mentra/bluetooth-sdk/internal", () => ({
  __esModule: true,
  default: bluetoothSdk,
}))

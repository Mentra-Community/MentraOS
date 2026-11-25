/// <reference types="bun-types" />

import {mock} from "bun:test"

import {holdCameraWarm} from "../../../../bluetooth-sdk/src/camera-warm"

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

/** The SDK's glasses Wi-Fi service: suites that hold the link inject their own. */
class GlassesWifiError extends Error {
  constructor(
    readonly stage: "enable" | "join",
    readonly cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause))
  }
}
const glassesWifi = {
  GlassesWifiError,
  holdGlassesWifi: async () => {
    throw new Error("holdGlassesWifi is not stubbed in this suite")
  },
  holdGlassesWifiIfUp: async () => null,
  glassesWifiLink: {
    isScoped: () => false,
    request: async () => ({status: 200, headers: {}, bodyBase64: ""}),
    download: async () => ({statusCode: 200, bytesWritten: 0, headers: {}}),
    cancel: async () => {},
    onDownloadProgress: () => () => {},
  },
  openCameraSession: () => ({
    capture: async () => {
      throw new Error("openCameraSession is not stubbed in this suite")
    },
    continuous: () => ({state: "paused", onPhoto: () => () => {}, onState: () => () => {}, stop: () => {}}),
    close: async () => {},
  }),
}

mock.module("@mentra/bluetooth-sdk/internal", () => ({
  __esModule: true,
  default: bluetoothSdk,
  // The SDK's own held warm-up, over whatever warmUpCamera / stopCameraWarmUp / addListener a suite installs.
  holdCameraWarm,
  ...glassesWifi,
}))
mock.module("@mentra/bluetooth-sdk/glasses-wifi", () => glassesWifi)

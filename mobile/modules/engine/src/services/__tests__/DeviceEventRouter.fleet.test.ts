/// <reference types="bun-types" />

import {afterAll, beforeEach, describe, expect, mock, test} from "bun:test"

import {bluetoothSdk} from "./bluetoothSdkTestMock"

// Only the glasses-menu pick is exercised: every other dependency of the router is stubbed.
const listeners = new Map<string, (event: Record<string, unknown>) => unknown>()
Object.assign(bluetoothSdk, {
  addListener: (name: string, listener: (event: Record<string, unknown>) => unknown) => {
    listeners.set(name, listener)
    return {remove: () => listeners.delete(name)}
  },
})

const start = mock(async (_app: unknown, _opts?: unknown) => true)
const stop = mock(async (_packageName: string) => {})
let apps: Array<{packageName: string; running: boolean}> = []

mock.module("../LocalMiniappRuntime", () => ({default: {forwardEvent: () => {}}}))
mock.module("../LocalSttFallbackCoordinator", () => ({default: {}}))
mock.module("../AudioPlaybackService", () => ({default: {prepareForPlayback: async () => {}}}))
mock.module("../WakeWordService", () => ({wakeWordService: {onNativeEvent: () => null}}))
mock.module("../PhonePhotoCoordinator", () => ({phonePhotoCoordinator: {}}))
mock.module("../PhoneStreamCoordinator", () => ({phoneStreamCoordinator: {}}))
mock.module("../GlassesReadiness", () => ({isGlassesConnected: () => false}))
mock.module("../../stores/glasses", () => ({
  useGlassesStore: {getState: () => ({}), subscribe: () => () => {}},
}))
mock.module("../../stores/settings", () => ({useSettingsStore: {getState: () => ({})}}))
mock.module("../../stores/apps", () => ({
  useAppStatusStore: {getState: () => ({apps, start, stop})},
}))
mock.module("../PairingIdentity", () => ({retirePendingSelectionOnPromotion: () => {}}))
mock.module("../../utils/GlobalEventEmitter", () => ({default: {emit: () => {}}}))
mock.module("../asg/asgCameraApi", () => ({asgCameraApi: {}}))

const {startDeviceEventRouter, stopDeviceEventRouter} = await import("../DeviceEventRouter")

beforeEach(() => {
  stopDeviceEventRouter()
  listeners.clear()
  start.mockClear()
  stop.mockClear()
  apps = [
    {packageName: "com.mentra.notes", running: false},
    {packageName: "com.mentra.maps", running: true},
  ]
  startDeviceEventRouter()
})

afterAll(stopDeviceEventRouter)

describe("glasses-menu miniapp pick", () => {
  test("starts a miniapp that is not running as a user start, without navigation", () => {
    listeners.get("miniapp_selected")?.({packageName: "com.mentra.notes"})
    expect(start).toHaveBeenCalledTimes(1)
    expect(start.mock.calls[0]).toEqual([apps[0], {skipNavigation: true, trigger: "user"}])
    expect(stop).not.toHaveBeenCalled()
  })

  test("stops a miniapp that is running, as before", () => {
    listeners.get("miniapp_selected")?.({packageName: "com.mentra.maps"})
    expect(stop).toHaveBeenCalledWith("com.mentra.maps")
    expect(start).not.toHaveBeenCalled()
  })

  test("ignores a miniapp the store does not have", () => {
    listeners.get("miniapp_selected")?.({packageName: "com.mentra.missing"})
    listeners.get("miniapp_selected")?.({})
    expect(start).not.toHaveBeenCalled()
    expect(stop).not.toHaveBeenCalled()
  })
})

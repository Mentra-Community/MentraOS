/// <reference types="bun-types" />

import {afterAll, beforeEach, describe, expect, mock, spyOn, test} from "bun:test"

import {updateBluetoothSettings} from "./audioTestMocks"

/**
 * The on-connect device-settings replay includes the persistent `camera_fov`,
 * so it stomps whatever override a miniapp currently owns. These cover the
 * ordering that lets a Mentra Call wearer keep their 102° crop when the glasses
 * connect mid-call.
 */
let connection: {state: string; fullyBooted?: boolean} = {state: "disconnected"}
const glassesListeners = new Set<() => void>()

// The real predicate reaches @mentra/bluetooth-sdk/types, which pulls in
// react-native. Same shape and same field as the real one.
mock.module("../GlassesReadiness", () => ({
  isGlassesConnected: (value: {state?: string} | undefined) => value?.state === "connected",
}))
mock.module("../../stores/settings", () => ({
  SETTINGS: {default_wearable: {key: "default_wearable"}},
  PAIRING_IDENTITY_KEYS: ["default_wearable"],
  useSettingsStore: {
    subscribe: () => () => {},
    getState: () => ({
      getBluetoothSettings: () => ({camera_fov: 118, default_wearable: "Mentra Live"}),
    }),
  },
}))
mock.module("../../stores/glasses", () => ({
  useGlassesStore: {
    subscribe: (listener: () => void) => {
      glassesListeners.add(listener)
      return () => glassesListeners.delete(listener)
    },
    getState: () => ({connection, deviceModel: undefined}),
  },
}))

// Import AFTER the mocks are registered.
const {startGlassesSettingsSync, stopGlassesSettingsSync} = require("../GlassesSettingsSync")
const {phoneCameraFovCoordinator} = require("../PhoneCameraFovCoordinator")

/** Call order is the whole point: the re-apply has to land after the replay. */
const order: string[] = []
const reapplyEffectiveOverride = spyOn(phoneCameraFovCoordinator, "reapplyEffectiveOverride")

function setConnection(state: string): void {
  connection = {state, fullyBooted: state === "connected"}
  for (const listener of [...glassesListeners]) listener()
}

async function settle(turns = 20): Promise<void> {
  for (let turn = 0; turn < turns; turn++) await Promise.resolve()
}

beforeEach(() => {
  stopGlassesSettingsSync()
  glassesListeners.clear()
  order.length = 0
  connection = {state: "disconnected"}
  updateBluetoothSettings.mockReset()
  updateBluetoothSettings.mockImplementation(async () => {
    order.push("push")
  })
  reapplyEffectiveOverride.mockReset()
  reapplyEffectiveOverride.mockImplementation(async () => {
    order.push("reapply")
  })
})

afterAll(() => {
  stopGlassesSettingsSync()
  reapplyEffectiveOverride.mockRestore()
})

describe("GlassesSettingsSync on-connect camera FOV re-apply", () => {
  test("re-applies the override after the settings replay", async () => {
    startGlassesSettingsSync()
    setConnection("connected")
    await settle()

    expect(order).toEqual(["push", "reapply"])
    // Identity is native-authoritative and stays out of the replay.
    expect(updateBluetoothSettings.mock.calls[0]![0]).toEqual({camera_fov: 118})
  })

  test("re-applies even when the replay fails, since it may still have written camera_fov", async () => {
    updateBluetoothSettings.mockImplementationOnce(async () => {
      order.push("push")
      throw new Error("glasses dropped")
    })
    startGlassesSettingsSync()
    setConnection("connected")
    await settle()

    expect(order).toEqual(["push", "reapply"])
  })

  test("a failed re-apply is logged rather than thrown at the store subscription", async () => {
    reapplyEffectiveOverride.mockImplementationOnce(async () => {
      order.push("reapply")
      throw new Error("glasses dropped")
    })
    startGlassesSettingsSync()
    setConnection("connected")
    await settle()

    expect(order).toEqual(["push", "reapply"])
  })

  test("staying connected neither re-pushes nor re-applies", async () => {
    startGlassesSettingsSync()
    setConnection("connected")
    await settle()
    order.length = 0

    setConnection("connected")
    await settle()

    expect(order).toEqual([])
  })

  test("a reconnect re-applies again", async () => {
    startGlassesSettingsSync()
    setConnection("connected")
    await settle()
    setConnection("disconnected")
    await settle()
    order.length = 0

    setConnection("connected")
    await settle()

    expect(order).toEqual(["push", "reapply"])
  })
})

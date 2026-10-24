/// <reference types="bun-types" />

import {beforeEach, describe, expect, mock, test} from "bun:test"

// Where engine.start() and engine.stop() run the Fleet reporter, against every other runtime service.

const calls: string[] = []
function step(label: string, result?: () => unknown) {
  return mock((..._args: unknown[]) => {
    calls.push(label)
    return result?.()
  })
}

let hasCore = true
const startFleetReporter = step("fleet.start")
const stopFleetReporter = step("fleet.stop", async () => {})
const startAssignmentReconciler = step("reconciler.start")
const stopAssignmentReconciler = step("reconciler.stop")
const setFleetInventorySource = step("inventory.set")
const fleetDesiredStateClient = {fetch: async () => ({})}
const registryInventorySource = {list: () => null, subscribe: () => () => {}}

mock.module("../runtime/bootstrap", () => ({
  configure: step("configure"),
  getConfigValues: () => ({runtimeRealtimeSession: false}),
  start: step("bootstrap.start", async () => {}),
  stop: step("bootstrap.stop"),
  updateMiniappPolicy: step("updateMiniappPolicy"),
  updateUiSeams: step("updateUiSeams"),
}))
mock.module("../services/CloudClientService", () => ({
  cloudClientService: {
    init: step("cloud.init"),
    hasCore: () => hasCore,
    syncCoreTokenToBluetooth: step("cloud.syncCoreToken", async () => "token"),
    stop: step("cloud.stop"),
  },
  fleetDesiredStateClient,
}))
mock.module("../services/fleet/FleetReporter", () => ({startFleetReporter, stopFleetReporter}))
mock.module("../services/fleet/assignmentReconcilerHost", () => ({startAssignmentReconciler, stopAssignmentReconciler}))
mock.module("../services/fleet/fleetCollector", () => ({setFleetInventorySource}))
mock.module("../services/fleet/registryInventorySource", () => ({registryInventorySource}))
mock.module("../services/DeviceStoreHydration", () => ({
  hydrateDeviceStore: step("hydrateDeviceStore", async () => {}),
  demoteOrphanedDefaultWearable: step("demoteOrphanedDefaultWearable", async () => {}),
}))
mock.module("../services/GlassesSettingsSync", () => ({
  startGlassesSettingsSync: step("glassesSettings.start"),
  stopGlassesSettingsSync: step("glassesSettings.stop"),
}))
mock.module("../services/GlassesStatusProjection", () => ({
  startGlassesStatusProjection: step("statusProjection.start"),
  stopGlassesStatusProjection: step("statusProjection.stop"),
  toMiniappConnectionData: () => null,
}))
mock.module("../services/OtaService", () => ({startOtaService: step("ota.start"), stopOtaService: step("ota.stop")}))
mock.module("../services/AudioCloudUplink", () => ({
  startAudioCloudUplink: step("uplink.start"),
  stopAudioCloudUplink: step("uplink.stop"),
}))
mock.module("../services/SupportProfileSync", () => ({
  startSupportProfileSync: step("supportProfile.start"),
  stopSupportProfileSync: step("supportProfile.stop"),
}))
mock.module("../services/DeviceEventRouter", () => ({
  startDeviceEventRouter: step("deviceEvents.start"),
  stopDeviceEventRouter: step("deviceEvents.stop"),
}))
mock.module("../services/PhoneNotificationsSync", () => ({
  startPhoneNotificationsSync: step("phoneNotifications.start"),
  stopPhoneNotificationsSync: step("phoneNotifications.stop"),
}))
mock.module("../services/MentraJSCrashloopReportService", () => ({
  startMentraJSCrashloopReportService: step("crashloop.start"),
  stopMentraJSCrashloopReportService: step("crashloop.stop"),
}))
mock.module("../services/BesCrashReportService", () => ({
  startBesCrashReportService: step("besCrash.start"),
  stopBesCrashReportService: step("besCrash.stop"),
}))
mock.module("../services/MiniappEngine", () => ({
  ensureMiniappEngine: step("miniappEngine.ensure"),
  stopMiniappEngine: step("miniappEngine.stop"),
}))
mock.module("../services/LocalMiniappRuntime", () => ({
  default: {
    initialize: step("localMiniappRuntime.initialize"),
    cleanup: step("localMiniappRuntime.cleanup"),
    forwardEvent: step("localMiniappRuntime.forwardEvent"),
  },
}))
mock.module("../services/DisplayProcessor", () => ({
  default: {attachToRuntime: step("display.attach"), detachFromRuntime: step("display.detach")},
}))
mock.module("../services/asg/gallerySyncService", () => ({
  gallerySyncService: {initialize: step("gallery.initialize"), cleanup: step("gallery.cleanup")},
}))
for (const facade of [
  "glasses",
  "display",
  "speech",
  "session",
  "settings",
  "dev",
  "reports",
  "ota",
  "gallery",
  "miniapps",
  "pairing",
  "phoneNotifications",
  "permissions",
  "notifications",
]) {
  mock.module(`../facades/${facade}`, () => ({[facade]: {}}))
}
mock.module("../utils/devLogging", () => ({logBuffer: {startConsoleInterception: step("logBuffer.intercept")}}))

const {engine} = await import("../engine")

beforeEach(() => {
  calls.length = 0
  hasCore = true
  startFleetReporter.mockClear()
  stopFleetReporter.mockClear()
  startAssignmentReconciler.mockClear()
  stopAssignmentReconciler.mockClear()
  setFleetInventorySource.mockClear()
})

describe("engine.start()", () => {
  test("starts the Fleet reporter before it resolves: after the Core token sync, before the miniapp runtime", async () => {
    await engine.start()
    calls.push("engine.start resolved")
    const at = (label: string) => calls.indexOf(label)
    expect(startFleetReporter).toHaveBeenCalledTimes(1)
    expect(at("cloud.syncCoreToken")).toBeLessThan(at("fleet.start"))
    for (const later of ["localMiniappRuntime.initialize", "miniappEngine.ensure", "engine.start resolved"]) {
      expect({later, fleetFirst: at("fleet.start") < at(later)}).toEqual({later, fleetFirst: true})
    }
  })

  test("wires the registry's inventory before the reporter, and starts the reconciler with the desired-state client after it", async () => {
    await engine.start()
    const at = (label: string) => calls.indexOf(label)
    expect(setFleetInventorySource).toHaveBeenCalledWith(registryInventorySource)
    expect(startAssignmentReconciler).toHaveBeenCalledTimes(1)
    expect(startAssignmentReconciler).toHaveBeenCalledWith(fleetDesiredStateClient)
    expect(at("inventory.set")).toBeLessThan(at("fleet.start"))
    expect(at("fleet.start")).toBeLessThan(at("reconciler.start"))
    expect(at("reconciler.start")).toBeLessThan(at("localMiniappRuntime.initialize"))
  })

  test("does not start Fleet without a Core", async () => {
    hasCore = false
    await engine.start()
    expect(startFleetReporter).not.toHaveBeenCalled()
    expect(startAssignmentReconciler).not.toHaveBeenCalled()
    expect(setFleetInventorySource).not.toHaveBeenCalled()
  })
})

describe("engine.stop()", () => {
  test("stops the reporter before the cloud client, and a failing stop does not skip the rest", async () => {
    stopFleetReporter.mockImplementationOnce(async () => {
      calls.push("fleet.stop")
      throw new Error("reporter stop failed")
    })
    const warn = console.warn
    console.warn = () => {}
    try {
      await engine.stop()
    } finally {
      console.warn = warn
    }
    expect(stopFleetReporter).toHaveBeenCalledTimes(1)
    expect(calls.indexOf("fleet.stop")).toBeLessThan(calls.indexOf("cloud.stop"))
    expect(calls).toContain("bootstrap.stop")
  })

  test("stops the reconciler and unwires the inventory, both before the cloud client, even when the reconciler stop throws", async () => {
    stopAssignmentReconciler.mockImplementationOnce(() => {
      calls.push("reconciler.stop")
      throw new Error("reconciler stop failed")
    })
    const warn = console.warn
    console.warn = () => {}
    try {
      await engine.stop()
    } finally {
      console.warn = warn
    }
    const at = (label: string) => calls.indexOf(label)
    expect(stopAssignmentReconciler).toHaveBeenCalledTimes(1)
    expect(setFleetInventorySource).toHaveBeenCalledWith(null)
    expect(at("reconciler.stop")).toBeLessThan(at("fleet.stop"))
    expect(at("fleet.stop")).toBeLessThan(at("inventory.set"))
    expect(at("inventory.set")).toBeLessThan(at("cloud.stop"))
  })
})

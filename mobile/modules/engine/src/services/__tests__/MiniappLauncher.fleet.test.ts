/// <reference types="bun-types" />

import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, spyOn, test} from "bun:test"

import {configure, resetForTests} from "../../runtime/bootstrap"
import {fleetEvents, type FleetLaunchEvent} from "../fleet/fleetEvents"
import type {ClientApp} from "../../types/applet"

// MiniappLauncher's heavy dependencies, stubbed as in MiniappLauncher.test.ts. Only autostart is exercised here.
let installed: Array<Partial<ClientApp>> = []
let runningFlags = new Set<string>()
const savedRunningState: Array<[string, boolean]> = []

mock.module("../AppRegistry", () => ({
  default: {getInstalledMiniapps: async () => installed},
  getLocalAppRunningState: (packageName: string) => runningFlags.has(packageName),
  saveLocalAppRunningState: (packageName: string, running: boolean) => savedRunningState.push([packageName, running]),
}))
mock.module("../DevServerBridge", () => ({default: {connect: () => {}}}))
mock.module("../LocalMiniappRuntime", () => ({default: {waitForConnect: async () => {}}}))
mock.module("../../utils/storage/storage", () => ({
  storage: {load: () => ({is_ok: () => false}), save: () => ({is_ok: () => true})},
}))
mock.module("expo-file-system", () => ({File: class {}}))
mock.module("../../stores/settings", () => ({
  SETTINGS: {super_mode: {key: "super_mode"}},
  useSettingsStore: {getState: () => ({getSetting: () => false})},
}))

let miniappLauncher: typeof import("../MiniappLauncher").miniappLauncher

const notes = {packageName: "com.mentra.notes", name: "Notes", version: "1.0.30", local: true}
const maps = {packageName: "com.mentra.maps", name: "Maps", version: "2.1.0", local: true}

const launches: FleetLaunchEvent[] = []
let stopListening: () => void = () => {}
let ensureRunning: ReturnType<typeof spyOn>
let isRunning: ReturnType<typeof spyOn>
let warn: ReturnType<typeof spyOn>

beforeAll(async () => {
  configure({auth: {}})
  miniappLauncher = (await import("../MiniappLauncher")).miniappLauncher
})

afterAll(resetForTests)

beforeEach(() => {
  installed = [notes, maps]
  runningFlags = new Set([notes.packageName, maps.packageName])
  savedRunningState.length = 0
  launches.length = 0
  stopListening = fleetEvents.subscribe({launch: (event) => launches.push(event)})
  ensureRunning = spyOn(miniappLauncher, "ensureRunning").mockResolvedValue({uiUri: null, uiBaseDir: null})
  isRunning = spyOn(miniappLauncher, "isRunning").mockReturnValue(false)
  warn = spyOn(console, "warn").mockImplementation(() => {})
})

afterEach(() => {
  stopListening()
  ensureRunning.mockRestore()
  isRunning.mockRestore()
  warn.mockRestore()
})

describe("autostartLocalMiniapps and Fleet", () => {
  test("each miniapp restarted after a kill is reported as an automatic start", async () => {
    await miniappLauncher.autostartLocalMiniapps()
    expect(ensureRunning).toHaveBeenCalledTimes(2)
    expect(launches).toEqual([
      {
        packageName: "com.mentra.notes",
        miniappName: "Notes",
        versionName: "1.0.30",
        start: "automatic",
        outcome: "started",
      },
      {
        packageName: "com.mentra.maps",
        miniappName: "Maps",
        versionName: "2.1.0",
        start: "automatic",
        outcome: "started",
      },
    ])
  })

  test("a miniapp that fails to restart is reported as failed, and its stale running flag is still cleared", async () => {
    ensureRunning.mockRejectedValueOnce(new Error("bundle missing"))
    await miniappLauncher.autostartLocalMiniapps()
    expect(launches.map((launch) => [launch.packageName, launch.outcome])).toEqual([
      ["com.mentra.notes", "failed"],
      ["com.mentra.maps", "started"],
    ])
    expect(savedRunningState).toEqual([["com.mentra.notes", false]])
  })

  test("miniapps that were not running, that run already, or that have no context are not reported", async () => {
    installed = [
      {...notes},
      {packageName: "com.mentra.stopped", name: "Stopped", local: true},
      {packageName: "com.mentra.native", name: "Native", local: false},
    ]
    runningFlags = new Set([notes.packageName, "com.mentra.native"])
    isRunning.mockImplementation((packageName: string) => packageName === notes.packageName)
    await miniappLauncher.autostartLocalMiniapps()
    expect(ensureRunning).not.toHaveBeenCalled()
    expect(launches).toEqual([])
  })

  test("a reporter that fails never stops the restarts", async () => {
    stopListening()
    stopListening = fleetEvents.subscribe({
      launch: () => {
        throw new Error("fleet is broken")
      },
    })
    await miniappLauncher.autostartLocalMiniapps()
    expect(ensureRunning).toHaveBeenCalledTimes(2)
  })

  test("with no reporter listening, autostart behaves as before", async () => {
    stopListening()
    ensureRunning.mockRejectedValueOnce(new Error("bundle missing"))
    await miniappLauncher.autostartLocalMiniapps()
    expect(ensureRunning).toHaveBeenCalledTimes(2)
    expect(savedRunningState).toEqual([["com.mentra.notes", false]])
  })
})

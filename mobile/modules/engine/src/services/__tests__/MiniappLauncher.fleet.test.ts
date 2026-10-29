/// <reference types="bun-types" />

/**
 * Every path that starts a local miniapp through the launcher, and the one Fleet launch each makes: the real
 * `ensureRunning` over a router that spawns nothing.
 */
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, spyOn, test} from "bun:test"

import "./reactNativeTestMock"

import {
  configure,
  isInstalledMiniappAllowed,
  isLocalMiniappPackageAllowed,
  resetForTests,
} from "../../runtime/bootstrap"
import type {ClientApp} from "../../types/applet"
import {installWithRuntimeReload} from "../../utils/storeInstallRuntime"
import {fleetEvents, type FleetLaunchEvent} from "../fleet/fleetEvents"
import type {MentraJSRouter} from "../MentraJSRouter"

let installed: Array<Partial<ClientApp>> = []
let runningFlags = new Set<string>()
const savedRunningState: Array<[string, boolean]> = []
/** Packages whose bundle cannot be resolved. */
let missingBundles = new Set<string>()
/** Packages the deployment does not make available. */
let unavailable = new Set<string>()

const MANIFESTS: Record<string, {name: string; version: string}> = {
  "com.mentra.notes": {name: "Notes", version: "1.0.30"},
  "com.mentra.maps": {name: "Maps", version: "2.1.0"},
}

mock.module("../AppRegistry", () => ({
  default: {
    getInstalledMiniapps: async () => installed,
    isMiniappAccessRevoked: () => false,
    getActiveVersion: async (packageName: string) => MANIFESTS[packageName]?.version ?? "1.0.0",
    getPublisherKeyFingerprint: () => null,
    getSelectedDevSnapshot: () => null,
    getMiniappEntryPaths: (packageName: string, version: string) =>
      missingBundles.has(packageName)
        ? null
        : {
            background: `file:///bundle/${packageName}/${version}/bg.js`,
            ui: null,
            rootDir: `file:///bundle/${packageName}/${version}/`,
            uiPath: null,
          },
    getMiniappManifest: (packageName: string) => ({packageName, ...MANIFESTS[packageName], permissions: []}),
    getReleaseIdentity: () => ({source: "bundled_asset"}),
    isPackageAllowed: (packageName: string) => isLocalMiniappPackageAllowed(packageName),
    isReleaseAllowed: (packageName: string, version: string | undefined) =>
      isInstalledMiniappAllowed(packageName, version, {source: "bundled_asset"}),
    getLatestDevSnapshotVersion: () => null,
    hasDevSnapshot: () => false,
  },
  getLocalAppRunningState: (packageName: string) => runningFlags.has(packageName),
  saveLocalAppRunningState: (packageName: string, running: boolean) => savedRunningState.push([packageName, running]),
}))
mock.module("../DevServerBridge", () => ({default: {connect: () => {}}}))
mock.module("../LocalMiniappRuntime", () => ({default: {waitForConnect: async () => {}}}))
mock.module("../../utils/storage/storage", () => ({
  storage: {load: () => ({is_ok: () => false}), save: () => ({is_ok: () => true})},
}))
mock.module("expo-file-system", () => ({
  File: class {
    textSync() {
      return "BG SOURCE"
    }
  },
}))
mock.module("../../stores/settings", () => ({
  SETTINGS: {super_mode: {key: "super_mode"}},
  useSettingsStore: {getState: () => ({getSetting: () => false})},
}))

let miniappLauncher: typeof import("../MiniappLauncher").miniappLauncher

/** A router that spawns nothing: it registers, projects and unregisters, and can be told to fail a spawn. */
function fakeRouter() {
  const registered = new Set<string>()
  const projected = new Set<string>()
  const failingSpawns = new Set<string>()
  const router = {
    registeredPackages: () => [...registered],
    spawnAndRegister: async (packageName: string, _src: string, options?: {projectRunning?: boolean}) => {
      await Promise.resolve()
      if (failingSpawns.has(packageName)) return false
      registered.add(packageName)
      if (options?.projectRunning ?? true) projected.add(packageName)
      return true
    },
    projectRunning: (packageName: string) => {
      if (registered.has(packageName)) projected.add(packageName)
    },
    isProjectedRunning: (packageName: string) => projected.has(packageName),
    unregister: async (packageName: string) => {
      registered.delete(packageName)
      projected.delete(packageName)
    },
  }
  return {router: router as unknown as MentraJSRouter, failingSpawns}
}

const NOTES = "com.mentra.notes"
const MAPS = "com.mentra.maps"
const notes = {packageName: NOTES, name: "Notes", version: "1.0.30", local: true}
const maps = {packageName: MAPS, name: "Maps", version: "2.1.0", local: true}

const launches: FleetLaunchEvent[] = []
let stopListening: () => void = () => {}
let router: ReturnType<typeof fakeRouter>
let warn: ReturnType<typeof spyOn>

function launchesOf(packageName: string) {
  return launches.filter((launch) => launch.packageName === packageName)
}

beforeAll(async () => {
  configure({auth: {}, config: {isMiniappAvailable: (packageName) => !unavailable.has(packageName)}})
  miniappLauncher = (await import("../MiniappLauncher")).miniappLauncher
})

afterAll(resetForTests)

beforeEach(() => {
  installed = [notes, maps]
  runningFlags = new Set([NOTES, MAPS])
  savedRunningState.length = 0
  missingBundles = new Set()
  unavailable = new Set()
  launches.length = 0
  fleetEvents.discardUndeliveredLaunches()
  stopListening = fleetEvents.subscribe({launch: (event) => launches.push(event)})
  router = fakeRouter()
  miniappLauncher.configure({router: router.router})
  warn = spyOn(console, "warn").mockImplementation(() => {})
})

afterEach(() => {
  stopListening()
  warn.mockRestore()
})

describe("a restore after a process death", () => {
  test("is one automatic launch for each miniapp restored, named as installed", async () => {
    await miniappLauncher.autostartLocalMiniapps()
    expect(launches).toEqual([
      {packageName: NOTES, miniappName: "Notes", versionName: "1.0.30", start: "automatic", outcome: "started"},
      {packageName: MAPS, miniappName: "Maps", versionName: "2.1.0", start: "automatic", outcome: "started"},
    ])
  })

  test("that fails is one failed launch, and its stale running flag is still cleared", async () => {
    missingBundles.add(NOTES)
    await miniappLauncher.autostartLocalMiniapps()
    expect(launches.map((launch) => [launch.packageName, launch.start, launch.outcome])).toEqual([
      [NOTES, "automatic", "failed"],
      [MAPS, "automatic", "started"],
    ])
    expect(savedRunningState).toEqual([[NOTES, false]])
  })

  test("of a miniapp the deployment no longer makes available is refused, not a launch", async () => {
    unavailable.add(NOTES)
    await miniappLauncher.autostartLocalMiniapps()
    expect(launchesOf(NOTES)).toEqual([])
    expect(savedRunningState).toEqual([[NOTES, false]])
  })

  test("skips miniapps that were not running, that already run, or that have no context", async () => {
    installed = [notes, {packageName: "com.mentra.stopped", local: true}, {packageName: "com.mentra.native"}]
    runningFlags = new Set([NOTES, "com.mentra.native"])
    await miniappLauncher.ensureRunning(NOTES)
    launches.length = 0
    await miniappLauncher.autostartLocalMiniapps()
    expect(launches).toEqual([])
  })

  test("made before anything listens is kept, with when it happened, for the collector", async () => {
    stopListening()
    await miniappLauncher.autostartLocalMiniapps()
    expect(fleetEvents.takeUndeliveredLaunches().map(({event}) => [event.packageName, event.start])).toEqual([
      [NOTES, "automatic"],
      [MAPS, "automatic"],
    ])
  })

  test("goes on whatever the reporter does", async () => {
    stopListening()
    stopListening = fleetEvents.subscribe({
      launch: () => {
        throw new Error("fleet is broken")
      },
    })
    await miniappLauncher.autostartLocalMiniapps()
    expect(miniappLauncher.isProjectedRunning(NOTES)).toBe(true)
    expect(miniappLauncher.isProjectedRunning(MAPS)).toBe(true)
  })
})

describe("starts outside the apps store", () => {
  test("a miniapp another miniapp starts, or an action wakes for good, is one automatic launch", async () => {
    // LocalMiniappRuntime.startInteropApp: session.miniapps.start / open, and a persistent action's target.
    await miniappLauncher.ensureConnected(NOTES)
    expect(launches).toEqual([
      {packageName: NOTES, miniappName: "Notes", versionName: "1.0.30", start: "automatic", outcome: "started"},
    ])
  })

  test("a miniapp screen opened directly, which spawns its context, is one user launch", async () => {
    // The Compositor's LocalMiniappView, for a deep link, a dev load or a return to a miniapp that had stopped.
    await miniappLauncher.ensureRunning(NOTES, {}, {trigger: "user"})
    expect(launches.map((launch) => [launch.packageName, launch.start, launch.outcome])).toEqual([
      [NOTES, "user", "started"],
    ])
  })

  test("a context that fails to spawn is one failed launch", async () => {
    router.failingSpawns.add(NOTES)
    await expect(miniappLauncher.ensureConnected(NOTES)).rejects.toThrow()
    expect(launches.map((launch) => [launch.packageName, launch.outcome])).toEqual([[NOTES, "failed"]])
  })

  test("a reinstall that restarts a running miniapp is one automatic launch for the restart", async () => {
    await miniappLauncher.ensureRunning(NOTES, {}, {trigger: "user"})
    launches.length = 0
    await installWithRuntimeReload(miniappLauncher, NOTES, async () => {})
    expect(launches.map((launch) => [launch.packageName, launch.start, launch.outcome])).toEqual([
      [NOTES, "automatic", "started"],
    ])
  })

  test("a miniapp that already runs is no launch, however it is asked for", async () => {
    await miniappLauncher.ensureRunning(NOTES)
    launches.length = 0
    await miniappLauncher.ensureRunning(NOTES, {}, {trigger: "user"})
    await miniappLauncher.ensureConnected(NOTES)
    expect(launches).toEqual([])
  })

  test("two paths starting one miniapp at once are one launch", async () => {
    await Promise.all([
      miniappLauncher.ensureRunning(NOTES, {}, {trigger: "user"}),
      miniappLauncher.ensureConnected(NOTES),
      miniappLauncher.ensureRunning(NOTES),
    ])
    expect(launchesOf(NOTES)).toHaveLength(1)
  })

  test("a hidden action wake is no launch, and the miniapp becoming user activity later is one", async () => {
    await miniappLauncher.ensureConnected(NOTES, 10_000, undefined, {projectRunning: false})
    expect(launches).toEqual([])
    await miniappLauncher.ensureConnected(NOTES)
    expect(launches.map((launch) => [launch.packageName, launch.start, launch.outcome])).toEqual([
      [NOTES, "automatic", "started"],
    ])
  })

  test("a start joined to a hidden wake that fails is one failed launch", async () => {
    router.failingSpawns.add(NOTES)
    const settled = await Promise.allSettled([
      miniappLauncher.ensureConnected(NOTES, 10_000, undefined, {projectRunning: false}),
      miniappLauncher.ensureRunning(NOTES, {}, {trigger: "user"}),
    ])
    expect(settled.map((result) => result.status)).toEqual(["rejected", "rejected"])
    expect(launches.map((launch) => [launch.packageName, launch.start, launch.outcome])).toEqual([
      [NOTES, "user", "failed"],
    ])
  })
})

describe("a start through the apps store", () => {
  test("reports its own launch: the spawn it causes here, and the Compositor's call meanwhile, are not more", async () => {
    const release = fleetEvents.claimLaunch(NOTES)
    await Promise.all([
      miniappLauncher.ensureRunning(NOTES),
      miniappLauncher.ensureRunning(NOTES, {}, {trigger: "user"}),
    ])
    release()
    expect(launches).toEqual([])
    expect(miniappLauncher.isProjectedRunning(NOTES)).toBe(true)
  })

  test("that fails reports its own failure too", async () => {
    router.failingSpawns.add(NOTES)
    const release = fleetEvents.claimLaunch(NOTES)
    await expect(miniappLauncher.ensureRunning(NOTES)).rejects.toThrow()
    // The start reports the failure itself, with the reason the launcher classified.
    expect(release()).toBe("spawn_failed")
    expect(launches).toEqual([])
  })
})

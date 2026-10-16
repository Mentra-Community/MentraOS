/// <reference types="bun-types" />

/** A dev server's background hot reload respawns a running miniapp from its new bundle: one automatic launch. */
import {afterEach, beforeAll, beforeEach, describe, expect, mock, spyOn, test} from "bun:test"

import {fleetEvents, type FleetLaunchEvent} from "../fleet/fleetEvents"

let respawn: ((packageName: string) => Promise<void>) | null = null
let spawnSucceeds = true

class FakeRouter {
  readonly projected = new Set<string>()
  crashController: unknown
  uiRouter: unknown
  timer: unknown
  registeredPackages(): string[] {
    return [...this.projected]
  }
  isProjectedRunning(packageName: string): boolean {
    return this.projected.has(packageName)
  }
  async unregister(packageName: string): Promise<void> {
    this.projected.delete(packageName)
  }
  async spawnAndRegister(packageName: string, _src: string, options?: {projectRunning?: boolean}): Promise<boolean> {
    if (spawnSucceeds && (options?.projectRunning ?? true)) this.projected.add(packageName)
    return spawnSucceeds
  }
  start(): void {}
  stop(): void {}
}

mock.module("@mentra/crust", () => ({default: {}}))
mock.module("../DevServerBridge", () => ({
  default: {
    onRespawnBackground: (handler: (packageName: string) => Promise<void>) => {
      respawn = handler
    },
    clearRespawnBackgroundHandler: () => {},
  },
}))
mock.module("../LocalMiniappRuntime", () => ({default: {}}))
mock.module("../MiniappLauncher", () => ({
  miniappLauncher: {
    configure: () => {},
    resolveBundle: async (packageName: string) => ({
      bgSource: "BG",
      uiUri: null,
      uiBaseDir: null,
      declaredPermissions: [],
      installedManifest: {packageName, name: "Notes", version: "1.0.31-dev"},
      hostTrustedSystem: false,
      devUrl: "http://192.0.2.1:8081",
      devPort: 8081,
    }),
  },
}))
mock.module("../MentraJSCrashController", () => ({MentraJSCrashController: class {}}))
mock.module("../MentraUIRouter", () => ({
  MentraUIRouter: class {
    notifyReopen(): void {}
  },
}))
mock.module("../MentraJSRouter", () => ({MentraJSRouter: FakeRouter}))
mock.module("../../utils/timers", () => ({BgTimer: {}}))

let router: FakeRouter
const launches: FleetLaunchEvent[] = []
let stopListening: () => void = () => {}
let warn: ReturnType<typeof spyOn>

beforeAll(async () => {
  const {ensureMiniappEngine} = await import("../MiniappEngine")
  router = ensureMiniappEngine().router as unknown as FakeRouter
})

beforeEach(() => {
  spawnSucceeds = true
  router.projected.clear()
  launches.length = 0
  fleetEvents.discardUndeliveredLaunches()
  stopListening = fleetEvents.subscribe({launch: (event) => launches.push(event)})
  warn = spyOn(console, "warn").mockImplementation(() => {})
})

afterEach(() => {
  stopListening()
  warn.mockRestore()
})

describe("a dev server's background hot reload", () => {
  test("of a running miniapp is one automatic launch, of the new bundle", async () => {
    router.projected.add("com.mentra.notes")
    await respawn?.("com.mentra.notes")
    expect(launches).toEqual([
      {
        packageName: "com.mentra.notes",
        miniappName: "Notes",
        versionName: "1.0.31-dev",
        start: "automatic",
        outcome: "started",
      },
    ])
  })

  test("that fails to spawn is one failed launch", async () => {
    router.projected.add("com.mentra.notes")
    spawnSucceeds = false
    await respawn?.("com.mentra.notes")
    expect(launches.map((launch) => [launch.packageName, launch.outcome])).toEqual([["com.mentra.notes", "failed"]])
  })

  test("of a context a hidden action wake keeps out of the running tray is no launch", async () => {
    await respawn?.("com.mentra.notes")
    expect(launches).toEqual([])
  })
})

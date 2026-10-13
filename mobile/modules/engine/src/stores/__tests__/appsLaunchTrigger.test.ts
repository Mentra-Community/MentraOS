import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, spyOn, test} from "bun:test"
import {result as Res} from "typesafe-ts"

import {configure, resetForTests} from "../../runtime/bootstrap"
import {fleetEvents, type FleetLaunchEvent} from "../../services/fleet/fleetEvents"
import type {ClientApp} from "../../types/applet"

const compatible = {isCompatible: true, missingRequired: [], missingOptional: [], warnings: []}
const installedApps = mock(async (): Promise<ClientApp[]> => [])
const ensureRunning = mock(async (): Promise<unknown> => ({}))
mock.module("../../services/AppRegistry", () => ({
  default: {
    getInstalledMiniapps: installedApps,
    uninstall: mock(async () => Res.ok(undefined)),
    requiresLocalSttModel: () => false,
    subscribe: () => () => {},
  },
}))
mock.module("../../services/MiniappLauncher", () => ({miniappLauncher: {ensureRunning}}))
mock.module("../../services/MiniappRunningRegistry", () => ({
  miniappRunningRegistry: {subscribe: () => () => {}, getAll: () => []},
}))
mock.module("../../services/LocalDisplayManager", () => ({default: {onCoreAppChange: () => {}}}))
mock.module("../../services/NotificationsEmitter", () => ({islandNotifications: {emit: () => {}}}))
mock.module("../../services/STTModelManager", () => ({default: {isModelAvailable: async () => true}}))
mock.module("../../services/SystemMiniappPolicy", () => ({isStoreMiniappPackage: () => false}))
mock.module("../../utils/hardware/hardware", () => ({HardwareCompatibility: {checkCompatibility: () => compatible}}))
mock.module("../../types/hardware", () => ({getModelCapabilities: () => ({})}))
mock.module("../../utils/storage/storage", () => ({
  storage: {load: () => ({is_ok: () => false}), save: () => ({is_ok: () => true})},
}))
mock.module("@mentra/bluetooth-sdk", () => ({default: {clearDisplay: () => {}}}))
mock.module("../settings", () => ({
  SETTINGS: {default_wearable: {key: "wearable"}, has_ever_activated_app: {key: "activated"}},
  useSettingsStore: {getState: () => ({getSetting: () => null, setSetting: () => {}}), subscribe: () => () => {}},
}))

let apps: typeof import("../apps").useAppStatusStore
let installHooks: typeof import("../apps").installAppStoreHooks
let useStart: typeof import("../apps").useStart

const target: ClientApp = {
  packageName: "com.test.notes",
  name: "Notes",
  version: "1.0.30",
  webviewUrl: "",
  logoUrl: "",
  type: "background",
  permissions: [],
  running: false,
  healthy: true,
  hardwareRequirements: [],
  offline: false,
  offlineRoute: "",
  loading: false,
  local: true,
  hidden: false,
  compatibility: compatible,
}

const launches: FleetLaunchEvent[] = []
let stopListening: () => void = () => {}
let quiet: Array<{mockRestore: () => void}> = []

beforeAll(async () => {
  const module = await import("../apps")
  apps = module.useAppStatusStore
  installHooks = module.installAppStoreHooks
  useStart = module.useStart
})

afterAll(resetForTests)

beforeEach(() => {
  resetForTests()
  configure({auth: {}})
  launches.length = 0
  stopListening = fleetEvents.subscribe({launch: (event) => launches.push(event)})
  ensureRunning.mockReset()
  ensureRunning.mockResolvedValue({})
  installedApps.mockReset()
  installedApps.mockResolvedValue([target])
  apps.setState({apps: [target], updatingPackages: new Set(), foregroundedPackage: null})
  installHooks({onUpdateBlocked: () => {}, onOpenRequested: () => {}, onIncompatibleBlocked: () => {}})
  // start() reports its refusals on the console; these tests are about what Fleet is told.
  quiet = [spyOn(console, "warn").mockImplementation(() => {}), spyOn(console, "error").mockImplementation(() => {})]
})

afterEach(() => {
  stopListening()
  for (const spy of quiet) spy.mockRestore()
})

describe("launch reports", () => {
  test("a start asked for by a person is reported as a user start", async () => {
    expect(await apps.getState().start(target, {trigger: "user"})).toBe(true)
    expect(launches).toEqual([
      {packageName: "com.test.notes", miniappName: "Notes", versionName: "1.0.30", start: "user", outcome: "started"},
    ])
  })

  test("a start nobody said anything about is automatic, with or without other options", async () => {
    await apps.getState().start(target)
    apps.setState({apps: [{...target, running: false}]})
    await apps.getState().start(target, {skipNavigation: true})
    expect(launches.map((launch) => launch.start)).toEqual(["automatic", "automatic"])
  })

  test("an automatic start can be named", async () => {
    await apps.getState().start(target, {trigger: "automatic"})
    expect(launches[0].start).toBe("automatic")
  })

  test("a start that was refused is reported as failed", async () => {
    apps.setState({updatingPackages: new Set([target.packageName])})
    expect(await apps.getState().start(target, {trigger: "user"})).toBe(false)
    expect(launches).toEqual([
      {packageName: "com.test.notes", miniappName: "Notes", versionName: "1.0.30", start: "user", outcome: "failed"},
    ])
  })

  test("a miniapp that cannot work with these glasses is reported as failed", async () => {
    const incompatible = {...target, compatibility: {...compatible, isCompatible: false}}
    apps.setState({apps: [incompatible]})
    expect(await apps.getState().start(incompatible, {trigger: "user"})).toBe(false)
    expect(launches.map((launch) => launch.outcome)).toEqual(["failed"])
  })

  test("a context that fails to spawn is reported as failed, and the failure behaves as before", async () => {
    ensureRunning.mockRejectedValueOnce(new Error("spawn failed"))
    expect(await apps.getState().start(target, {trigger: "user"})).toBe(false)
    expect(launches.map((launch) => launch.outcome)).toEqual(["failed"])
    expect(apps.getState().apps[0].running).toBe(false)
  })

  test("a start that throws is reported as failed, and still throws", async () => {
    await expect(
      apps.getState().start(target, {
        trigger: "user",
        onAccepted: () => {
          throw new Error("host navigation failed")
        },
      }),
    ).rejects.toThrow("host navigation failed")
    expect(launches.map((launch) => launch.outcome)).toEqual(["failed"])
  })

  test("opening a miniapp that is already running is not a launch", async () => {
    apps.setState({apps: [{...target, running: true}]})
    expect(await apps.getState().start(target, {trigger: "user"})).toBe(true)
    expect(launches).toEqual([])
    expect(ensureRunning).not.toHaveBeenCalled()
  })

  test("a package the store does not know is still a failed attempt", async () => {
    const stranger = {...target, packageName: "com.test.unknown", name: "Unknown"}
    expect(await apps.getState().start(stranger, {trigger: "user"})).toBe(false)
    expect(launches).toEqual([
      {
        packageName: "com.test.unknown",
        miniappName: "Unknown",
        versionName: "1.0.30",
        start: "user",
        outcome: "failed",
      },
    ])
  })

  test("a reporter that fails never changes the result of a start", async () => {
    stopListening()
    stopListening = fleetEvents.subscribe({
      launch: () => {
        throw new Error("fleet is broken")
      },
    })
    expect(await apps.getState().start(target, {trigger: "user"})).toBe(true)
    apps.setState({updatingPackages: new Set([target.packageName]), apps: [{...target, running: false}]})
    expect(await apps.getState().start(target, {trigger: "user"})).toBe(false)
  })

  test("with no reporter listening, a start is unchanged", async () => {
    stopListening()
    expect(await apps.getState().start(target)).toBe(true)
    expect(ensureRunning).toHaveBeenCalledTimes(1)
  })
})

describe("useStart", () => {
  test("starts on the user's behalf", async () => {
    const start = useStart()
    expect(await start(target)).toBe(true)
    expect(launches.map((launch) => launch.start)).toEqual(["user"])
  })

  test("keeps the options it is given, and a trigger a caller names", async () => {
    const accepted = mock(() => {})
    await useStart()(target, {onAccepted: accepted, trigger: "automatic"})
    expect(accepted).toHaveBeenCalledTimes(1)
    expect(launches.map((launch) => launch.start)).toEqual(["automatic"])
  })

  test("is one stable function", () => {
    expect(useStart()).toBe(useStart())
  })

  test("resolves to the same answer as the store's start", async () => {
    apps.setState({updatingPackages: new Set([target.packageName])})
    expect(await useStart()(target)).toBe(false)
    expect(launches.map((launch) => launch.outcome)).toEqual(["failed"])
  })
})

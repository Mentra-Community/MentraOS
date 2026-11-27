import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, spyOn, test} from "bun:test"
import {result as Res} from "typesafe-ts"

// The store reads the app state to tell which miniapp is visible.
import "../../services/__tests__/reactNativeTestMock"
import {configure, resetForTests} from "../../runtime/bootstrap"
import {fleetEvents, type FleetLaunchEvent} from "../../services/fleet/fleetEvents"
import type {ClientApp} from "../../types/applet"

const compatible = {isCompatible: true, missingRequired: [], missingOptional: [], warnings: []}
const installedApps = mock(async (): Promise<ClientApp[]> => [])
const ensureRunning = mock(async (..._args: unknown[]): Promise<unknown> => ({}))
/** The launcher's wait for a miniapp's update check before it starts: true to go on, false when it was cancelled. */
const waitForUpdate = mock(async (_packageName: string): Promise<boolean> => true)
const cancelStart = mock((_packageName: string): void => {})
const saveSetting = mock((_key: string, _value: unknown): {is_ok: () => boolean} => ({is_ok: () => true}))
let modelAvailable = true
mock.module("../../services/AppRegistry", () => ({
  buildHardwareRequirements: () => [],
  default: {
    getInstalledMiniapps: installedApps,
    uninstall: mock(async () => Res.ok(undefined)),
    requiresLocalSttModel: (packageName: string) => packageName === "com.test.speech",
    isMiniappAccessRevoked: (packageName: string) => packageName === "com.test.revoked",
    subscribe: () => () => {},
  },
}))
mock.module("../../services/MiniappLauncher", () => ({miniappLauncher: {ensureRunning, waitForUpdate, cancelStart}}))
mock.module("../../services/MiniappRunningRegistry", () => ({
  miniappRunningRegistry: {subscribe: () => () => {}, getAll: () => []},
}))
mock.module("../../services/LocalDisplayManager", () => ({default: {onCoreAppChange: () => {}}}))
mock.module("../../services/NotificationsEmitter", () => ({islandNotifications: {emit: () => {}}}))
mock.module("../../services/STTModelManager", () => ({default: {isModelAvailable: async () => modelAvailable}}))
mock.module("../../utils/hardware/hardware", () => ({HardwareCompatibility: {checkCompatibility: () => compatible}}))
mock.module("../../types/hardware", () => ({getModelCapabilities: () => ({})}))
mock.module("../../utils/storage/storage", () => ({
  storage: {load: () => ({is_ok: () => false}), save: saveSetting},
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
  fleetEvents.discardUndeliveredLaunches()
  stopListening = fleetEvents.subscribe({launch: (event) => launches.push(event)})
  ensureRunning.mockReset()
  ensureRunning.mockResolvedValue({})
  waitForUpdate.mockReset()
  waitForUpdate.mockResolvedValue(true)
  cancelStart.mockReset()
  saveSetting.mockReset()
  saveSetting.mockImplementation(() => ({is_ok: () => true}))
  modelAvailable = true
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

describe("what a start shows", () => {
  const incompatible = {...target, compatibility: {...compatible, isCompatible: false}}
  const speech = {...target, packageName: "com.test.speech", name: "Speech"}
  let shown: string[] = []
  beforeEach(() => {
    shown = []
    installHooks({
      onUpdateBlocked: (app) => shown.push(`updating:${app.packageName}`),
      onIncompatibleBlocked: (app) => shown.push(`incompatible:${app.packageName}`),
      onMissingSpeechModel: (app) => shown.push(`speech:${app.packageName}`),
      onAccessRevoked: (app) => shown.push(`revoked:${app.packageName}`),
    })
  })

  test("a person's start explains why it was refused", async () => {
    apps.setState({apps: [incompatible]})
    expect(await apps.getState().start(incompatible, {trigger: "user"})).toBe(false)
    apps.setState({apps: [speech]})
    modelAvailable = false
    expect(await apps.getState().start(speech, {trigger: "user"})).toBe(false)
    apps.setState({apps: [target], updatingPackages: new Set([target.packageName])})
    expect(await apps.getState().start(target, {trigger: "user"})).toBe(false)
    expect(shown).toEqual(["incompatible:com.test.notes", "speech:com.test.speech", "updating:com.test.notes"])
  })

  test("an automatic start is refused silently", async () => {
    apps.setState({apps: [incompatible]})
    expect(await apps.getState().start(incompatible)).toBe(false)
    apps.setState({apps: [speech]})
    modelAvailable = false
    expect(await apps.getState().start(speech, {trigger: "automatic"})).toBe(false)
    apps.setState({apps: [target], updatingPackages: new Set([target.packageName])})
    expect(await apps.getState().start(target, {skipNavigation: true})).toBe(false)
    const revoked = {...target, packageName: "com.test.revoked", name: "Revoked"}
    apps.setState({apps: [revoked], updatingPackages: new Set()})
    expect(await apps.getState().start(revoked)).toBe(false)
    expect(shown).toEqual([])
    expect(ensureRunning).not.toHaveBeenCalled()
  })
})

describe("a start waits for the miniapp's update check", () => {
  const other: ClientApp = {...target, packageName: "com.test.other", name: "Other", type: "standard", running: true}
  const standard: ClientApp = {...target, type: "standard"}

  function held() {
    let release!: (goesOn: boolean) => void
    const wait = new Promise<boolean>((resolve) => {
      release = resolve
    })
    waitForUpdate.mockImplementationOnce(() => wait)
    return release
  }

  test("behind the splash, and before anything else changes", async () => {
    apps.setState({apps: [standard, other]})
    const release = held()
    const shown: string[] = []
    installHooks({onOpenRequested: (app) => shown.push(app.packageName)})
    const starting = apps.getState().start(standard, {trigger: "user", onAccepted: () => void shown.push("accepted")})
    await new Promise((resolve) => setTimeout(resolve, 10))
    // The host has put the splash up, and the wait is on.
    expect(shown).toEqual(["accepted", standard.packageName])
    expect(waitForUpdate).toHaveBeenCalledWith(standard.packageName)
    // Nothing has started, the other standard miniapp still runs, and Fleet has heard of no launch.
    expect(ensureRunning).not.toHaveBeenCalled()
    expect(apps.getState().apps.map((app) => app.running)).toEqual([false, true])
    expect(launches).toEqual([])
    release(true)
    expect(await starting).toBe(true)
    // Its context starts without waiting a second time.
    expect(ensureRunning).toHaveBeenCalledWith(standard.packageName, undefined, {checkForUpdate: false})
    expect(apps.getState().apps.map((app) => app.running)).toEqual([true, false])
  })

  test("and starts the version the wait installed, which is the one Fleet is told", async () => {
    waitForUpdate.mockImplementationOnce(async () => {
      apps.setState({apps: [{...target, version: "1.0.31"}]})
      return true
    })
    expect(await apps.getState().start(target, {trigger: "user"})).toBe(true)
    expect(launches).toEqual([
      {packageName: "com.test.notes", miniappName: "Notes", versionName: "1.0.31", start: "user", outcome: "started"},
    ])
  })

  test("whoever starts it: a person or the platform", async () => {
    expect(await apps.getState().start(target)).toBe(true)
    apps.setState({apps: [target]})
    expect(await apps.getState().start(target, {skipNavigation: true, trigger: "automatic"})).toBe(true)
    expect(waitForUpdate).toHaveBeenCalledTimes(2)
  })

  test("except a restart around an install, a re-open of a running miniapp, a refused start and the app's own screens", async () => {
    expect(await apps.getState().start(target, {trigger: "automatic", checkForUpdate: false})).toBe(true)
    apps.setState({apps: [{...target, running: true}]})
    expect(await apps.getState().start(target, {trigger: "user"})).toBe(true)
    const incompatible = {...target, compatibility: {...compatible, isCompatible: false}}
    apps.setState({apps: [incompatible]})
    expect(await apps.getState().start(incompatible, {trigger: "user"})).toBe(false)
    const builtIn = {...target, packageName: "com.test.settings", name: "Settings", local: false, offline: true}
    apps.setState({apps: [builtIn]})
    expect(await apps.getState().start(builtIn, {trigger: "user"})).toBe(true)
    expect(waitForUpdate).not.toHaveBeenCalled()
  })

  test("stopped while it waits, it starts nothing, changes nothing and is no launch", async () => {
    apps.setState({apps: [standard, other]})
    const release = held()
    const starting = apps.getState().start(standard, {trigger: "user"})
    await new Promise((resolve) => setTimeout(resolve, 10))
    await apps.getState().stop(standard.packageName)
    // The stop cancels the launcher's wait, for every start that shares it.
    expect(cancelStart).toHaveBeenCalledWith(standard.packageName)
    release(false)
    expect(await starting).toBe(false)
    expect(ensureRunning).not.toHaveBeenCalled()
    expect(apps.getState().apps.map((app) => app.running)).toEqual([false, true])
    expect(launches).toEqual([])
  })

  test("a stop the wait didn't hear of still keeps it from starting", async () => {
    const release = held()
    const starting = apps.getState().start(target, {trigger: "user"})
    await new Promise((resolve) => setTimeout(resolve, 10))
    await apps.getState().stop(target.packageName)
    release(true)
    expect(await starting).toBe(false)
    expect(ensureRunning).not.toHaveBeenCalled()
    expect(launches).toEqual([])
  })

  test("an install that began, or a removal, while it waited refuses the start", async () => {
    let shown: string[] = []
    installHooks({onUpdateBlocked: (app) => shown.push(app.packageName)})
    waitForUpdate.mockImplementationOnce(async () => {
      apps.setState({updatingPackages: new Set([target.packageName])})
      return true
    })
    expect(await apps.getState().start(target, {trigger: "user"})).toBe(false)
    expect(shown).toEqual([target.packageName])
    apps.setState({updatingPackages: new Set()})
    waitForUpdate.mockImplementationOnce(async () => {
      apps.setState({apps: []})
      return true
    })
    expect(await apps.getState().start(target, {trigger: "user"})).toBe(false)
    expect(ensureRunning).not.toHaveBeenCalled()
    expect(launches).toEqual([])
  })
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

  test("a start refused while the miniapp is updating is not a launch", async () => {
    apps.setState({updatingPackages: new Set([target.packageName])})
    expect(await apps.getState().start(target, {trigger: "user"})).toBe(false)
    expect(launches).toEqual([])
  })

  test("a miniapp that cannot work with these glasses is not a launch", async () => {
    const incompatible = {...target, compatibility: {...compatible, isCompatible: false}}
    apps.setState({apps: [incompatible]})
    expect(await apps.getState().start(incompatible, {trigger: "user"})).toBe(false)
    expect(launches).toEqual([])
  })

  test("a second tap while another miniapp is loading is not a launch", async () => {
    const other = {...target, packageName: "com.test.other", name: "Other", loading: true}
    apps.setState({apps: [target, other]})
    expect(await apps.getState().start(target, {trigger: "user"})).toBe(false)
    expect(launches).toEqual([])
    expect(ensureRunning).not.toHaveBeenCalled()
  })

  test("a miniapp waiting for its speech model is not a launch", async () => {
    const speech = {...target, packageName: "com.test.speech", name: "Speech"}
    apps.setState({apps: [speech]})
    modelAvailable = false
    expect(await apps.getState().start(speech, {trigger: "user"})).toBe(false)
    expect(launches).toEqual([])
  })

  test("a miniapp whose access was revoked is not a launch", async () => {
    const revokedApp = {...target, packageName: "com.test.revoked", name: "Revoked"}
    apps.setState({apps: [revokedApp]})
    expect(await apps.getState().start(revokedApp, {trigger: "user"})).toBe(false)
    expect(launches).toEqual([])
    expect(ensureRunning).not.toHaveBeenCalled()
  })

  test("a package the store does not know, or one the host made unavailable, is not a launch", async () => {
    const stranger = {...target, packageName: "com.test.unknown", name: "Unknown"}
    expect(await apps.getState().start(stranger, {trigger: "user"})).toBe(false)
    configure({auth: {}, config: {isMiniappAvailable: () => false}})
    expect(await apps.getState().start(target, {trigger: "user"})).toBe(false)
    expect(launches).toEqual([])
  })

  test("a context that fails to spawn is reported as failed, and the failure behaves as before", async () => {
    ensureRunning.mockRejectedValueOnce(new Error("spawn failed"))
    expect(await apps.getState().start(target, {trigger: "user"})).toBe(false)
    expect(launches).toEqual([
      {packageName: "com.test.notes", miniappName: "Notes", versionName: "1.0.30", start: "user", outcome: "failed"},
    ])
    expect(apps.getState().apps[0].running).toBe(false)
  })

  test("a failed start carries the reason the launcher classified for the spawn it held back", async () => {
    ensureRunning.mockImplementationOnce(async () => {
      fleetEvents.launchUnlessClaimed({packageName: "com.test.notes", start: "user", outcome: "failed", failureReason: "spawn_failed"})
      throw new Error("spawn failed")
    })
    expect(await apps.getState().start(target, {trigger: "user"})).toBe(false)
    expect(launches).toEqual([
      {
        packageName: "com.test.notes",
        miniappName: "Notes",
        versionName: "1.0.30",
        start: "user",
        outcome: "failed",
        failureReason: "spawn_failed",
      },
    ])
  })

  test("a start that throws once it began is reported as failed, and still throws", async () => {
    saveSetting.mockImplementation(() => {
      throw new Error("storage failed")
    })
    await expect(apps.getState().start(target, {trigger: "user"})).rejects.toThrow("storage failed")
    expect(launches.map((launch) => launch.outcome)).toEqual(["failed"])
  })

  test("a start that throws before it began records nothing, and still throws", async () => {
    await expect(
      apps.getState().start(target, {
        trigger: "user",
        onAccepted: () => {
          throw new Error("host navigation failed")
        },
      }),
    ).rejects.toThrow("host navigation failed")
    expect(launches).toEqual([])
  })

  test("opening a miniapp that is already running is not a launch", async () => {
    apps.setState({apps: [{...target, running: true}]})
    expect(await apps.getState().start(target, {trigger: "user"})).toBe(true)
    expect(launches).toEqual([])
    expect(ensureRunning).not.toHaveBeenCalled()
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

  test("is the only launch: the spawn it causes, which the launcher reports for other paths, is not a second", async () => {
    // What the launcher does for a spawn: report it, unless a start of the miniapp is under way.
    ensureRunning.mockImplementation(async () => {
      fleetEvents.launchUnlessClaimed({packageName: target.packageName, start: "automatic", outcome: "started"})
      return {}
    })
    expect(await apps.getState().start(target, {trigger: "user"})).toBe(true)
    expect(launches.map((launch) => [launch.packageName, launch.start])).toEqual([["com.test.notes", "user"]])
    // Once the start is done, another path's launch is reported again.
    fleetEvents.launchUnlessClaimed({packageName: target.packageName, start: "automatic", outcome: "started"})
    expect(launches).toHaveLength(2)
  })

  test("a start refused at a gate claims nothing: another path's launch meanwhile is still reported", async () => {
    modelAvailable = false
    const speech = {...target, packageName: "com.test.speech", name: "Speech"}
    apps.setState({apps: [speech]})
    expect(await apps.getState().start(speech, {trigger: "user"})).toBe(false)
    fleetEvents.launchUnlessClaimed({packageName: "com.test.speech", start: "automatic", outcome: "started"})
    expect(launches.map((launch) => launch.start)).toEqual(["automatic"])
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
    expect(launches).toEqual([])
    ensureRunning.mockRejectedValueOnce(new Error("spawn failed"))
    apps.setState({updatingPackages: new Set()})
    expect(await useStart()(target)).toBe(false)
    expect(launches.map((launch) => launch.outcome)).toEqual(["failed"])
  })
})

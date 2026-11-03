import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, spyOn, test} from "bun:test"
import {result as Res} from "typesafe-ts"

import type {DeclaredAge} from "@mentra/cloud-protocol/declared-age"

import {reactNativeAppState} from "../../services/__tests__/reactNativeTestMock"
import {configure, resetForTests} from "../../runtime/bootstrap"
import {setMiniappAgeGateDependenciesForTests} from "../../services/miniappAgeGate"
import type {ClientApp} from "../../types/applet"

const compatible = {isCompatible: true, missingRequired: [], missingOptional: [], warnings: []}
const ensureRunning = mock(async (_packageName: string): Promise<unknown> => ({}))
const stopped: string[] = []
/** The launcher's spawns and stops, in order. */
const launcherCalls: string[] = []
/** Each package's installed rating; absent declares none. */
const ratings = new Map<string, string>()
mock.module("../../services/AppRegistry", () => ({
  default: {
    getInstalledMiniapps: async () => [],
    uninstall: mock(async () => Res.ok(undefined)),
    requiresLocalSttModel: () => false,
    isMiniappAccessRevoked: () => false,
    subscribe: () => () => {},
  },
}))
mock.module("../../services/MiniappLauncher", () => ({
  miniappLauncher: {
    ensureRunning: (packageName: string) => {
      launcherCalls.push(`spawn ${packageName}`)
      return ensureRunning(packageName)
    },
    stop: async (packageName: string) => {
      launcherCalls.push(`stop ${packageName}`)
      stopped.push(packageName)
    },
    installedAgeRating: (packageName: string) => ({
      packageName,
      name: packageName,
      ageRating: ratings.get(packageName) ?? null,
    }),
  },
}))
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

function miniapp(packageName: string, overrides: Partial<ClientApp> = {}): ClientApp {
  return {
    packageName,
    name: packageName,
    version: "1.0.0",
    webviewUrl: "",
    logoUrl: "",
    type: "standard",
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
    ...overrides,
  }
}

const club = miniapp("com.test.club")
const bar = miniapp("com.test.bar")
const notes = miniapp("com.test.notes", {running: true})
/** What the person's account holds, or a Core that can't be reached. */
let declared: DeclaredAge | "offline"
let asks: number
let answer: number | null
let opened: string[]
let quiet: Array<{mockRestore: () => void}> = []

const running = () =>
  apps
    .getState()
    .apps.filter((app) => app.running)
    .map((app) => app.packageName)
    .sort()

beforeAll(async () => {
  const module = await import("../apps")
  apps = module.useAppStatusStore
  installHooks = module.installAppStoreHooks
})

afterAll(() => {
  setMiniappAgeGateDependenciesForTests(null)
  resetForTests()
})

beforeEach(() => {
  resetForTests()
  configure({auth: {}, config: {hostAgeRating: "12+"}})
  ratings.clear()
  ratings.set("com.test.club", "18+")
  declared = {declaredAge: 30, declaredAgeAt: new Date().toISOString()}
  asks = 0
  answer = null
  setMiniappAgeGateDependenciesForTests({
    hostAgeRating: () => "12+",
    account: async () => "mu_alice",
    cached: () => null,
    cache: () => {},
    fetch: async () => {
      if (declared === "offline") throw new Error("offline")
      return declared
    },
    store: async (_account, age) => ({declaredAge: age, declaredAgeAt: new Date().toISOString()}),
    asker: () => async () => {
      asks += 1
      return answer
    },
    now: () => new Date(),
    warn: () => {},
  })
  stopped.length = 0
  launcherCalls.length = 0
  opened = []
  ensureRunning.mockReset()
  ensureRunning.mockResolvedValue({})
  reactNativeAppState.currentState = "active"
  apps.setState({apps: [club, bar, notes], updatingPackages: new Set(), foregroundedPackage: null})
  installHooks({onUpdateBlocked: () => {}, onOpenRequested: (app) => opened.push(app.packageName)})
  quiet = [spyOn(console, "warn").mockImplementation(() => {}), spyOn(console, "error").mockImplementation(() => {})]
})

afterEach(() => {
  for (const spy of quiet) spy.mockRestore()
})

describe("starting an age-rated miniapp", () => {
  const refusals: Array<[string, () => void]> = [
    ["too young", () => (declared = {declaredAge: 15, declaredAgeAt: new Date().toISOString()})],
    ["the age question closed", () => (declared = {declaredAge: null, declaredAgeAt: null})],
    ["Core out of reach", () => (declared = "offline")],
  ]

  test.each(refusals)("%s: opens nothing and stops nothing", async (_label, setUp) => {
    setUp()
    expect(await apps.getState().start(club, {trigger: "user"})).toBe(false)
    expect(opened).toEqual([])
    expect(stopped).toEqual([])
    expect(ensureRunning).not.toHaveBeenCalled()
    expect(running()).toEqual(["com.test.notes"])
  })

  test("old enough, the screen opens, the other standard miniapp stops, and the launch goes on", async () => {
    expect(await apps.getState().start(club, {trigger: "user"})).toBe(true)
    expect(opened).toEqual(["com.test.club"])
    expect(stopped).toEqual(["com.test.notes"])
    expect(ensureRunning).toHaveBeenCalledTimes(1)
    expect(running()).toEqual(["com.test.club"])
  })

  test("the first time, the person is asked in front of the app, then it opens", async () => {
    declared = {declaredAge: null, declaredAgeAt: null}
    answer = 20
    expect(await apps.getState().start(club, {trigger: "user"})).toBe(true)
    expect(asks).toBe(1)
  })

  test("with the Mentra App in the background, nobody is asked and it doesn't open", async () => {
    declared = {declaredAge: null, declaredAgeAt: null}
    answer = 20
    reactNativeAppState.currentState = "background"
    expect(await apps.getState().start(club)).toBe(false)
    expect(asks).toBe(0)
  })

  test("two starts that waited on the gate together still leave one standard miniapp running", async () => {
    ratings.set("com.test.bar", "16+")
    const [first, second] = await Promise.all([
      apps.getState().start(club, {trigger: "user"}),
      apps.getState().start(bar, {trigger: "user"}),
    ])
    expect(second).toBe(true)
    expect(running()).toEqual(["com.test.bar"])
    expect(stopped).toEqual(["com.test.notes", "com.test.club"])
    // The first one in was stopped by the second: nothing starts it again afterwards. (The launcher's stop waits for a
    // spawn already under way, then ends it.)
    const clubCalls = launcherCalls.filter((call) => call.endsWith("com.test.club"))
    expect(clubCalls.at(-1)).toBe("stop com.test.club")
    expect(first).toBe(clubCalls.includes("spawn com.test.club"))
  })

  test("an unrated miniapp doesn't wait on the gate", async () => {
    declared = "offline"
    expect(await apps.getState().start(bar, {trigger: "user"})).toBe(true)
    expect(running()).toEqual(["com.test.bar"])
  })

  test("re-opening a running miniapp isn't checked again", async () => {
    ratings.set("com.test.notes", "18+")
    declared = "offline"
    expect(await apps.getState().start(notes, {trigger: "user"})).toBe(true)
  })

  test("a host with no rating of its own doesn't check", async () => {
    resetForTests()
    configure({auth: {}})
    declared = "offline"
    expect(await apps.getState().start(club, {trigger: "user"})).toBe(true)
  })
})

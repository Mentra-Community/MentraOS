/// <reference types="bun-types" />

/**
 * Store updates through the real release installer, apps store, launcher,
 * prompt and deferral modules. Only the registry's native I/O, the router's
 * JavaScript contexts and host UI are replaced.
 */
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test} from "bun:test"
import {result as Res} from "typesafe-ts"

import "./reactNativeTestMock"
import {
  configure,
  isInstalledMiniappAllowed,
  isLocalMiniappPackageAllowed,
  resetForTests,
} from "../../runtime/bootstrap"
import type {ClientApp} from "../../types/applet"
import {MiniappRunningError} from "../../utils/storeInstallRuntime"
import type {InstallBundleOptions} from "../AppRegistry"
import type {MentraJSRouter} from "../MentraJSRouter"
import type {ManifestFetchResult} from "../miniappUrlUpdates"
import type {PendingRunningUpdatePrompt} from "../runningUpdatePrompt"

const pkg = "com.acme.notes"
const calls: string[] = []
let active = "1.0.0"
let verifyFailure: string | undefined
let downloadFailure: string | undefined
let activationFailure: string | undefined
let downloadGate: Promise<void> | undefined
let notInstalled = false
const stored = new Map<string, unknown>()
// Like the real registry, the running flag projects the running-app registry.
let isProjected: (packageName: string) => boolean = () => false
// Whether the glasses this miniapp needs are connected.
let compatible = true

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return {promise, resolve}
}

mock.module("../../utils/storage/storage", () => ({
  storage: {
    load: (key: string) =>
      stored.has(key) ? {is_ok: () => true, is_error: () => false, value: stored.get(key)} : {is_ok: () => false},
    save: (key: string, value: unknown) => {
      stored.set(key, value)
      return {is_ok: () => true}
    },
  },
}))

const registry = {
  isMiniappAccessRevoked: () => false,
  getInstalledMiniapps: async (): Promise<ClientApp[]> => [
    {
      packageName: pkg,
      name: "Notes",
      version: active,
      webviewUrl: "",
      logoUrl: "",
      type: "standard",
      permissions: [],
      running: isProjected(pkg),
      healthy: true,
      hardwareRequirements: [],
      offline: false,
      offlineRoute: "",
      loading: false,
      local: true,
      hidden: false,
    },
  ],
  getActiveVersion: async () => active,
  getInstalledVersions: () => (notInstalled ? [] : [active]),
  getReleaseIdentity: () => ({source: "bundled_asset"}),
  isPackageAllowed: (packageName: string) => isLocalMiniappPackageAllowed(packageName),
  isReleaseAllowed: (packageName: string, version: string | undefined) =>
    isInstalledMiniappAllowed(packageName, version, {source: "bundled_asset"}),
  getPublisherKeyFingerprint: () => null,
  getSelectedDevSnapshot: () => null,
  getLatestDevSnapshotVersion: () => null,
  getMiniappEntryPaths: (_packageName: string, version: string) => ({
    background: `file:///lmas/${pkg}/${version}/bg.js`,
    ui: `file:///lmas/${pkg}/${version}/ui.html`,
  }),
  getMiniappManifest: () => ({permissions: [], hardwareRequirements: []}),
  requiresLocalSttModel: () => false,
  subscribe: () => () => {},
  /** The shared installer's observable order: download, verify, unpack, (wait), activate. */
  installFromUrl: (_url: string, options: InstallBundleOptions) => stagedInstall("download", options),
  /** A workspace release its sync already downloaded and verified: read, then the same steps. */
  installFromLocalZip: (zipPath: string, options: InstallBundleOptions) => {
    localZips.push(zipPath)
    return stagedInstall("read", options)
  },
}
const localZips: string[] = []
const installReasons: (string | undefined)[] = []

async function stagedInstall(first: "download" | "read", options: InstallBundleOptions) {
  calls.push(first)
  options.onProgress?.("downloading")
  if (downloadGate) await downloadGate
  if (downloadFailure) return Res.error(new Error(downloadFailure))
  calls.push("verify")
  if (verifyFailure) return Res.error(new Error(verifyFailure))
  try {
    calls.push("unpack")
    await options.whenStaged?.({hardwareRequirements: []})
    options.beforeActivate?.()
    calls.push("activate")
    if (activationFailure) throw new Error(activationFailure)
    active = options.expectedVersion!
    notInstalled = false
    installReasons.push(options.installReason)
    return Res.ok(undefined)
  } catch (error) {
    return Res.error(error as Error)
  }
}
mock.module("../AppRegistry", () => ({
  default: registry,
  buildHardwareRequirements: (raw: unknown) => raw ?? [],
  getLocalAppRunningState: () => false,
  saveLocalAppRunningState: () => {},
}))
mock.module("../DevServerBridge", () => ({default: {connect: () => {}, disconnect: () => {}}}))
mock.module("../LocalMiniappRuntime", () => ({default: {waitForConnect: async () => {}}}))
mock.module("../LocalDisplayManager", () => ({default: {onCoreAppChange: () => {}}}))
mock.module("../NotificationsEmitter", () => ({islandNotifications: {emit: () => {}}}))
mock.module("../STTModelManager", () => ({default: {isModelAvailable: async () => true}}))
mock.module("../../utils/hardware/hardware", () => ({
  HardwareCompatibility: {
    checkCompatibility: () =>
      compatible
        ? {isCompatible: true, missingRequired: [], missingOptional: [], warnings: []}
        : {isCompatible: false, missingRequired: [{type: "EXIST"}], missingOptional: [], warnings: []},
  },
}))
mock.module("../../types/hardware", () => ({getModelCapabilities: () => ({})}))
// The URL updater's own check that this phone runs a release: every release here does.
mock.module("../miniappInstallCompatibility", () => ({checkMiniappRunsOnPhone: () => ({compatible: true})}))
mock.module("@mentra/bluetooth-sdk", () => ({default: {clearDisplay: () => {}}}))
mock.module("../../stores/settings", () => ({
  SETTINGS: {
    default_wearable: {key: "wearable"},
    has_ever_activated_app: {key: "activated"},
    super_mode: {key: "super_mode"},
  },
  useSettingsStore: {getState: () => ({getSetting: () => null, setSetting: () => {}}), subscribe: () => () => {}},
}))
mock.module("expo-file-system", () => ({
  File: class {
    constructor(readonly uri: string) {}
    textSync() {
      return this.uri
    }
  },
}))

const {classifyManagedInstallError, installMiniappRelease, MiniappInstallCancelledError} = await import(
  "../miniappReleaseInstall"
)
const {miniappLauncher} = await import("../MiniappLauncher")
const {miniappRunningRegistry} = await import("../MiniappRunningRegistry")
isProjected = (packageName) => miniappRunningRegistry.has(packageName)
const {useAppStatusStore, installAppStoreHooks} = await import("../../stores/apps")
const {BASE_BACKOFF_MS, MiniappUrlUpdater, OPEN_CHECK_INTERVAL_MS} = await import("../miniappUrlUpdates")
const prompt = await import("../runningUpdatePrompt")
const deferredUpdates = await import("../deferredMiniappUpdates")

// JavaScript contexts: spawning records the bundle version that runs.
const registered = new Set<string>()
const router = {
  registeredPackages: () => [...registered],
  spawnAndRegister: async (packageName: string, source: string, options?: {projectRunning?: boolean}) => {
    calls.push(`start:${packageName}@${/\/(\d+\.\d+\.\d+)\//.exec(source)?.[1]}`)
    registered.add(packageName)
    if (options?.projectRunning ?? true) miniappRunningRegistry.add(packageName)
    return true
  },
  projectRunning: (packageName: string) => miniappRunningRegistry.add(packageName),
  isProjectedRunning: (packageName: string) => miniappRunningRegistry.has(packageName),
  unregister: async (packageName: string) => {
    calls.push(`stop:${packageName}`)
    registered.delete(packageName)
    miniappRunningRegistry.remove(packageName)
  },
} as unknown as MentraJSRouter

let foreground = true
let answer: "update" | "not_now" | "hold" = "update"
const prompts: PendingRunningUpdatePrompt[] = []
const failures: unknown[] = []
const blocked: string[] = []
const incompatible: string[] = []

function release(options: Partial<Parameters<typeof installMiniappRelease>[1]> = {}) {
  return installMiniappRelease("https://store.example/notes-1.1.0.zip", {
    expectedPackageName: pkg,
    expectedVersion: "1.1.0",
    onlyIfStopped: true,
    askIfRunning: true,
    ...options,
  })
}

async function runApp({open}: {open: boolean}) {
  const app = useAppStatusStore.getState().apps.find((candidate) => candidate.packageName === pkg)!
  expect(await useAppStatusStore.getState().start(app, {skipNavigation: true})).toBe(true)
  if (open) await useAppStatusStore.getState().setForeground(pkg)
  calls.length = 0
}

beforeAll(() => {
  configure({auth: {}})
  miniappLauncher.configure({router})
  installAppStoreHooks({
    onUpdateBlocked: (app) => blocked.push(app.packageName),
    onIncompatibleBlocked: (app) => incompatible.push(app.packageName),
  })
})
afterAll(() => {
  prompt.setRunningUpdatePromptEnvironmentForTests(null)
  deferredUpdates.resetDeferredMiniappUpdatesForTests()
  resetForTests()
})

beforeEach(async () => {
  for (const packageName of [...registered]) await router.unregister(packageName)
  calls.length = 0
  localZips.length = 0
  active = "1.0.0"
  verifyFailure = undefined
  downloadFailure = undefined
  activationFailure = undefined
  downloadGate = undefined
  notInstalled = false
  installReasons.length = 0
  foreground = true
  answer = "update"
  prompts.length = 0
  failures.length = 0
  blocked.length = 0
  incompatible.length = 0
  compatible = true
  stored.clear()
  deferredUpdates.resetDeferredMiniappUpdatesForTests()
  prompt.setRunningUpdatePromptEnvironmentForTests({
    isForeground: () => foreground,
    isDeclined: (packageName) => stored.get(`declined:${packageName}`) === true,
    setDeclined: (packageName, value) =>
      void (value ? stored.set(`declined:${packageName}`, true) : stored.delete(`declined:${packageName}`)),
  })
  prompt.onRunningUpdatePrompt((pending) => {
    prompts.push(pending)
    calls.push("prompt")
    if (answer !== "hold") pending.answer(answer)
  })
  prompt.onRunningUpdateFailed((failure) => failures.push(failure))
  useAppStatusStore.setState({apps: [], updatingPackages: new Set(), foregroundedPackage: null})
  await useAppStatusStore.getState().refresh()
})

describe("automatic update of an idle miniapp", () => {
  test("installs without asking and without a Store screen", async () => {
    await release()
    expect(calls).toEqual(["download", "verify", "unpack", "activate"])
    expect(active).toBe("1.1.0")
    expect(prompts).toHaveLength(0)
    expect(useAppStatusStore.getState().apps[0]).toMatchObject({version: "1.1.0", updating: false})
  })

  test("is silent: the miniapp never shows an updating state", async () => {
    const states: boolean[] = []
    const unsubscribe = useAppStatusStore.subscribe((state) => states.push(Boolean(state.apps[0]?.updating)))
    await release()
    unsubscribe()
    expect(active).toBe("1.1.0")
    expect(states).not.toContain(true)
  })

  test("an open while it downloads opens at once, and the update waits for the miniapp to stop", async () => {
    const download = deferred()
    downloadGate = download.promise
    const update = release()
    await Promise.resolve()
    const app = useAppStatusStore.getState().apps[0]
    expect(app.updating).toBe(false)
    expect(await useAppStatusStore.getState().start(app, {trigger: "user"})).toBe(true)
    await useAppStatusStore.getState().setForeground(pkg)
    expect(blocked).toEqual([])
    expect(useAppStatusStore.getState().foregroundedPackage).toBe(pkg)
    download.resolve()
    await expect(update).rejects.toBeInstanceOf(MiniappRunningError)
    expect(active).toBe("1.0.0")
    expect(calls).toEqual(["download", `start:${pkg}@1.0.0`, "verify", "unpack"])
  })

  test("a network failure releases the reservation so the installed version stays usable", async () => {
    downloadFailure = "bundle download timed out after 45000ms"
    await expect(release()).rejects.toThrow("timed out")
    expect(useAppStatusStore.getState().apps[0].updating).toBe(false)
    expect(await useAppStatusStore.getState().start(useAppStatusStore.getState().apps[0])).toBe(true)
    expect(calls).toEqual(["download", `start:${pkg}@1.0.0`])
  })

  test("a hidden launch while it downloads wins, and the update waits", async () => {
    const download = deferred()
    downloadGate = download.promise
    const update = release({askIfRunning: false})
    await Promise.resolve()
    await miniappLauncher.ensureRunning(pkg, undefined, {projectRunning: false})
    download.resolve()
    await expect(update).rejects.toBeInstanceOf(MiniappRunningError)
    expect(active).toBe("1.0.0")
    expect(calls).not.toContain("activate")
    expect(useAppStatusStore.getState().apps[0].updating).toBe(false)
  })
})

describe("update prompt for a running miniapp", () => {
  test("Update stages the release first, then closes, installs and reopens the miniapp", async () => {
    await runApp({open: true})
    await release()
    expect(calls).toEqual(["download", "verify", "unpack", "prompt", `stop:${pkg}`, "activate", `start:${pkg}@1.1.0`])
    expect(prompts.map(({packageName, displayName, version}) => ({packageName, displayName, version}))).toEqual([
      {packageName: pkg, displayName: "Notes", version: "1.1.0"},
    ])
    expect(useAppStatusStore.getState().foregroundedPackage).toBe(pkg)
    expect(useAppStatusStore.getState().apps[0]).toMatchObject({version: "1.1.0", running: true, updating: false})
  })

  test("shows the updating state from Update until the miniapp is back", async () => {
    await runApp({open: false})
    const states: boolean[] = []
    const unsubscribe = useAppStatusStore.subscribe((state) => states.push(Boolean(state.apps[0]?.updating)))
    await release()
    unsubscribe()
    expect(states).toContain(true)
    expect(states.at(-1)).toBe(false)
  })

  test("its restart is silent, and skipped when the glasses it needs went away after Update", async () => {
    await runApp({open: true})
    const unsubscribe = prompt.onRunningUpdatePrompt(() => {
      compatible = false
    })
    await release()
    unsubscribe()
    expect(calls).toEqual(["download", "verify", "unpack", "prompt", `stop:${pkg}`, "activate"])
    expect(active).toBe("1.1.0")
    expect(incompatible).toEqual([])
    expect(blocked).toEqual([])
    expect(miniappRunningRegistry.has(pkg)).toBe(false)
    expect(useAppStatusStore.getState().foregroundedPackage).toBeNull()
  })

  test("its restart doesn't wait for another update check, as an open does", async () => {
    const checked: string[] = []
    miniappLauncher.setUpdateCheck(async (packageName) => {
      checked.push(packageName)
    })
    try {
      await runApp({open: false})
      expect(checked).toEqual([pkg])
      await release()
      expect(miniappRunningRegistry.has(pkg)).toBe(true)
      expect(calls.at(-1)).toBe(`start:${pkg}@1.1.0`)
      expect(checked).toEqual([pkg])
    } finally {
      miniappLauncher.setUpdateCheck(null)
    }
  })

  test("a miniapp running without its screen open starts again without opening", async () => {
    await runApp({open: false})
    await release()
    expect(calls.slice(-3)).toEqual([`stop:${pkg}`, "activate", `start:${pkg}@1.1.0`])
    expect(useAppStatusStore.getState().foregroundedPackage).toBeNull()
    expect(miniappRunningRegistry.has(pkg)).toBe(true)
  })

  test("Not now keeps the session, answers APP_RUNNING, and installs when the miniapp stops", async () => {
    answer = "not_now"
    await runApp({open: true})
    const ready: string[] = []
    deferredUpdates.onDeferredMiniappUpdateReady((packageName) => ready.push(packageName))
    await expect(release()).rejects.toBeInstanceOf(MiniappRunningError)
    expect(calls).toEqual(["download", "verify", "unpack", "prompt"])
    expect(active).toBe("1.0.0")
    expect(miniappRunningRegistry.has(pkg)).toBe(true)
    expect(useAppStatusStore.getState().foregroundedPackage).toBe(pkg)

    await useAppStatusStore.getState().stop(pkg)
    expect(ready).toEqual([pkg])
    calls.length = 0
    await release()
    expect(calls).toEqual(["download", "verify", "unpack", "activate"])
    expect(active).toBe("1.1.0")
    // The put-off update installed: the next one asks without waiting for an open.
    expect(prompt.canShowRunningUpdatePrompt(pkg)).toBe(true)
  })

  test("after Not now asks again only once the person opens the miniapp, without downloading before", async () => {
    answer = "not_now"
    await runApp({open: false})
    const ready: string[] = []
    deferredUpdates.onDeferredMiniappUpdateReady((packageName) => ready.push(packageName))
    const due: string[] = []
    prompt.onRunningUpdatePromptDue((packageName) => due.push(packageName))
    await expect(release()).rejects.toBeInstanceOf(MiniappRunningError)
    calls.length = 0
    await expect(release()).rejects.toBeInstanceOf(MiniappRunningError)
    expect(calls).toEqual([])
    expect(prompts).toHaveLength(1)

    await useAppStatusStore.getState().setForeground(pkg)
    expect(due).toEqual([pkg])
    expect(ready).toEqual([])
    answer = "update"
    await release()
    expect(prompts).toHaveLength(2)
    expect(active).toBe("1.1.0")
  })

  test("is not shown while the Mentra App is in the background", async () => {
    foreground = false
    await runApp({open: true})
    await expect(release()).rejects.toBeInstanceOf(MiniappRunningError)
    expect(calls).toEqual([])
    expect(prompts).toHaveLength(0)
    expect(miniappRunningRegistry.has(pkg)).toBe(true)
  })

  test("a failed install after Update starts the existing version again and reports it", async () => {
    activationFailure = "ACTIVATE_VERSION_FAILED"
    await runApp({open: true})
    await expect(release()).rejects.toThrow("ACTIVATE_VERSION_FAILED")
    expect(calls).toEqual(["download", "verify", "unpack", "prompt", `stop:${pkg}`, "activate", `start:${pkg}@1.0.0`])
    expect(failures).toEqual([{packageName: pkg, displayName: "Notes", installedVersion: "1.0.0"}])
    expect(useAppStatusStore.getState().foregroundedPackage).toBe(pkg)
    expect(useAppStatusStore.getState().apps[0].updating).toBe(false)
  })

  test.each([
    ["another signer", "Publisher signature mismatch for installed miniapp com.acme.notes"],
    ["an unsigned bundle over a signed install", "Unsigned bundle cannot replace signed miniapp com.acme.notes"],
  ])("the signer rule refuses %s before any prompt", async (_case, failure) => {
    verifyFailure = failure
    await runApp({open: true})
    await expect(release()).rejects.toThrow(failure)
    expect(calls).toEqual(["download", "verify"])
    expect(prompts).toHaveLength(0)
    expect(failures).toHaveLength(0)
    expect(miniappRunningRegistry.has(pkg)).toBe(true)
  })

  test("a lower version is staged and asked about like any other update: versions are not compared", async () => {
    active = "2.0.0"
    await runApp({open: true})
    await release()
    expect(calls).toEqual(["download", "verify", "unpack", "prompt", `stop:${pkg}`, "activate", `start:${pkg}@1.1.0`])
    expect(prompts.map(({version}) => version)).toEqual(["1.1.0"])
    expect(useAppStatusStore.getState().apps[0]).toMatchObject({version: "1.1.0", running: true})
  })

  test("other bytes under the running version are asked about too, and the miniapp restarts on them", async () => {
    active = "1.1.0"
    await runApp({open: true})
    await release()
    expect(calls).toEqual(["download", "verify", "unpack", "prompt", `stop:${pkg}`, "activate", `start:${pkg}@1.1.0`])
    expect(useAppStatusStore.getState().foregroundedPackage).toBe(pkg)
    expect(useAppStatusStore.getState().apps[0]).toMatchObject({version: "1.1.0", running: true, updating: false})
  })

  test("a running miniapp whose staged release the paired glasses can't launch defers without asking", async () => {
    await runApp({open: true})
    compatible = false
    await expect(release()).rejects.toBeInstanceOf(MiniappRunningError)
    expect(prompts).toHaveLength(0)
    expect(calls).toEqual(["download", "verify", "unpack"])
    expect(active).toBe("1.0.0")
  })

  test("without askIfRunning, a running miniapp defers quietly", async () => {
    await runApp({open: true})
    await expect(release({askIfRunning: false})).rejects.toBeInstanceOf(MiniappRunningError)
    expect(calls).toEqual([])
    expect(prompts).toHaveLength(0)
  })

  test("a miniapp the user closed while the release staged installs without asking", async () => {
    await runApp({open: false})
    const download = deferred()
    downloadGate = download.promise
    const update = release()
    await Promise.resolve()
    await useAppStatusStore.getState().stop(pkg)
    download.resolve()
    await update
    expect(prompts).toHaveLength(0)
    expect(active).toBe("1.1.0")
    expect(calls.filter((call) => call.startsWith("start:"))).toEqual([])
  })
})

describe("opening a miniapp waits for its update check", () => {
  const url = "https://notes.acme.com/"
  const limits = {checkMs: 2000, installMs: 2000}
  let clock = 1_000_000
  let fetches = 0
  let fetchManifest: () => Promise<ManifestFetchResult> = async () => serves("1.0.0")
  /** Whether the paired glasses can launch the build the URL serves. */
  let servedBuildLaunches: () => boolean = () => compatible
  // The real updater over the real installer: only its requests and the registry's native I/O are replaced.
  let updater: InstanceType<typeof MiniappUrlUpdater>
  let waits: Array<string | null> = []
  let stopWatching: () => void = () => {}

  function serves(version: string): ManifestFetchResult {
    return {
      status: 200,
      url: `${url}miniapp.json`,
      body: JSON.stringify({
        packageName: pkg,
        version,
        name: "Notes",
        sdkVersion: "0.3.0",
        minHostVersion: "3.0.0",
        hardwareRequirements: [],
        bundle: {url: `notes-${version}.zip`, sha256: "b".repeat(64)},
      }),
    }
  }

  function tick(ms = 20) {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  const app = () => useAppStatusStore.getState().apps[0]

  beforeEach(() => {
    clock = 1_000_000
    fetches = 0
    limits.checkMs = 2000
    limits.installMs = 2000
    fetchManifest = async () => serves("1.0.0")
    servedBuildLaunches = () => compatible
    updater = new MiniappUrlUpdater({
      installedPackages: async () => [pkg],
      activeVersion: async () => active,
      releaseIdentity: () => ({source: "url", sourceUrl: url}),
      isSystemPackage: () => false,
      firstPartyUrl: () => undefined,
      isDevelopmentBuild: () => false,
      developmentAllowed: () => true,
      compatibilityPolicy: () => ({hostVersion: "3.3.0", supportedSdkRange: ">=0.3.0 <4.0.0"}),
      launchesWithPairedGlasses: () => servedBuildLaunches(),
      fetchManifest: () => {
        fetches++
        return fetchManifest()
      },
      fetchBundle: async () => {
        throw new Error("the registry's installer is replaced")
      },
      install: installMiniappRelease,
      installLocal: async () => {
        throw new Error("no local builds here")
      },
      keepVersions: async () => {},
      isRunningError: (error) => error instanceof MiniappRunningError,
      installSession: () => 1,
      requireRegistry: () => false,
      registryCore: () => null,
      registryStatus: async () => null,
      register: async () => {
        throw new Error("no registry")
      },
      statusStore: {get: () => undefined, set: () => {}},
      setReleaseSourceUrl: () => false,
      now: () => clock,
      setTimeout: (callback, ms) => setTimeout(callback, ms),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      log: () => {},
      warn: () => {},
    })
    miniappLauncher.setUpdateCheck((packageName, onInstalling) =>
      updater.checkBeforeStart(packageName, limits, onInstalling),
    )
    waits = []
    stopWatching = miniappLauncher.onStartWaitChanged(() => waits.push(miniappLauncher.startWait(pkg)))
  })

  afterEach(() => {
    stopWatching()
    miniappLauncher.setUpdateCheck(null)
  })

  test("another build found and installed within the limits starts, with nothing asked", async () => {
    fetchManifest = async () => serves("1.1.0")
    const order: string[] = []
    installAppStoreHooks({onOpenRequested: () => order.push(`splash while ${miniappLauncher.startWait(pkg)}`)})
    expect(await useAppStatusStore.getState().start(app(), {trigger: "user"})).toBe(true)
    installAppStoreHooks({onOpenRequested: undefined})
    expect(calls).toEqual(["download", "verify", "unpack", "activate", `start:${pkg}@1.1.0`])
    expect(prompts).toHaveLength(0)
    expect(blocked).toEqual([])
    // The host showed the miniapp's splash before the wait began; the wait then said what it was for.
    expect(order).toEqual(["splash while null"])
    expect(waits).toEqual(["check", "update", null])
    expect(app()).toMatchObject({version: "1.1.0", running: true, updating: false})
  })

  test("a screen opened directly, with no start through the store, waits the same way", async () => {
    fetchManifest = async () => serves("1.1.0")
    await miniappLauncher.ensureRunning(pkg, {}, {trigger: "user"})
    expect(calls).toEqual(["download", "verify", "unpack", "activate", `start:${pkg}@1.1.0`])
    expect(prompts).toHaveLength(0)
  })

  test("a check that finds the installed build starts it, saying nothing about an update", async () => {
    expect(await useAppStatusStore.getState().start(app(), {trigger: "user"})).toBe(true)
    expect(calls).toEqual([`start:${pkg}@1.0.0`])
    expect(waits).toEqual(["check", null])
    expect(fetches).toBe(1)
  })

  test("past the limit to find another build, the installed one starts and the check carries on: the running miniapp is then asked", async () => {
    limits.checkMs = 30
    const answered = deferred()
    fetchManifest = async () => {
      await answered.promise
      return serves("1.1.0")
    }
    expect(await useAppStatusStore.getState().start(app(), {trigger: "user"})).toBe(true)
    expect(calls).toEqual([`start:${pkg}@1.0.0`])
    expect(waits).toEqual(["check", null])
    // The host answers once the miniapp runs: its update asks, as any running miniapp's does.
    answer = "not_now"
    answered.resolve()
    await updater.check(pkg)
    expect(prompts).toHaveLength(1)
    expect(active).toBe("1.0.0")
    expect(miniappRunningRegistry.has(pkg)).toBe(true)
  })

  test("past the limit to install it, the installed build starts and the update waits for the miniapp to stop", async () => {
    limits.installMs = 30
    const download = deferred()
    downloadGate = download.promise
    fetchManifest = async () => serves("1.1.0")
    const ready: string[] = []
    deferredUpdates.onDeferredMiniappUpdateReady((packageName) => ready.push(packageName))
    expect(await useAppStatusStore.getState().start(app(), {trigger: "user"})).toBe(true)
    expect(calls).toEqual(["download", `start:${pkg}@1.0.0`])
    expect(waits).toEqual(["check", "update", null])
    // The download finishes with the miniapp running: nothing is activated under it, and nothing is asked.
    download.resolve()
    await updater.check(pkg)
    expect(active).toBe("1.0.0")
    expect(prompts).toHaveLength(0)
    await useAppStatusStore.getState().stop(pkg)
    expect(ready).toEqual([pkg])
  })

  test("checked within the last minute, it starts at once without another check", async () => {
    await updater.checkAll()
    expect(fetches).toBe(1)
    fetchManifest = () => new Promise(() => {})
    clock += OPEN_CHECK_INTERVAL_MS - 1
    limits.checkMs = 60_000
    expect(await useAppStatusStore.getState().start(app(), {trigger: "user"})).toBe(true)
    expect(calls).toEqual([`start:${pkg}@1.0.0`])
    expect(fetches).toBe(1)
  })

  test("after a check that failed, it starts at once until the retry time has come", async () => {
    fetchManifest = async () => {
      throw new Error("offline")
    }
    await updater.checkAll()
    expect(fetches).toBe(1)
    fetchManifest = () => new Promise(() => {})
    clock += OPEN_CHECK_INTERVAL_MS
    limits.checkMs = 60_000
    expect(await useAppStatusStore.getState().start(app(), {trigger: "user"})).toBe(true)
    expect(calls).toEqual([`start:${pkg}@1.0.0`])
    expect(fetches).toBe(1)

    // Once the retry time has come, the next start waits for a check again.
    await useAppStatusStore.getState().stop(pkg)
    calls.length = 0
    clock += BASE_BACKOFF_MS
    fetchManifest = async () => serves("1.1.0")
    expect(await useAppStatusStore.getState().start(app(), {trigger: "user"})).toBe(true)
    expect(fetches).toBe(2)
    expect(calls).toEqual(["download", "verify", "unpack", "activate", `start:${pkg}@1.1.0`])
  })

  test("a miniapp that already runs is asked, as before, and its restart waits for nothing", async () => {
    limits.checkMs = 60_000
    limits.installMs = 60_000
    await runApp({open: true})
    fetchManifest = async () => serves("1.1.0")
    await updater.check(pkg)
    expect(calls).toEqual(["download", "verify", "unpack", "prompt", `stop:${pkg}`, "activate", `start:${pkg}@1.1.0`])
    expect(prompts).toHaveLength(1)
    expect(useAppStatusStore.getState().foregroundedPackage).toBe(pkg)
  })

  test("opening the screen of a miniapp that already runs starts nothing and waits for nothing", async () => {
    await runApp({open: false})
    fetchManifest = () => new Promise(() => {})
    clock += OPEN_CHECK_INTERVAL_MS
    waits = []
    expect(await useAppStatusStore.getState().start(app(), {trigger: "user"})).toBe(true)
    await miniappLauncher.ensureRunning(pkg, {}, {trigger: "user"})
    expect(calls).toEqual([])
    expect(waits).toEqual([])
  })

  test("stopped while it waits, it starts nothing: not when the wait would have ended either", async () => {
    limits.checkMs = 60
    fetchManifest = () => new Promise(() => {})
    const fromStore = useAppStatusStore.getState().start(app(), {trigger: "user"})
    const fromScreen = miniappLauncher.ensureRunning(pkg, {}, {trigger: "user"}).catch((error) => error)
    await tick()
    expect(miniappLauncher.startWait(pkg)).toBe("check")
    expect(app().running).toBe(false)
    await useAppStatusStore.getState().stop(pkg)
    expect(await fromStore).toBe(false)
    expect((await fromScreen).name).toBe("MiniappStartCancelledError")
    expect(miniappLauncher.startWait(pkg)).toBeNull()
    await tick(100)
    expect(calls.filter((call) => call.startsWith("start:"))).toEqual([])
    expect(miniappRunningRegistry.has(pkg)).toBe(false)
    expect(app().running).toBe(false)
  })

  test("stopped while its update installs, it starts nothing, and the update still installs", async () => {
    fetchManifest = async () => serves("1.1.0")
    const download = deferred()
    downloadGate = download.promise
    const starting = useAppStatusStore.getState().start(app(), {trigger: "user"})
    await tick()
    expect(miniappLauncher.startWait(pkg)).toBe("update")
    await useAppStatusStore.getState().stop(pkg)
    expect(await starting).toBe(false)
    download.resolve()
    await updater.check(pkg)
    expect(calls.filter((call) => call !== `stop:${pkg}`)).toEqual(["download", "verify", "unpack", "activate"])
    expect(active).toBe("1.1.0")
    expect(miniappRunningRegistry.has(pkg)).toBe(false)
  })

  test("another build the paired glasses can't launch doesn't install as it opens: the installed build starts", async () => {
    fetchManifest = async () => serves("1.1.0")
    // The installed build passes the store's own gate: only the served one needs what the glasses lack.
    servedBuildLaunches = () => false
    expect(await useAppStatusStore.getState().start(app(), {trigger: "user"})).toBe(true)
    expect(fetches).toBe(1)
    expect(calls).toEqual([`start:${pkg}@1.0.0`])
    expect(incompatible).toEqual([])
    expect(prompts).toHaveLength(0)
    expect(active).toBe("1.0.0")
  })
})

describe("a workspace release from a ZIP its sync verified", () => {
  const workspaceRelease = (options: Partial<Parameters<typeof installMiniappRelease>[1]> = {}) =>
    installMiniappRelease(
      {localZipPath: "file:///cache/notes-1.1.0.zip"},
      {expectedPackageName: pkg, expectedVersion: "1.1.0", onlyIfStopped: true, askIfRunning: true, ...options},
    )

  test("installs an idle miniapp from the ZIP without asking", async () => {
    await workspaceRelease()
    expect(localZips).toEqual(["file:///cache/notes-1.1.0.zip"])
    expect(calls).toEqual(["read", "verify", "unpack", "activate"])
    expect(prompts).toHaveLength(0)
  })

  test("asks before updating an open one, then closes, installs and reopens it", async () => {
    await runApp({open: true})
    await workspaceRelease()
    expect(calls).toEqual(["read", "verify", "unpack", "prompt", `stop:${pkg}`, "activate", `start:${pkg}@1.1.0`])
    expect(useAppStatusStore.getState().foregroundedPackage).toBe(pkg)
  })

  test("Not now keeps it running and reports when it stops", async () => {
    answer = "not_now"
    await runApp({open: true})
    const ready: string[] = []
    deferredUpdates.onDeferredMiniappUpdateReady((packageName) => ready.push(packageName))
    await expect(workspaceRelease()).rejects.toBeInstanceOf(MiniappRunningError)
    expect(active).toBe("1.0.0")
    await useAppStatusStore.getState().stop(pkg)
    expect(ready).toEqual([pkg])
  })
})

describe("an update whose session ends (sign-out or a deployment switch)", () => {
  test("an idle update that finishes downloading afterwards never activates", async () => {
    let cancelled = false
    const download = deferred()
    downloadGate = download.promise
    const update = release({isCancelled: () => cancelled})
    await Promise.resolve()
    cancelled = true
    download.resolve()
    await expect(update).rejects.toBeInstanceOf(MiniappInstallCancelledError)
    expect(active).toBe("1.0.0")
    expect(calls).not.toContain("activate")
    expect(useAppStatusStore.getState().apps[0].updating).toBe(false)
  })

  test("an open prompt closes unanswered and the miniapp keeps running", async () => {
    answer = "hold"
    await runApp({open: true})
    const update = release()
    while (!calls.includes("prompt")) await Promise.resolve()
    prompt.dismissRunningUpdatePrompts()
    await expect(update).rejects.toBeInstanceOf(MiniappRunningError)
    // A late tap on the prompt still on screen is ignored.
    prompts[0]!.answer("update")
    expect(calls).toEqual(["download", "verify", "unpack", "prompt"])
    expect(active).toBe("1.0.0")
    expect(miniappRunningRegistry.has(pkg)).toBe(true)
  })

  test("tells its caller when it waits for an answer; dismissing that one prompt defers the update", async () => {
    answer = "hold"
    await runApp({open: true})
    const asked: string[] = []
    const update = release({onAsking: () => asked.push(calls.at(-1)!)})
    while (!calls.includes("prompt")) await Promise.resolve()
    expect(asked).toEqual(["unpack"])
    prompt.dismissRunningUpdatePrompt("com.acme.other")
    prompt.dismissRunningUpdatePrompt(pkg)
    await expect(update).rejects.toBeInstanceOf(MiniappRunningError)
    expect(active).toBe("1.0.0")
  })

  test("after Update it neither activates nor restarts the miniapp, and shows no failure", async () => {
    await runApp({open: true})
    await expect(release({isCancelled: () => calls.includes(`stop:${pkg}`)})).rejects.toBeInstanceOf(
      MiniappInstallCancelledError,
    )
    expect(calls).toEqual(["download", "verify", "unpack", "prompt", `stop:${pkg}`])
    expect(active).toBe("1.0.0")
    expect(failures).toEqual([])
  })
})

describe("a managed first install", () => {
  test("installs a package that is not installed, silently", async () => {
    notInstalled = true
    const states: boolean[] = []
    const unsubscribe = useAppStatusStore.subscribe((state) => states.push(Boolean(state.apps[0]?.updating)))
    await release({firstInstall: true, installReason: "assignment"})
    unsubscribe()
    expect(calls).toEqual(["download", "verify", "unpack", "activate"])
    expect(active).toBe("1.1.0")
    expect(states).not.toContain(true)
    expect(prompts).toHaveLength(0)
    expect(failures).toEqual([])
    expect(installReasons).toEqual(["assignment"])
  })

  test("without firstInstall an automatic update still refuses a package that is not installed", async () => {
    notInstalled = true
    await expect(release()).rejects.toThrow()
    expect(calls).toEqual([])
  })

  test("a context change while it downloads commits nothing", async () => {
    notInstalled = true
    let cancelled = false
    const download = deferred()
    downloadGate = download.promise
    const install = release({firstInstall: true, isCancelled: () => cancelled})
    await Promise.resolve()
    cancelled = true
    download.resolve()
    await expect(install).rejects.toBeInstanceOf(MiniappInstallCancelledError)
    expect(calls).not.toContain("activate")
    expect(notInstalled).toBe(true)
  })

  test("an installed package updates as usual, with the updating state", async () => {
    await runApp({open: true})
    await release({firstInstall: true})
    expect(calls).toEqual(["download", "verify", "unpack", "prompt", `stop:${pkg}`, "activate", `start:${pkg}@1.1.0`])
  })
})

describe("installation reasons", () => {
  test("an explicit install records the user's reason; an automatic update records none", async () => {
    await installMiniappRelease("https://notes.example.com/notes-1.1.0.zip", {
      expectedPackageName: pkg,
      expectedVersion: "1.1.0",
      releaseIdentity: {source: "url", sourceUrl: "https://notes.example.com/"},
    })
    active = "1.1.0"
    await release({expectedVersion: "1.2.0"})
    expect(installReasons).toEqual(["explicit", undefined])
  })
})

describe("classifying a managed install failure", () => {
  test.each([
    ["Requires Mentra App 9.0.0+; this host is 3.0.0.", "incompatible_host", false],
    ["Built for SDK 9.0.0; this Mentra App supports ^1.0.0.", "incompatible_host", false],
    ["Publisher signature mismatch for com.acme.notes", "signature_invalid", false],
    ["Unsigned bundle cannot replace signed miniapp com.acme.notes", "signature_invalid", false],
    ["ENOSPC: no space left on device", "storage_full", true],
    ["bundle package mismatch: expected a, got b", "not_a_miniapp", false],
    ["bundle version mismatch: expected 1.0.0, got 1.0.1", "download_failed", true],
    ["bundle download timed out after 45000ms", "download_failed", true],
    ["bundle contains a symbolic link: ui/data.json", "not_a_miniapp", false],
  ] as const)("%s", (message, kind, retryable) => {
    expect(classifyManagedInstallError(new Error(message))).toEqual({kind, retryable})
  })

  test("a running miniapp waits and a superseded install is cancelled", () => {
    expect(classifyManagedInstallError(new MiniappRunningError(pkg)).kind).toBe("running")
    expect(classifyManagedInstallError(new MiniappInstallCancelledError(pkg)).kind).toBe("cancelled")
  })
})

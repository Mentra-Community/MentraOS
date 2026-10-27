/// <reference types="bun-types" />

/**
 * Store updates through the real release installer, apps store, launcher,
 * prompt and deferral modules. Only the registry's native I/O, the router's
 * JavaScript contexts and host UI are replaced.
 */
import {afterAll, beforeAll, beforeEach, describe, expect, mock, test} from "bun:test"
import {result as Res} from "typesafe-ts"

import "./reactNativeTestMock"
import {configure, resetForTests} from "../../runtime/bootstrap"
import type {ClientApp} from "../../types/applet"
import {MiniappRunningError} from "../../utils/storeInstallRuntime"
import {assertMiniappUpdateVersion} from "../miniappInstallIdentity"
import type {InstallBundleOptions} from "../AppRegistry"
import type {MentraJSRouter} from "../MentraJSRouter"
import type {PendingRunningUpdatePrompt} from "../runningUpdatePrompt"

const pkg = "com.acme.notes"
const calls: string[] = []
let active = "1.0.0"
let verifyFailure: string | undefined
let downloadFailure: string | undefined
let activationFailure: string | undefined
let downloadGate: Promise<void> | undefined
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
  getInstalledVersions: () => [active],
  assertCanInstallVersion: (packageName: string, version: string) =>
    assertMiniappUpdateVersion(packageName, version, [active]),
  getReleaseIdentity: () => ({source: "bundled_asset"}),
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

async function stagedInstall(first: "download" | "read", options: InstallBundleOptions) {
  calls.push(first)
  options.onProgress?.("downloading")
  if (downloadGate) await downloadGate
  if (downloadFailure) return Res.error(new Error(downloadFailure))
  calls.push("verify")
  if (verifyFailure) return Res.error(new Error(verifyFailure))
  try {
    assertMiniappUpdateVersion(pkg, options.expectedVersion!, [active])
    calls.push("unpack")
    await options.whenStaged?.()
    options.beforeActivate?.()
    calls.push("activate")
    if (activationFailure) throw new Error(activationFailure)
    active = options.expectedVersion!
    return Res.ok(undefined)
  } catch (error) {
    return Res.error(error as Error)
  }
}
mock.module("../AppRegistry", () => ({
  default: registry,
  getLocalAppRunningState: () => false,
  saveLocalAppRunningState: () => {},
}))
mock.module("../DevServerBridge", () => ({default: {connect: () => {}}}))
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

const {installMiniappRelease, MiniappInstallCancelledError} = await import("../miniappReleaseInstall")
const {miniappLauncher} = await import("../MiniappLauncher")
const {miniappRunningRegistry} = await import("../MiniappRunningRegistry")
isProjected = (packageName) => miniappRunningRegistry.has(packageName)
const {useAppStatusStore, installAppStoreHooks, onMiniappOpenedByUser} = await import("../../stores/apps")
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
const openedByUser: string[] = []

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
  onMiniappOpenedByUser((packageName) => openedByUser.push(packageName))
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
  foreground = true
  answer = "update"
  prompts.length = 0
  failures.length = 0
  blocked.length = 0
  incompatible.length = 0
  openedByUser.length = 0
  compatible = true
  stored.clear()
  deferredUpdates.resetDeferredMiniappUpdatesForTests()
  prompt.setRunningUpdatePromptEnvironmentForTests({
    isForeground: () => foreground,
    wasPromptedThisRun: (packageName) => stored.has(`prompted:${packageName}`),
    recordPrompted: (packageName) => stored.set(`prompted:${packageName}`, true),
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

  test("its restart is silent, and skipped when the glasses it needs aren't connected", async () => {
    await runApp({open: true})
    compatible = false
    await release()
    expect(calls).toEqual(["download", "verify", "unpack", "prompt", `stop:${pkg}`, "activate"])
    expect(active).toBe("1.1.0")
    expect(incompatible).toEqual([])
    expect(blocked).toEqual([])
    expect(miniappRunningRegistry.has(pkg)).toBe(false)
    expect(useAppStatusStore.getState().foregroundedPackage).toBeNull()
  })

  test("its restart is not a person opening the miniapp", async () => {
    await runApp({open: false})
    openedByUser.length = 0
    await release()
    expect(miniappRunningRegistry.has(pkg)).toBe(true)
    expect(openedByUser).toEqual([])
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
  })

  test("asks once per run of a miniapp, without downloading while it may not ask", async () => {
    answer = "not_now"
    await runApp({open: false})
    await expect(release()).rejects.toBeInstanceOf(MiniappRunningError)
    calls.length = 0
    await expect(release()).rejects.toBeInstanceOf(MiniappRunningError)
    expect(calls).toEqual([])
    expect(prompts).toHaveLength(1)
    // The next time it is opened, it asks again.
    stored.delete(`prompted:${pkg}`)
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

  test("the version rule refuses a lower version before downloading or asking", async () => {
    active = "2.0.0"
    await runApp({open: true})
    await expect(release()).rejects.toThrow()
    expect(calls).toEqual([])
    expect(prompts).toHaveLength(0)
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

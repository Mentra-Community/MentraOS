import {afterAll, beforeEach, describe, expect, mock, test} from "bun:test"
import {readFileSync} from "node:fs"

import {MiniappErrorCode, MiniappResponseType} from "@mentra/miniapp"

import {configure, getConfigValues, resetForTests} from "../../runtime/bootstrap"
import {DeviceTypes, getModelCapabilities} from "../../types"
import {MiniappRunningError} from "../../utils/storeInstallRuntime"
import {projectSystemActions} from "../manifestActions"
import {checkMiniappInstallCompatibility} from "../miniappInstallCompatibility"
import {
  automaticUpdateOwner,
  canStoreUpdateSystemMiniapp,
  isHostTrustedSystemMiniapp,
  isStoreMiniappPackage,
  isSystemMiniappPackage,
} from "../SystemMiniappPolicy"
import type {ClientApp} from "../../types"

// Exercise the real Store request handlers without booting native audio or
// Bluetooth, following the runtime's other isolated handler suites.
const source = readFileSync(new URL("../LocalMiniappRuntime.ts", import.meta.url), "utf8")
const constant = (name: string) => {
  const match = new RegExp(`^const ${name} =\\s*([^\\n]+)$`, "m").exec(source)
  if (!match) throw new Error(`Missing runtime constant ${name}`)
  return new Function(`return ${match[1]}`)()
}
const methods = [
  "isSystemPackage",
  "buildMiniappInfo",
  "requireHostTrustedStore",
  "currentInstallCompatibilityPolicy",
  "evaluateInstallCompatibility",
  "hasDevelopmentSelection",
  "handleMiniappsInstall",
  "handleMiniappsInstallCheck",
]
  .map((name) => {
    const start = source.search(new RegExp(`^  (?:private|public) (?:async )?${name}\\(`, "m"))
    if (start < 0) throw new Error(`Missing runtime method ${name}`)
    const rest = source.slice(start)
    const end = rest.search(/^ {2}}$/m)
    return rest.slice(0, end + 3)
  })
  .join("\n")
const compiled = new Bun.Transpiler({loader: "ts"}).transformSync(`class Host { ${methods} }`)
const SYSTEM_MINIAPP_PACKAGE_SET = new Set(["com.mentra.ai"])
const STORE_TARGET_PACKAGE_PATTERN = constant("STORE_TARGET_PACKAGE_PATTERN")
const STORE_RELEASE_VERSION_PATTERN = constant("STORE_RELEASE_VERSION_PATTERN")

const store = "com.mentra.store"
const notes = "com.mentra.notes"
const sha = "a".repeat(64)

interface Result {
  ok: boolean
  data?: unknown
  error?: {code: string; message: string}
}
interface Host {
  connectedApps: Map<string, {hostTrustedSystem: boolean}>
  interopApps: () => ClientApp[]
  sendResult: (pkg: string, requestId: string | undefined, ok: boolean, data?: unknown, error?: unknown) => void
  sendToMiniapp: (pkg: string, message: Record<string, unknown>) => void
  auditInterop: () => void
  storeMutationsInFlight: Set<string>
  storeSessionEpoch: number
  isSystemPackage: (pkg: string) => boolean
  buildMiniappInfo: (app: ClientApp) => Record<string, unknown>
  handleMiniappsInstall: (pkg: string, payload: Record<string, unknown>, requestId?: string) => Promise<void>
  handleMiniappsInstallCheck: (pkg: string, payload: Record<string, unknown>, requestId?: string) => void
}

let identities: Record<string, {source: string; storePackageName?: string} | null>
let devRecords: Array<{packageName: string}>
let installs: Array<{url: string; options: Record<string, unknown>}>
let installImplementation: (options: Record<string, unknown>) => Promise<void>
const gc = mock(async () => {})

const HostClass = new Function(
  "SYSTEM_MINIAPP_PACKAGE_SET",
  "STORE_TARGET_PACKAGE_PATTERN",
  "STORE_RELEASE_VERSION_PATTERN",
  "MiniappErrorCode",
  "MiniappResponseType",
  "MiniappRunningError",
  "appRegistry",
  "getDevAppRecords",
  "installMiniappRelease",
  "getConfigValues",
  "useSettingsStore",
  "ISLAND_SETTINGS_KEYS",
  "getModelCapabilities",
  "DeviceTypes",
  "checkMiniappInstallCompatibility",
  "isStoreMiniappPackage",
  "isSystemMiniappPackage",
  "isHostTrustedSystemMiniapp",
  "canStoreUpdateSystemMiniapp",
  "automaticUpdateOwner",
  "projectSystemActions",
  `${compiled}; return Host`,
)(
  SYSTEM_MINIAPP_PACKAGE_SET,
  STORE_TARGET_PACKAGE_PATTERN,
  STORE_RELEASE_VERSION_PATTERN,
  MiniappErrorCode,
  MiniappResponseType,
  MiniappRunningError,
  {
    getActiveVersion: async (pkg: string) => (identities[pkg] ? "1.0.0" : undefined),
    getReleaseIdentity: (pkg: string) => identities[pkg] ?? null,
    getSelectedDevSnapshot: () => null,
    gcReleaseVersions: gc,
  },
  () => devRecords,
  async (url: string, options: Record<string, unknown>) => {
    installs.push({url, options})
    await installImplementation(options)
  },
  getConfigValues,
  {getState: () => ({getSetting: () => DeviceTypes.LIVE})},
  {defaultWearable: "default_wearable"},
  getModelCapabilities,
  DeviceTypes,
  checkMiniappInstallCompatibility,
  isStoreMiniappPackage,
  isSystemMiniappPackage,
  isHostTrustedSystemMiniapp,
  canStoreUpdateSystemMiniapp,
  automaticUpdateOwner,
  projectSystemActions,
) as new () => Host

function harness(storeTrusted = true) {
  const host = new HostClass()
  const results: Result[] = []
  const pushes: Array<Record<string, unknown>> = []
  host.connectedApps = new Map([[store, {hostTrustedSystem: storeTrusted}]])
  host.interopApps = () => []
  host.storeMutationsInFlight = new Set()
  host.storeSessionEpoch = 0
  host.auditInterop = () => {}
  host.sendResult = (_pkg, _id, ok, data, error) => results.push({ok, data, error: error as Result["error"]})
  host.sendToMiniapp = (_pkg, message) => pushes.push(message)
  return {host, results, pushes}
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    packageName: notes,
    version: "1.1.0",
    bundleUrl: "https://store.example/notes.zip",
    bundleSha256: sha.toUpperCase(),
    bundleAuthorization: " store-token ",
    onlyIfStopped: true,
    askIfRunning: true,
    minHostVersion: "3.2.1",
    sdkVersion: "0.3.0",
    hardwareRequirements: [],
    releaseId: "rel_1",
    channel: "stable",
    ...overrides,
  }
}

beforeEach(() => {
  resetForTests()
  configure({
    auth: {},
    config: {
      bundledSystemMiniappPackages: [notes, store, "com.mentra.ai"],
      bundledStoreMiniappPackages: [store],
      bundledSystemMiniappStoreOwners: {[notes]: store, "com.mentra.ai": store},
      hostVersion: "3.3.0",
      supportedMiniappSdkRange: ">=0.3.0 <4.0.0",
    },
  })
  identities = {[notes]: {source: "bundled_asset"}}
  devRecords = []
  installs = []
  installImplementation = async (options) => {
    ;(options.onProgress as (phase: string) => void)("downloading")
  }
  gc.mockClear()
})
afterAll(resetForTests)

describe("Store install requests", () => {
  test("are refused unless they come from the build's bundled Store running its host-installed release", async () => {
    for (const [caller, trusted] of [
      ["com.example.app", true],
      [store, false],
    ] as const) {
      const h = harness(trusted)
      h.host.connectedApps.set(caller, {hostTrustedSystem: trusted})
      await h.host.handleMiniappsInstall(caller, request(), "r1")
      expect(h.results[0].error?.code).toBe(MiniappErrorCode.NOT_PERMITTED)
    }
    expect(installs).toEqual([])
  })

  test("pass an automatic update of a bundled miniapp to the shared installer, asking if it runs", async () => {
    const h = harness()
    await h.host.handleMiniappsInstall(store, request(), "r1")
    expect(h.results).toEqual([{ok: true, data: {packageName: notes, version: "1.1.0", installedByStore: store}}])
    expect(installs).toHaveLength(1)
    expect(installs[0].url).toBe("https://store.example/notes.zip")
    expect(installs[0].options).toMatchObject({
      expectedPackageName: notes,
      expectedVersion: "1.1.0",
      expectedBundleSha256: sha,
      bundleAuthorization: "store-token",
      onlyIfStopped: true,
      askIfRunning: true,
      compatibilityPolicy: {hostVersion: "3.3.0", supportedSdkRange: ">=0.3.0 <4.0.0"},
      releaseIdentity: {
        source: "system_store",
        storePackageName: store,
        bundleSha256: sha,
        releaseId: "rel_1",
        channel: "stable",
      },
    })
    expect(h.pushes).toEqual([
      {type: MiniappResponseType.MINIAPPS_INSTALL_PROGRESS, packageName: notes, version: "1.1.0", phase: "downloading"},
      {type: MiniappResponseType.MINIAPPS_INSTALL_PROGRESS, packageName: notes, version: "1.1.0", phase: "complete"},
    ])
    expect(gc).toHaveBeenCalledWith(notes, ["1.1.0", "1.0.0"])
  })

  test("only ask about a running miniapp for automatic updates", async () => {
    const h = harness()
    identities["com.acme.weather"] = {source: "store", storePackageName: store}
    await h.host.handleMiniappsInstall(store, request({packageName: "com.acme.weather", onlyIfStopped: false}), "r1")
    expect(installs[0].options).toMatchObject({onlyIfStopped: false, askIfRunning: false})
    expect(installs[0].options.releaseIdentity).toMatchObject({source: "store"})
  })

  test("answer APP_RUNNING when the miniapp keeps running, and INSTALL_FAILED for other failures", async () => {
    const h = harness()
    installImplementation = async () => {
      throw new MiniappRunningError(notes)
    }
    await h.host.handleMiniappsInstall(store, request(), "r1")
    installImplementation = async () => {
      throw new Error("Unsigned bundle cannot replace signed miniapp com.mentra.notes")
    }
    await h.host.handleMiniappsInstall(store, request(), "r2")
    expect(h.results.map((result) => result.error?.code)).toEqual([
      MiniappErrorCode.APP_RUNNING,
      MiniappErrorCode.INSTALL_FAILED,
    ])
    expect(gc).not.toHaveBeenCalled()
  })

  test.each([
    [{packageName: "../notes"}, MiniappErrorCode.INVALID_ARGUMENT],
    [{version: "latest"}, MiniappErrorCode.INVALID_ARGUMENT],
    [{bundleSha256: "abc"}, MiniappErrorCode.INVALID_ARGUMENT],
    [{bundleUrl: "http://store.example/notes.zip"}, MiniappErrorCode.INVALID_ARGUMENT],
    [{bundleUrl: "not a url"}, MiniappErrorCode.INVALID_ARGUMENT],
    [{packageName: store}, MiniappErrorCode.NOT_PERMITTED],
    [{minHostVersion: "9.0.0"}, MiniappErrorCode.APP_NOT_COMPATIBLE],
    [{sdkVersion: "4.0.0"}, MiniappErrorCode.APP_NOT_COMPATIBLE],
  ])("refuse %j before downloading", async (overrides, code) => {
    const h = harness()
    await h.host.handleMiniappsInstall(store, request(overrides), "r1")
    expect(h.results[0].error?.code).toBe(code)
    expect(installs).toEqual([])
  })

  test("refuse to install when the host's compatibility policy is not configured", async () => {
    configure({
      auth: {},
      config: {
        bundledSystemMiniappPackages: [notes, store],
        bundledStoreMiniappPackages: [store],
        bundledSystemMiniappStoreOwners: {[notes]: store},
      },
    })
    const h = harness()
    await h.host.handleMiniappsInstall(store, request(), "r1")
    expect(h.results[0].error).toMatchObject({code: MiniappErrorCode.APP_NOT_COMPATIBLE})
    expect(installs).toEqual([])
  })

  test("never replace another Store's release, a manual install or a development build automatically", async () => {
    const h = harness()
    identities["com.acme.weather"] = {source: "store", storePackageName: "com.oem.store"}
    await h.host.handleMiniappsInstall(store, request({packageName: "com.acme.weather"}), "r1")
    identities["com.acme.weather"] = {source: "direct_download"}
    await h.host.handleMiniappsInstall(store, request({packageName: "com.acme.weather"}), "r2")
    devRecords = [{packageName: notes}]
    await h.host.handleMiniappsInstall(store, request(), "r3")
    expect(h.results.map((result) => result.error?.code)).toEqual([
      MiniappErrorCode.STORE_OWNERSHIP_CONFLICT,
      MiniappErrorCode.STORE_OWNERSHIP_CONFLICT,
      MiniappErrorCode.INSTALL_FAILED,
    ])
    expect(installs).toEqual([])
  })

  test("a development build selected while the update downloads stops it before activation", async () => {
    const h = harness()
    installImplementation = async (options) => {
      devRecords = [{packageName: notes}]
      ;(options.beforeActivate as () => void)()
    }
    await h.host.handleMiniappsInstall(store, request(), "r1")
    expect(h.results[0].error).toMatchObject({code: MiniappErrorCode.INSTALL_FAILED})
  })

  test("an install requested before sign-out or a deployment switch is cancelled by cleanup", async () => {
    const h = harness()
    const cancelledStates: boolean[] = []
    installImplementation = async (options) => {
      const isCancelled = options.isCancelled as () => boolean
      cancelledStates.push(isCancelled())
      // cleanup() bumps the epoch while the release downloads.
      h.host.storeSessionEpoch += 1
      cancelledStates.push(isCancelled())
    }
    await h.host.handleMiniappsInstall(store, request(), "r1")
    expect(cancelledStates).toEqual([false, true])
  })

  test("run one operation per package, not one for every package", async () => {
    const h = harness()
    let release!: () => void
    installImplementation = () =>
      new Promise<void>((resolve) => {
        release = resolve
      })
    const first = h.host.handleMiniappsInstall(store, request(), "r1")
    await Promise.resolve()
    await Promise.resolve()
    await h.host.handleMiniappsInstall(store, request(), "r2")
    expect(h.results).toEqual([
      {ok: false, data: undefined, error: expect.objectContaining({code: MiniappErrorCode.INSTALL_IN_PROGRESS})},
    ])
    identities["com.acme.weather"] = {source: "store", storePackageName: store}
    installImplementation = async () => {}
    await h.host.handleMiniappsInstall(store, request({packageName: "com.acme.weather"}), "r3")
    expect(h.results.at(-1)).toMatchObject({ok: true})
    release()
    await first
    expect(h.results.at(-1)).toMatchObject({ok: true})
  })

  test("answer compatibility checks for the trusted Store only", () => {
    const h = harness()
    h.host.handleMiniappsInstallCheck(store, {minHostVersion: "9.0.0"}, "r1")
    h.host.handleMiniappsInstallCheck(store, {minHostVersion: "3.2.1", sdkVersion: "3.2.1"}, "r2")
    h.host.handleMiniappsInstallCheck("com.example.app", {}, "r3")
    expect(h.results[0]).toMatchObject({ok: true, data: {compatible: false, blocker: "host"}})
    expect(h.results[1]).toEqual({ok: true, data: {compatible: true}, error: undefined})
    expect(h.results[2].error?.code).toBe(MiniappErrorCode.NOT_PERMITTED)
  })
})

describe("what the Store sees", () => {
  function app(packageName: string, overrides: Partial<ClientApp> = {}): ClientApp {
    const listed: Partial<ClientApp> = {
      packageName,
      name: packageName,
      version: "1.0.0",
      running: false,
      local: true,
      actions: [
        {id: "open", description: "Open.", lifecycle: "persistent", audience: "system"},
        {id: "maintain", description: "Maintain.", lifecycle: "transient", audience: "host"},
      ],
      ...overrides,
    }
    return listed as ClientApp
  }

  test("lists build ownership and the Store that may update each release, never host-only actions", () => {
    const {host} = harness()
    identities["com.acme.weather"] = {source: "store", storePackageName: store}
    expect(host.buildMiniappInfo(app(notes))).toMatchObject({system: true, systemStoreOwnerPackageName: store})
    expect(host.buildMiniappInfo(app("com.acme.weather"))).toMatchObject({
      system: false,
      storeOwnerPackageName: store,
    })
    const devBuild = host.buildMiniappInfo(app(notes, {isMiniappDev: true}))
    expect(devBuild).not.toHaveProperty("systemStoreOwnerPackageName")
    expect(host.buildMiniappInfo(app(notes)).actions).toEqual([
      {id: "open", description: "Open.", lifecycle: "persistent"},
    ])
  })

  test("SYSTEM privileges survive an update from the assigned Store", () => {
    const {host} = harness()
    host.interopApps = () => [app("com.mentra.ai")]
    identities["com.mentra.ai"] = {source: "system_store", storePackageName: store}
    expect(host.isSystemPackage("com.mentra.ai")).toBe(true)
    identities["com.mentra.ai"] = {source: "direct_download"}
    expect(host.isSystemPackage("com.mentra.ai")).toBe(false)
    // The background-only Store is privileged through its trusted context.
    expect(host.isSystemPackage(store)).toBe(true)
    host.connectedApps.set(store, {hostTrustedSystem: false})
    expect(host.isSystemPackage(store)).toBe(false)
  })
})

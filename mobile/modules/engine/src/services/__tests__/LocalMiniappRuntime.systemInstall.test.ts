import {afterAll, beforeEach, describe, expect, test} from "bun:test"
import {readFileSync} from "node:fs"

import {MiniappErrorCode} from "@mentra/miniapp"

import {configure, getConfigValues, resetForTests} from "../../runtime/bootstrap"
import {DeviceTypes, getModelCapabilities} from "../../types"
import type {ClientApp} from "../../types"
import type {InstallMiniappErrorCode, InstallMiniappOptions, InstallMiniappResult} from "../installMiniapp"
import {projectSystemActions} from "../manifestActions"
import {checkMiniappInstallCompatibility} from "../miniappInstallCompatibility"
import {isHostTrustedSystemMiniapp, isSystemMiniappPackage} from "../SystemMiniappPolicy"

// Exercise the real install request handlers without booting native audio or
// Bluetooth, following the runtime's other isolated handler suites.
const source = readFileSync(new URL("../LocalMiniappRuntime.ts", import.meta.url), "utf8")
const methods = [
  "isSystemPackage",
  "requireSystemListCaller",
  "buildMiniappInfo",
  "currentInstallCompatibilityPolicy",
  "evaluateInstallCompatibility",
  "hasDevelopmentSelection",
  "handleMiniappsInstall",
  "handleMiniappsInstallCheck",
  "uninstallRefusal",
  "handleMiniappsUninstall",
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

// installMiniapp.ts loads the whole runtime; its error class has this shape.
class InstallMiniappError extends Error {
  constructor(
    readonly code: InstallMiniappErrorCode,
    message: string,
  ) {
    super(message)
  }
}

const ai = "com.mentra.ai"
const notes = "com.mentra.notes"
const weather = "com.example.weather"
const url = "https://weather.example.com/"

interface Result {
  ok: boolean
  data?: unknown
  error?: {code: string; message: string; reason?: string}
}
interface Host {
  connectedApps: Map<string, {hostTrustedSystem: boolean}>
  installSessionEpoch: number
  interopApps: () => ClientApp[]
  stopInteropApp: (pkg: string) => Promise<void>
  sendResult: (pkg: string, requestId: string | undefined, ok: boolean, data?: unknown, error?: unknown) => void
  auditInterop: (event: Record<string, unknown>) => void
  isSystemPackage: (pkg: string) => boolean
  buildMiniappInfo: (app: ClientApp) => Record<string, unknown>
  handleMiniappsInstall: (pkg: string, payload: Record<string, unknown>, requestId?: string) => Promise<void>
  handleMiniappsInstallCheck: (pkg: string, payload: Record<string, unknown>, requestId?: string) => void
  handleMiniappsUninstall: (pkg: string, payload: Record<string, unknown>, requestId?: string) => Promise<void>
}

let identities: Record<string, {source: string; storePackageName?: string; sourceUrl?: string} | null>
/** Packages whose context started as a local or development build. */
const localBuilds = new Set<string>()
let reasons: Record<string, string[]>
let devRecords: Array<{packageName: string}>
let installs: Array<{url: string; options: InstallMiniappOptions}>
let installImplementation: (url: string, options: InstallMiniappOptions) => Promise<InstallMiniappResult>
let uninstalled: string[]
let uninstallImplementation: (pkg: string) => Promise<{is_error: () => boolean; error?: Error}>
type UninstallResult = {is_error: () => boolean; error?: Error}

const HostClass = new Function(
  "SYSTEM_MINIAPP_PACKAGE_SET",
  "MiniappErrorCode",
  "appRegistry",
  "getDevAppRecords",
  "installMiniapp",
  "InstallMiniappError",
  "useAppStatusStore",
  "getConfigValues",
  "useSettingsStore",
  "ISLAND_SETTINGS_KEYS",
  "getModelCapabilities",
  "DeviceTypes",
  "checkMiniappInstallCompatibility",
  "isSystemMiniappPackage",
  "isHostTrustedSystemMiniapp",
  "projectSystemActions",
  "isLocalBuildContext",
  `${compiled}; return Host`,
)(
  SYSTEM_MINIAPP_PACKAGE_SET,
  MiniappErrorCode,
  {
    getActiveReleaseVersion: (pkg: string) => (identities[pkg] ? "1.0.0" : null),
    getReleaseIdentity: (pkg: string) => identities[pkg] ?? null,
    getInstallReasons: (pkg: string) => reasons[pkg] ?? (identities[pkg] ? ["explicit"] : []),
    getSelectedDevSnapshot: () => null,
  },
  () => devRecords,
  async (target: string, options: InstallMiniappOptions) => {
    installs.push({url: target, options})
    return installImplementation(target, options)
  },
  InstallMiniappError,
  {
    getState: () => ({
      // The real store runs beforeRemove inside AppRegistry's serialized uninstall, before anything is removed.
      uninstall: async (pkg: string, _version?: string, options?: {beforeRemove?: () => void}): Promise<UninstallResult> => {
        try {
          options?.beforeRemove?.()
        } catch (error) {
          return {is_error: () => true, error: error as Error}
        }
        uninstalled.push(pkg)
        return uninstallImplementation(pkg)
      },
    }),
  },
  getConfigValues,
  {getState: () => ({getSetting: () => DeviceTypes.LIVE})},
  {defaultWearable: "default_wearable"},
  getModelCapabilities,
  DeviceTypes,
  checkMiniappInstallCompatibility,
  isSystemMiniappPackage,
  isHostTrustedSystemMiniapp,
  projectSystemActions,
  (packageName: string) => localBuilds.has(packageName),
) as new () => Host

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

function isTrusted(listed: ClientApp): boolean {
  return isHostTrustedSystemMiniapp(listed.packageName, identities[listed.packageName])
}

function harness(apps: ClientApp[] = [app(ai)]) {
  const host = new HostClass()
  const results: Result[] = []
  const audits: Array<Record<string, unknown>> = []
  const stopped: string[] = []
  // Each listed miniapp runs the release its tile names, which the launcher trusted.
  host.connectedApps = new Map(
    apps.map((listed) => [listed.packageName, {hostTrustedSystem: !listed.isMiniappDev && isTrusted(listed)}]),
  )
  host.installSessionEpoch = 0
  host.interopApps = () => apps
  host.stopInteropApp = async (pkg) => {
    stopped.push(pkg)
  }
  host.auditInterop = (event) => audits.push(event)
  host.sendResult = (_pkg, _id, ok, data, error) => results.push({ok, data, error: error as Result["error"]})
  return {host, results, audits, stopped}
}

beforeEach(() => {
  resetForTests()
  configure({
    auth: {},
    config: {
      bundledSystemMiniappPackages: [ai, notes],
      hostVersion: "3.4.0",
      supportedMiniappSdkRange: ">=0.3.0 <4.0.0",
    },
  })
  identities = {[ai]: {source: "bundled_asset"}, [notes]: {source: "bundled_asset"}}
  reasons = {}
  localBuilds.clear()
  devRecords = []
  installs = []
  installImplementation = async () => ({status: "installed", packageName: weather, version: "1.2.0"})
  uninstalled = []
  uninstallImplementation = async () => ({is_error: () => false})
})
afterAll(resetForTests)

describe("installing from a system miniapp", () => {
  test("a miniapp on the system list installs a miniapp URL headlessly, through installMiniapp", async () => {
    const h = harness()
    await h.host.handleMiniappsInstall(ai, {url: ` ${url} `}, "r1")
    expect(installs).toEqual([{url, options: {source: "system"}}])
    expect(installs[0].options.confirm).toBeUndefined()
    expect(h.results).toEqual([
      {ok: true, data: {status: "installed", packageName: weather, version: "1.2.0"}, error: undefined},
    ])
    expect(h.audits).toEqual([{caller: ai, op: "install", target: weather, ok: true}])
  })

  test("answers what installMiniapp answers: opened and deferred are not failures", async () => {
    const h = harness()
    installImplementation = async () => ({status: "opened", packageName: weather, version: "1.2.0"})
    await h.host.handleMiniappsInstall(ai, {url}, "r1")
    installImplementation = async () => ({status: "deferred", packageName: weather, version: "1.1.0"})
    await h.host.handleMiniappsInstall(ai, {url}, "r2")
    expect(h.results.map((result) => result.data)).toEqual([
      {status: "opened", packageName: weather, version: "1.2.0"},
      {status: "deferred", packageName: weather, version: "1.1.0"},
    ])
  })

  test("keeps its system privileges after an update from a Mentra host, or from the retired Mentra Store", async () => {
    identities[ai] = {source: "url", sourceUrl: "https://miniapps.mentraglass.com/com.mentra.ai/"}
    await harness().host.handleMiniappsInstall(ai, {url}, "r1")
    identities[ai] = {source: "system_store", storePackageName: "com.mentra.store"}
    await harness().host.handleMiniappsInstall(ai, {url}, "r2")
    expect(installs).toHaveLength(2)
  })

  test.each([
    ["a third-party miniapp", weather, [app(weather)], {[weather]: {source: "url", sourceUrl: url}}],
    ["a bundled miniapp that isn't on the system list", notes, [app(notes)], {}],
    ["a development build", "com.example.tool", [app("com.example.tool", {isMiniappDev: true})], {}],
    ["a system-list package installed from a release QR", ai, [app(ai)], {[ai]: {source: "direct_download"}}],
    [
      "a system-list package from a host that can't serve its name",
      ai,
      [app(ai)],
      {[ai]: {source: "url", sourceUrl: "https://ai.example.com/"}},
    ],
    [
      "a system-list package another Store updated",
      ai,
      [app(ai)],
      {[ai]: {source: "system_store", storePackageName: "com.oem.store"}},
    ],
    ["the retired Store miniapp", "com.mentra.store", [], {"com.mentra.store": {source: "bundled_asset"}}],
  ])("%s gets NOT_PERMITTED, and nothing installs", async (_name, caller, apps, overrides) => {
    Object.assign(identities, overrides)
    const h = harness(apps)
    h.host.connectedApps.set(caller, {hostTrustedSystem: true})
    await h.host.handleMiniappsInstall(caller, {url}, "r1")
    expect(h.results).toEqual([
      {ok: false, data: undefined, error: expect.objectContaining({code: MiniappErrorCode.NOT_PERMITTED})},
    ])
    expect(h.audits).toEqual([{caller, op: "install", ok: false, errorCode: MiniappErrorCode.NOT_PERMITTED}])
    expect(installs).toEqual([])
  })

  test("a context that only reuses a system package's name gets NOT_PERMITTED, whatever its tile says", async () => {
    // The installed com.mentra.ai is the bundled release, but what runs under its name is a development build.
    const h = harness()
    h.host.connectedApps.set(ai, {hostTrustedSystem: false})
    await h.host.handleMiniappsInstall(ai, {url}, "r1")
    h.host.handleMiniappsInstallCheck(ai, {}, "r2")
    await h.host.handleMiniappsUninstall(ai, {packageName: weather}, "r3")
    expect(h.results.map((result) => result.error?.code)).toEqual([
      MiniappErrorCode.NOT_PERMITTED,
      MiniappErrorCode.NOT_PERMITTED,
      MiniappErrorCode.NOT_PERMITTED,
    ])
    expect(installs).toEqual([])
    h.host.connectedApps.delete(ai)
    await h.host.handleMiniappsInstall(ai, {url}, "r4")
    expect(h.results[3].error?.code).toBe(MiniappErrorCode.NOT_PERMITTED)
    expect(installs).toEqual([])
  })

  test.each([{}, {url: ""}, {url: "  "}, {url: 42}])("refuses %j without installing", async (payload) => {
    const h = harness()
    await h.host.handleMiniappsInstall(ai, payload, "r1")
    expect(h.results[0].error?.code).toBe(MiniappErrorCode.INVALID_ARGUMENT)
    expect(installs).toEqual([])
  })

  test("the old release request installs nothing: an install names a URL", async () => {
    const h = harness()
    await h.host.handleMiniappsInstall(
      ai,
      {packageName: weather, version: "1.2.0", bundleUrl: `${url}weather.zip`, bundleSha256: "a".repeat(64)},
      "r1",
    )
    expect(h.results[0].error?.code).toBe(MiniappErrorCode.INVALID_ARGUMENT)
    expect(installs).toEqual([])
  })

  test("a failed install answers INSTALL_FAILED, with installMiniapp's code as its reason", async () => {
    const h = harness()
    for (const code of ["archived", "domain_mismatch", "needs_newer_app", "access_denied", "network"] as const) {
      installImplementation = async () => {
        throw new InstallMiniappError(code, `failed: ${code}`)
      }
      await h.host.handleMiniappsInstall(ai, {url}, code)
    }
    installImplementation = async () => {
      throw new Error("disk full")
    }
    await h.host.handleMiniappsInstall(ai, {url}, "other")
    expect(h.results.map((result) => result.error)).toEqual([
      {code: MiniappErrorCode.INSTALL_FAILED, message: "failed: archived", reason: "archived"},
      {code: MiniappErrorCode.INSTALL_FAILED, message: "failed: domain_mismatch", reason: "domain_mismatch"},
      {code: MiniappErrorCode.INSTALL_FAILED, message: "failed: needs_newer_app", reason: "needs_newer_app"},
      {code: MiniappErrorCode.INSTALL_FAILED, message: "failed: access_denied", reason: "access_denied"},
      {code: MiniappErrorCode.INSTALL_FAILED, message: "failed: network", reason: "network"},
      {code: MiniappErrorCode.INSTALL_FAILED, message: "disk full"},
    ])
    expect(h.audits.every((event) => event.ok === false && event.errorCode === MiniappErrorCode.INSTALL_FAILED)).toBe(
      true,
    )
  })
})

describe("compatibility checks", () => {
  test("answer a system-list miniapp, and refuse any other caller", () => {
    const h = harness([app(ai), app(weather)])
    h.host.handleMiniappsInstallCheck(ai, {minHostVersion: "9.0.0"}, "r1")
    h.host.handleMiniappsInstallCheck(ai, {minHostVersion: "3.2.1", sdkVersion: "3.2.1"}, "r2")
    h.host.handleMiniappsInstallCheck(weather, {}, "r3")
    expect(h.results[0]).toMatchObject({ok: true, data: {compatible: false, blocker: "host"}})
    expect(h.results[1]).toEqual({ok: true, data: {compatible: true}, error: undefined})
    expect(h.results[2].error?.code).toBe(MiniappErrorCode.NOT_PERMITTED)
  })
})

describe("uninstalling from a system miniapp", () => {
  test("a miniapp installed from its URL uninstalls, stopping it first when it runs", async () => {
    identities[weather] = {source: "url", sourceUrl: url}
    const h = harness([app(ai), app(weather, {running: true})])
    await h.host.handleMiniappsUninstall(ai, {packageName: weather}, "r1")
    expect(h.stopped).toEqual([weather])
    expect(uninstalled).toEqual([weather])
    expect(h.results).toEqual([{ok: true, data: undefined, error: undefined}])
    expect(h.audits).toEqual([{caller: ai, op: "uninstall", target: weather, ok: true}])
  })

  test.each([
    ["bundled with the Mentra App", notes, {[notes]: {source: "url", sourceUrl: "https://miniapps.mentraglass.com/x/"}}, {}],
    ["a workspace's deployment release", weather, {[weather]: {source: "deployment_manifest"}}, {}],
    ["a Fleet assignment", weather, {[weather]: {source: "url", sourceUrl: url}}, {[weather]: ["explicit", "assignment"]}],
    ["a release-QR install", weather, {[weather]: {source: "direct_download"}}, {}],
    ["a Store's install", weather, {[weather]: {source: "store", storePackageName: "com.mentra.store"}}, {}],
  ])("a miniapp %s stays", async (_name, target, overrides, overrideReasons) => {
    Object.assign(identities, overrides)
    Object.assign(reasons, overrideReasons)
    const h = harness([app(ai), app(target)])
    await h.host.handleMiniappsUninstall(ai, {packageName: target}, "r1")
    expect(h.results[0].error?.code).toBe(MiniappErrorCode.NOT_PERMITTED)
    expect(uninstalled).toEqual([])
  })

  test("a Fleet assignment that arrives while the miniapp stops keeps it installed", async () => {
    identities[weather] = {source: "url", sourceUrl: url}
    const h = harness([app(ai), app(weather, {running: true})])
    h.host.stopInteropApp = async () => {
      reasons[weather] = ["explicit", "assignment"]
    }
    await h.host.handleMiniappsUninstall(ai, {packageName: weather}, "r1")
    expect(h.results[0].error?.code).toBe(MiniappErrorCode.NOT_PERMITTED)
    expect(uninstalled).toEqual([])
  })

  test("an engine session that ends while the miniapp stops uninstalls nothing", async () => {
    identities[weather] = {source: "url", sourceUrl: url}
    const h = harness([app(ai), app(weather, {running: true})])
    h.host.stopInteropApp = async () => {
      h.host.installSessionEpoch += 1
    }
    await h.host.handleMiniappsUninstall(ai, {packageName: weather}, "r1")
    expect(h.results[0].error).toEqual({
      code: MiniappErrorCode.INTERNAL,
      message: `The uninstall of ${weather} was cancelled`,
    })
    expect(uninstalled).toEqual([])
  })

  test("a development build of a URL install stays", async () => {
    identities[weather] = {source: "url", sourceUrl: url}
    devRecords = [{packageName: weather}]
    const h = harness([app(ai), app(weather)])
    await h.host.handleMiniappsUninstall(ai, {packageName: weather}, "r1")
    expect(h.results[0].error?.code).toBe(MiniappErrorCode.NOT_PERMITTED)
    expect(uninstalled).toEqual([])
  })

  test("a package that isn't installed is APP_NOT_FOUND, and a missing name INVALID_ARGUMENT", async () => {
    const h = harness()
    await h.host.handleMiniappsUninstall(ai, {packageName: weather}, "r1")
    await h.host.handleMiniappsUninstall(ai, {}, "r2")
    expect(h.results.map((result) => result.error?.code)).toEqual([
      MiniappErrorCode.APP_NOT_FOUND,
      MiniappErrorCode.INVALID_ARGUMENT,
    ])
  })

  test("any caller off the system list gets NOT_PERMITTED", async () => {
    identities[weather] = {source: "url", sourceUrl: url}
    const h = harness([app(weather), app("com.example.tool", {isMiniappDev: true})])
    await h.host.handleMiniappsUninstall(weather, {packageName: weather}, "r1")
    await h.host.handleMiniappsUninstall("com.example.tool", {packageName: weather}, "r2")
    expect(h.results.map((result) => result.error?.code)).toEqual([
      MiniappErrorCode.NOT_PERMITTED,
      MiniappErrorCode.NOT_PERMITTED,
    ])
    expect(uninstalled).toEqual([])
  })

  test("an uninstall the host refuses answers INTERNAL", async () => {
    identities[weather] = {source: "url", sourceUrl: url}
    uninstallImplementation = async () => ({is_error: () => true, error: new Error("busy")})
    const h = harness([app(ai), app(weather)])
    await h.host.handleMiniappsUninstall(ai, {packageName: weather}, "r1")
    expect(h.results[0].error).toEqual({code: MiniappErrorCode.INTERNAL, message: "busy"})
  })
})

describe("what a system miniapp sees", () => {
  test("lists which miniapps the build bundles, never who updates them or host-only actions", () => {
    const {host} = harness()
    identities[weather] = {source: "url", sourceUrl: url}
    const listed = host.buildMiniappInfo(app(notes))
    expect(listed).toMatchObject({system: true, actions: [{id: "open", description: "Open.", lifecycle: "persistent"}]})
    expect(listed).not.toHaveProperty("systemStoreOwnerPackageName")
    expect(host.buildMiniappInfo(app(weather))).toMatchObject({system: false})
    expect(host.buildMiniappInfo(app(weather))).not.toHaveProperty("storeOwnerPackageName")
  })

  test("a local or development build never gets system privileges, whatever name it claims", async () => {
    const h = harness([app(ai), app(weather, {isMiniappDev: true})])
    expect(h.host.isSystemPackage(ai)).toBe(true)
    // A dev build of an ordinary package is an ordinary caller.
    expect(h.host.isSystemPackage(weather)).toBe(false)
    // A local build claiming a system package's name, even over its bundled release and a trusted context.
    localBuilds.add(ai)
    expect(h.host.isSystemPackage(ai)).toBe(false)
    await h.host.handleMiniappsInstall(ai, {url}, "r1")
    expect(h.results[0].error?.code).toBe(MiniappErrorCode.NOT_PERMITTED)
    expect(installs).toEqual([])
  })

  test("the retired Store gets no privileges from its live context", () => {
    const {host} = harness([])
    host.connectedApps.set("com.mentra.store", {hostTrustedSystem: true})
    expect(host.isSystemPackage("com.mentra.store")).toBe(false)
  })
})

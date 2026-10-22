import {beforeEach, describe, expect, test} from "bun:test"

import {DeviceTypes, getModelCapabilities} from "../../types"
import type {MiniappReleaseIdentity} from "../AppRegistry"
import type {ReleaseInstallOptions} from "../miniappReleaseInstall"
import {
  BASE_BACKOFF_MS,
  isPackageNameAllowedForUrl,
  type ManifestFetchResult,
  MiniappUrlUpdater,
  OPEN_CHECK_INTERVAL_MS,
  parseHostedManifest,
} from "../miniappUrlUpdates"

const pkg = "com.mentra.captions"
const host = "https://miniapps.mentraglass.com/"
const sourceUrl = `${host}${pkg}/`
const sha = "b".repeat(64)

class RunningError extends Error {}

interface Install {
  bundleUrl: string
  options: ReleaseInstallOptions
}

let now = 1_000_000
let active: Record<string, string>
let identities: Record<string, MiniappReleaseIdentity>
let responses: ManifestFetchResult[]
let fetched: Array<{url: string; etag?: string}>
let installs: Install[]
let installError: unknown
let kept: Array<{packageName: string; versions: string[]}>
let devSelected: Set<string>
let warnings: string[]
let session: number
let hardware: DeviceTypes
let duringInstall: ((options: ReleaseInstallOptions) => void) | undefined

function served(manifest: Record<string, unknown>, extra: Partial<ManifestFetchResult> = {}): ManifestFetchResult {
  return {status: 200, url: `${sourceUrl}miniapp.json`, body: JSON.stringify(manifest), ...extra}
}

function manifest(version: string, overrides: Record<string, unknown> = {}) {
  return {
    packageName: pkg,
    version,
    sdkVersion: "0.3.0",
    minHostVersion: "3.0.0",
    hardwareRequirements: [],
    bundle: {url: `${pkg}-${version}.zip`, sha256: sha},
    ...overrides,
  }
}

function updaterDeps(): ConstructorParameters<typeof MiniappUrlUpdater>[0] {
  return {
    installedPackages: async () => Object.keys(active),
    activeVersion: async (packageName) => active[packageName],
    releaseIdentity: (packageName) => identities[packageName] ?? null,
    isSystemPackage: (packageName) => packageName.startsWith("com.mentra."),
    firstPartyUrl: (packageName) => `${host}${packageName}/`,
    hasDevelopmentSelection: (packageName) => devSelected.has(packageName),
    compatibilityPolicy: () => ({
      hostVersion: "3.3.0",
      supportedSdkRange: ">=0.3.0 <4.0.0",
      hardwareCapabilities: getModelCapabilities(hardware),
    }),
    fetchManifest: async (url, etag) => {
      fetched.push({url, etag})
      const next = responses.shift()
      if (!next) throw new Error("no response queued")
      return next
    },
    install: async (bundleUrl, options) => {
      installs.push({bundleUrl, options})
      duringInstall?.(options)
      if (options.isCancelled?.()) throw new Error("cancelled")
      if (installError) throw installError
      active[options.expectedPackageName] = options.expectedVersion
    },
    keepVersions: async (packageName, versions) => {
      kept.push({packageName, versions})
    },
    isRunningError: (error) => error instanceof RunningError,
    installSession: () => session,
    now: () => now,
    log: () => {},
    warn: (message) => warnings.push(message),
  }
}

function updater() {
  return new MiniappUrlUpdater(updaterDeps())
}

beforeEach(() => {
  now = 1_000_000
  active = {[pkg]: "1.0.0"}
  identities = {[pkg]: {source: "bundled_asset"}}
  responses = []
  fetched = []
  installs = []
  installError = undefined
  kept = []
  devSelected = new Set()
  warnings = []
  session = 1
  hardware = DeviceTypes.NONE
  duringInstall = undefined
})

describe("the domain rule", () => {
  test("Mentra's packages come only from mentraglass.com hosts", () => {
    expect(isPackageNameAllowedForUrl("com.mentra.captions", sourceUrl)).toBe(true)
    expect(isPackageNameAllowedForUrl("com.mentra.captions", "https://miniapps.dev.mentraglass.com/x/")).toBe(true)
    expect(isPackageNameAllowedForUrl("com.mentraglass.tools", "https://mentraglass.com/tools/")).toBe(true)
    expect(isPackageNameAllowedForUrl("com.mentra.captions", "https://evil.example/com.mentra.captions/")).toBe(false)
    expect(isPackageNameAllowedForUrl("com.mentra.captions", "https://mentraglass.com.evil.example/")).toBe(false)
    expect(isPackageNameAllowedForUrl("com.mentra.captions", "http://miniapps.mentraglass.com/")).toBe(false)
  })

  test("other names don't update from a URL yet", () => {
    expect(isPackageNameAllowedForUrl("com.example.notes", "https://notes.example.com/")).toBe(false)
  })
})

describe("the served miniapp.json", () => {
  test("is the manifest plus the bundle's URL and SHA-256", () => {
    const parsed = parseHostedManifest(JSON.stringify(manifest("1.2.0")), pkg)
    expect(parsed).toMatchObject({packageName: pkg, version: "1.2.0", bundle: {url: `${pkg}-1.2.0.zip`, sha256: sha}})
  })

  test.each([
    ["another package", {packageName: "com.mentra.notes"}],
    ["an invalid version", {version: "one"}],
    ["no bundle", {bundle: undefined}],
    ["a bad hash", {bundle: {url: "x.zip", sha256: "abc"}}],
  ])("is refused for %s", (_name, overrides) => {
    expect(() => parseHostedManifest(JSON.stringify(manifest("1.2.0", overrides)), pkg)).toThrow()
  })
})

describe("updates from a miniapp's own URL", () => {
  test("a bundled miniapp updates from Mentra's host through the shared installer", async () => {
    responses = [served(manifest("1.1.0"), {etag: '"v2"'})]
    await updater().checkAll()
    expect(fetched).toEqual([{url: `${sourceUrl}miniapp.json`, etag: undefined}])
    expect(installs).toHaveLength(1)
    expect(installs[0].bundleUrl).toBe(`${sourceUrl}${pkg}-1.1.0.zip`)
    expect(installs[0].options).toMatchObject({
      expectedPackageName: pkg,
      expectedVersion: "1.1.0",
      expectedBundleSha256: sha,
      onlyIfStopped: true,
      askIfRunning: true,
      releaseIdentity: {source: "url", sourceUrl, bundleSha256: sha},
    })
    expect(kept).toEqual([{packageName: pkg, versions: ["1.1.0", "1.0.0"]}])
  })

  test("a bundled miniapp updated from one host follows the host its deployment names now", async () => {
    identities[pkg] = {source: "url", sourceUrl: "https://miniapps.staging.mentraglass.com/com.mentra.captions/"}
    responses = [served(manifest("1.1.0"))]
    await updater().checkAll()
    expect(fetched[0].url).toBe(`${sourceUrl}miniapp.json`)
    expect(installs[0].bundleUrl).toBe(`${sourceUrl}${pkg}-1.1.0.zip`)
  })

  test("a deployment that names no host keeps its bundled miniapps where they are", async () => {
    identities[pkg] = {source: "url", sourceUrl}
    const u = new MiniappUrlUpdater({...updaterDeps(), firstPartyUrl: () => undefined})
    await u.checkAll()
    expect(fetched).toEqual([])
  })

  test("sends the stored ETag, and an unchanged miniapp costs one 304", async () => {
    const u = updater()
    responses = [served(manifest("1.0.0"), {etag: '"v1"'})]
    await u.checkAll()
    responses = [{status: 304, url: `${sourceUrl}miniapp.json`}]
    await u.checkAll()
    expect(fetched.map((call) => call.etag)).toEqual([undefined, '"v1"'])
    expect(installs).toHaveLength(0)
  })

  test("a release that waited for its running miniapp installs on the next check, even after a 304", async () => {
    installError = new RunningError("running")
    const u = updater()
    responses = [served(manifest("1.1.0"), {etag: '"v2"'})]
    await u.check(pkg)
    installError = undefined
    responses = [{status: 304, url: `${sourceUrl}miniapp.json`}]
    await u.check(pkg)
    expect(fetched.map((call) => call.etag)).toEqual([undefined, '"v2"'])
    expect(installs).toHaveLength(2)
    expect(active[pkg]).toBe("1.1.0")
  })

  test("a failed install is retried after its backoff, even after a 304", async () => {
    installError = new Error("download failed")
    const u = updater()
    responses = [served(manifest("1.1.0"), {etag: '"v2"'})]
    await u.check(pkg)
    installError = undefined
    now += BASE_BACKOFF_MS
    responses = [{status: 304, url: `${sourceUrl}miniapp.json`}]
    await u.check(pkg)
    expect(active[pkg]).toBe("1.1.0")
  })

  test("a release that needs hardware installs once the phone has it, even after a 304", async () => {
    const u = updater()
    const needsDisplay = {hardwareRequirements: [{type: "DISPLAY", level: "REQUIRED"}]}
    responses = [served(manifest("1.1.0", needsDisplay), {etag: '"v2"'})]
    await u.check(pkg)
    expect(installs).toHaveLength(0)
    hardware = DeviceTypes.G1
    responses = [{status: 304, url: `${sourceUrl}miniapp.json`}]
    await u.check(pkg)
    expect(installs).toHaveLength(1)
  })

  test("an update in flight when the session ends never activates, and is not a failure", async () => {
    responses = [served(manifest("1.1.0"))]
    duringInstall = () => {
      session += 1
    }
    await updater().check(pkg)
    expect(installs).toHaveLength(1)
    expect(installs[0].options.isCancelled?.()).toBe(true)
    expect(active[pkg]).toBe("1.0.0")
    expect(warnings).toHaveLength(0)
  })

  test("never downgrades or reinstalls the same version", async () => {
    responses = [served(manifest("0.9.0")), served(manifest("1.0.0"))]
    const u = updater()
    await u.checkAll()
    await u.checkAll()
    expect(installs).toHaveLength(0)
  })

  test("skips a release this phone can't run", async () => {
    responses = [served(manifest("1.1.0", {minHostVersion: "9.0.0"}))]
    await updater().checkAll()
    expect(installs).toHaveLength(0)
  })

  test("leaves development builds, manual installs and workspace pins alone", async () => {
    active = {
      [pkg]: "1.0.0",
      "com.mentra.notes": "1.0.0",
      "com.mentra.call": "1.0.0",
      "com.acme.tool": "1.0.0",
    }
    identities = {
      [pkg]: {source: "bundled_asset"},
      "com.mentra.notes": {source: "direct_download"},
      "com.mentra.call": {source: "deployment_manifest"},
      "com.acme.tool": {source: "bundled_asset"},
    }
    devSelected.add(pkg)
    await updater().checkAll()
    expect(fetched).toEqual([])
  })

  test("refuses a miniapp.json for another package or from a host that can't serve the name", async () => {
    responses = [
      served(manifest("1.1.0", {packageName: "com.mentra.notes"})),
      served(manifest("1.1.0"), {url: "https://evil.example/miniapp.json"}),
    ]
    const u = updater()
    await u.check(pkg)
    now += BASE_BACKOFF_MS
    await u.check(pkg)
    expect(installs).toHaveLength(0)
    expect(warnings).toHaveLength(2)
  })

  test("a running miniapp's update waits without counting as a failure", async () => {
    installError = new RunningError("running")
    responses = [served(manifest("1.1.0")), served(manifest("1.1.0"))]
    const u = updater()
    await u.check(pkg)
    await u.check(pkg)
    expect(installs).toHaveLength(2)
    expect(warnings).toHaveLength(0)
  })

  test("failures back off, and honor Retry-After", async () => {
    responses = [{status: 503, url: `${sourceUrl}miniapp.json`, retryAfterMs: 60 * 60_000}]
    const u = updater()
    await u.check(pkg)
    now += BASE_BACKOFF_MS
    await u.check(pkg)
    expect(fetched).toHaveLength(1)
    now += 60 * 60_000
    responses = [served(manifest("1.1.0"))]
    await u.check(pkg)
    expect(fetched).toHaveLength(2)
    expect(installs).toHaveLength(1)
  })

  test("a miniapp that just opened is checked, but not twice within a minute", async () => {
    responses = [served(manifest("1.0.0")), served(manifest("1.0.0"))]
    const u = updater()
    await u.checkOpened(pkg)
    await u.checkOpened(pkg)
    expect(fetched).toHaveLength(1)
    now += OPEN_CHECK_INTERVAL_MS
    await u.checkOpened(pkg)
    expect(fetched).toHaveLength(2)
  })

  test("concurrent checks of one miniapp share one request", async () => {
    responses = [served(manifest("1.0.0"))]
    const u = updater()
    await Promise.all([u.check(pkg), u.check(pkg)])
    expect(fetched).toHaveLength(1)
  })
})

/// <reference types="bun-types" />

import {beforeEach, describe, expect, mock, test} from "bun:test"

import type {
  RegistryRegisterRequest,
  RegistryRegisterResponse,
  RegistryStatusRequest,
  RegistryStatusResponse,
} from "@mentra/cloud-protocol/miniapp-registry"
import {normalizeMiniappUrl} from "@mentra/cloud-protocol/miniapp-url"

import type {MiniappReleaseIdentity} from "../AppRegistry"
import type {LocalBuildInstall} from "../localBuildInstall"
import type {ReleaseInstallOptions} from "../miniappReleaseInstall"
import {
  BASE_BACKOFF_MS,
  developmentReloadUrl,
  isPackageNameAllowedForUrl,
  type ManifestFetchResult,
  MAX_MANIFEST_REDIRECTS,
  MiniappUrlUpdater,
  OPEN_CHECK_INTERVAL_MS,
  parseHostedManifest,
  REGISTRY_STATUS_KEY,
  REGISTRY_STATUS_RETRY_MS,
  START_UPDATE_LIMITS,
} from "../miniappUrlUpdates"
import {cloudClientService} from "./cloudClientServiceTestMock"
import {domainRuleVectors} from "./miniappUrlVectors"

// The challenge and redirect suites run the real miniappFetch over a fake transport.
mock.module("expo/fetch", () => ({
  fetch: async () => {
    throw new Error("the tests pass their own transport")
  },
}))
const {fetchMiniappBundle, fetchMiniappJson} = await import("../miniappFetch")
type MiniappFetchTransport = import("../miniappFetch").MiniappFetchTransport
type MiniappRequestInit = import("../miniappFetch").MiniappRequestInit

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
let developmentBuilds: Set<string>
let developmentAllowed: boolean
let localInstalls: Array<{bundleUrl: string; install: LocalBuildInstall}>
let localInstallError: unknown
let localFetches: Array<{url: string; local?: boolean}>
let warnings: string[]
let session: number
let hostVersion: string
let duringInstall: ((options: ReleaseInstallOptions) => void) | undefined
let glassesLaunch: boolean
let glassesAsked: unknown[]
let requireRegistry: boolean
let core: string | null
let statusStore: Map<string, string>
let statusCalls: RegistryStatusRequest[]
let statusCores: string[]
let statusAnswer: (request: RegistryStatusRequest) => Promise<RegistryStatusResponse | null>
let registrations: RegistryRegisterRequest[]
let registerAnswer: (request: RegistryRegisterRequest) => Promise<RegistryRegisterResponse>
let moves: Array<{packageName: string; version: string; fromUrl: string; sourceUrl: string}>
/** The pins the phone holds, by package. */
let pins: Map<string, {version: string; sha256: string}>

function served(manifest: Record<string, unknown>, extra: Partial<ManifestFetchResult> = {}): ManifestFetchResult {
  return {status: 200, url: `${sourceUrl}miniapp.json`, body: JSON.stringify(manifest), ...extra}
}

function manifest(version: string, overrides: Record<string, unknown> = {}) {
  return {
    packageName: pkg,
    version,
    name: "Captions",
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
    isDevelopmentBuild: (packageName) => developmentBuilds.has(packageName),
    developmentAllowed: () => developmentAllowed,
    pinFor: (packageName) => pins.get(packageName) ?? null,
    compatibilityPolicy: () => ({
      hostVersion,
    }),
    launchesWithPairedGlasses: (hardwareRequirements) => {
      glassesAsked.push(hardwareRequirements)
      return glassesLaunch
    },
    fetchManifest: async (url, {etag, local}) => {
      fetched.push({url, etag})
      localFetches.push({url, ...(local ? {local} : {})})
      const next = responses.shift()
      if (!next) throw new Error("no response queued")
      return next
    },
    fetchBundle: async () => {
      throw new Error("no bundle download queued")
    },
    install: async (bundleUrl, options) => {
      installs.push({bundleUrl, options})
      duringInstall?.(options)
      if (options.isCancelled?.()) throw new Error("cancelled")
      if (installError) throw installError
      // As the installer: the release is the active one, recorded with the identity it was installed with.
      active[options.expectedPackageName] = options.expectedVersion
      if (options.releaseIdentity) identities[options.expectedPackageName] = {...options.releaseIdentity}
    },
    installLocal: async (bundleUrl, install) => {
      localInstalls.push({bundleUrl, install})
      if (install.isCancelled?.()) throw new Error("cancelled")
      if (localInstallError) throw localInstallError
      // As the installer: a new development build, recorded with its address and hash.
      const version = `dev-${now + localInstalls.length}`
      active[install.packageName] = version
      identities[install.packageName] = {
        source: "local",
        sourceUrl: install.sourceUrl,
        bundleSha256: install.sha256,
        ...(install.reloadUrl ? {reloadUrl: install.reloadUrl} : {}),
      }
    },
    keepVersions: async (packageName, versions) => {
      kept.push({packageName, versions})
    },
    isRunningError: (error) => error instanceof RunningError,
    installSession: () => session,
    requireRegistry: () => requireRegistry,
    registryCore: () => core,
    registryStatus: async (askedCore, request) => {
      statusCalls.push(request)
      statusCores.push(askedCore)
      return statusAnswer(request)
    },
    register: async (request) => {
      registrations.push(request)
      return registerAnswer(request)
    },
    statusStore: {
      get: () => statusStore.get(REGISTRY_STATUS_KEY),
      set: (value) => {
        statusStore.set(REGISTRY_STATUS_KEY, value)
      },
    },
    setReleaseSourceUrl: (packageName, version, fromUrl, sourceUrl) => {
      const identity = identities[packageName]
      if (identity?.source !== "url" || identity.sourceUrl !== fromUrl) return false
      moves.push({packageName, version, fromUrl, sourceUrl})
      identities[packageName] = {...identity, sourceUrl}
      return true
    },
    now: () => now,
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
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
  developmentBuilds = new Set()
  developmentAllowed = true
  localInstalls = []
  localInstallError = undefined
  localFetches = []
  warnings = []
  session = 1
  hostVersion = "3.3.0"
  duringInstall = undefined
  glassesLaunch = true
  glassesAsked = []
  requireRegistry = true
  core = "https://core.example.com"
  statusStore = new Map()
  statusCalls = []
  statusCores = []
  statusAnswer = async (request) => ({
    statuses: request.entries.map((entry) => ({url: entry.url, status: "active" as const})),
    validForSeconds: 21_600,
  })
  registrations = []
  registerAnswer = async () => {
    throw new Error("Core can't be reached")
  }
  moves = []
  pins = new Map()
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

  test("other names come from the domain that owns them", () => {
    expect(isPackageNameAllowedForUrl("com.example.notes", "https://notes.example.com/")).toBe(true)
    expect(isPackageNameAllowedForUrl("io.github.alice.notes", "https://alice.github.io/notes/")).toBe(true)
    expect(isPackageNameAllowedForUrl("com.example.notes", "https://notes.example.org/")).toBe(false)
  })

  // The vectors Core's tests read too, so both refuse the same names.
  test.each(domainRuleVectors().map((vector) => [vector.packageName, vector.url, vector.allowed] as const))(
    "%p from %p: %p",
    (packageName, url, allowed) => {
      expect(isPackageNameAllowedForUrl(packageName, url)).toBe(allowed)
    },
  )

  test.each(
    domainRuleVectors()
      .filter((vector) => normalizeMiniappUrl(vector.url)?.kind === "public")
      .map((vector) => [vector.packageName, vector.url, vector.allowed] as const),
  )("a miniapp installed as %p from %p is checked for updates: %p", async (packageName, url, allowed) => {
    const sourceUrl = normalizeMiniappUrl(url)!.url
    active = {[packageName]: "1.0.0"}
    identities = {[packageName]: {source: "url", sourceUrl}}
    responses = [{status: 304, url: `${sourceUrl}miniapp.json`}]
    await new MiniappUrlUpdater({...updaterDeps(), isSystemPackage: () => false}).checkAll()
    expect(fetched.map((call) => call.url)).toEqual(allowed ? [`${sourceUrl}miniapp.json`] : [])
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
    ["no name", {name: undefined}],
    ["an unknown age rating", {ageRating: "21+"}],
  ])("is refused for %s", (_name, overrides) => {
    expect(() => parseHostedManifest(JSON.stringify(manifest("1.2.0", overrides)), pkg)).toThrow()
  })
})

describe("a check before a miniapp starts", () => {
  test("installs a newer release while the miniapp is stopped, before it resolves", async () => {
    responses = [served(manifest("1.1.0"))]
    await updater().checkBeforeStart(pkg, {checkMs: 1000, installMs: 1000})
    expect(installs).toHaveLength(1)
    expect(active[pkg]).toBe("1.1.0")
  })

  test("resolves at once for a miniapp already up to date", async () => {
    responses = [served(manifest("1.0.0"))]
    const started = performance.now()
    await updater().checkBeforeStart(pkg, {checkMs: 1000, installMs: 1000})
    expect(performance.now() - started).toBeLessThan(500)
    expect(installs).toHaveLength(0)
  })

  test("stops waiting for a host that doesn't answer, and installs nothing", async () => {
    const u = new MiniappUrlUpdater({...updaterDeps(), fetchManifest: () => new Promise(() => {})})
    const started = performance.now()
    await u.checkBeforeStart(pkg, {checkMs: 30, installMs: 5000})
    expect(performance.now() - started).toBeLessThan(1000)
    expect(installs).toHaveLength(0)
  })

  test("once a newer release installs, waits for it longer than the check's own limit, then no longer", async () => {
    responses = [served(manifest("1.1.0"))]
    let finish!: () => void
    const u = new MiniappUrlUpdater({
      ...updaterDeps(),
      install: (bundleUrl, options) => {
        installs.push({bundleUrl, options})
        return new Promise<void>((resolve) => {
          finish = resolve
        })
      },
    })
    let resolved = false
    const check = u.checkBeforeStart(pkg, {checkMs: 20, installMs: 5000}).then(() => {
      resolved = true
    })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(installs).toHaveLength(1)
    expect(resolved).toBe(false)
    finish()
    await check
    expect(resolved).toBe(true)

    // An install that outlasts its own limit too: the miniapp starts as it is.
    responses = [served(manifest("1.2.0"))]
    const stuck = new MiniappUrlUpdater({...updaterDeps(), install: () => new Promise<void>(() => {})})
    const started = performance.now()
    await stuck.checkBeforeStart(pkg, {checkMs: 20, installMs: 40})
    expect(performance.now() - started).toBeLessThan(1000)
  })

  test("waits 5 seconds at most to find another build, and 30 more for it to install", () => {
    expect(START_UPDATE_LIMITS).toEqual({checkMs: 5_000, installMs: 30_000})
  })

  test("says when it found another build and waits for it to install, and says nothing for a check that finds none", async () => {
    let found = 0
    responses = [served(manifest("1.0.0"))]
    await updater().checkBeforeStart(pkg, {checkMs: 1000, installMs: 1000}, () => found++)
    expect(found).toBe(0)
    responses = [served(manifest("1.1.0"))]
    await updater().checkBeforeStart(pkg, {checkMs: 1000, installMs: 1000}, () => found++)
    expect(found).toBe(1)
    expect(active[pkg]).toBe("1.1.0")
  })

  test("a check past its limit carries on: the build installs once the host answers", async () => {
    let answer!: (result: ManifestFetchResult) => void
    const u = new MiniappUrlUpdater({
      ...updaterDeps(),
      fetchManifest: () =>
        new Promise<ManifestFetchResult>((resolve) => {
          answer = resolve
        }),
    })
    await u.checkBeforeStart(pkg, {checkMs: 20, installMs: 5000})
    expect(installs).toHaveLength(0)
    answer(served(manifest("1.1.0")))
    await u.check(pkg)
    expect(installs).toHaveLength(1)
    expect(active[pkg]).toBe("1.1.0")
  })

  test.each([
    ["a miniapp with no URL to update from", () => ({firstPartyUrl: () => undefined})],
    ["a release while the person's development build of it is installed", () => ({isDevelopmentBuild: () => true})],
    [
      "a miniapp whose release a deployment manifest manages",
      () => ({
        isSystemPackage: () => false,
        releaseIdentity: () => ({source: "deployment_manifest"} as MiniappReleaseIdentity),
      }),
    ],
  ])("has nothing to wait for with %s: it asks its host nothing", async (_name, overrides) => {
    let requests = 0
    const u = new MiniappUrlUpdater({
      ...updaterDeps(),
      ...overrides(),
      fetchManifest: () => {
        requests++
        return new Promise(() => {})
      },
    })
    const started = performance.now()
    await u.checkBeforeStart(pkg, {checkMs: 5000, installMs: 5000})
    expect(performance.now() - started).toBeLessThan(500)
    expect(requests).toBe(0)
  })

  test("doesn't wait for a second check within a minute", async () => {
    responses = [served(manifest("1.0.0")), served(manifest("1.0.0"))]
    const u = updater()
    await u.checkBeforeStart(pkg, {checkMs: 1000, installMs: 1000})
    await u.checkBeforeStart(pkg, {checkMs: 1000, installMs: 1000})
    expect(fetched).toHaveLength(1)
    now += OPEN_CHECK_INTERVAL_MS
    await u.checkBeforeStart(pkg, {checkMs: 1000, installMs: 1000})
    expect(fetched).toHaveLength(2)
  })

  test("doesn't wait either when a background pass checked it within the minute", async () => {
    responses = [served(manifest("1.0.0"))]
    const u = updater()
    await u.checkAll()
    await u.checkBeforeStart(pkg, {checkMs: 1000, installMs: 1000})
    expect(fetched).toHaveLength(1)
  })

  test("doesn't wait while its last check failed and the retry time hasn't come", async () => {
    let requests = 0
    let hang = false
    const u = new MiniappUrlUpdater({
      ...updaterDeps(),
      fetchManifest: async () => {
        requests++
        if (hang) await new Promise(() => {})
        throw new Error("offline")
      },
    })
    await u.checkBeforeStart(pkg, {checkMs: 1000, installMs: 1000})
    expect(requests).toBe(1)
    expect(warnings).toHaveLength(1)

    // A minute later the host is still down: a start costs nothing, where a new check would hang for its limit.
    hang = true
    now += OPEN_CHECK_INTERVAL_MS
    const started = performance.now()
    await u.checkBeforeStart(pkg, {checkMs: 1000, installMs: 1000})
    expect(performance.now() - started).toBeLessThan(500)
    expect(requests).toBe(1)

    // Once the retry time has come, a start waits for a check again.
    hang = false
    now += BASE_BACKOFF_MS
    await u.checkBeforeStart(pkg, {checkMs: 1000, installMs: 1000})
    expect(requests).toBe(2)
  })

  test("joins a background check under way, and waits for the build it is installing", async () => {
    responses = [served(manifest("1.1.0"), {etag: '"v2"'})]
    let finish!: () => void
    const u = new MiniappUrlUpdater({
      ...updaterDeps(),
      install: async (bundleUrl, options) => {
        installs.push({bundleUrl, options})
        await new Promise<void>((resolve) => {
          finish = resolve
        })
        active[options.expectedPackageName] = options.expectedVersion
      },
    })
    const pass = u.checkAll()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(installs).toHaveLength(1)
    let found = 0
    let started = false
    const start = u
      .checkBeforeStart(pkg, {checkMs: 1000, installMs: 5000}, () => found++)
      .then(() => {
        started = true
      })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(found).toBe(1)
    expect(started).toBe(false)
    finish()
    await Promise.all([pass, start])
    expect(active[pkg]).toBe("1.1.0")
    expect(fetched).toHaveLength(1)
    expect(installs).toHaveLength(1)
  })

  test("keeps the build it has when the paired glasses can't launch the served one, which installs on a later check", async () => {
    glassesLaunch = false
    responses = [served(manifest("1.1.0", {hardwareRequirements: [{type: "DISPLAY", level: "REQUIRED"}]}))]
    const u = updater()
    let found = 0
    await u.checkBeforeStart(pkg, {checkMs: 1000, installMs: 1000}, () => found++)
    expect(found).toBe(0)
    expect(installs).toHaveLength(0)
    expect(warnings).toHaveLength(0)

    // Not about to start any more: hardware requirements never stop an update of a miniapp that is stopped.
    responses = [served(manifest("1.1.0", {hardwareRequirements: [{type: "DISPLAY", level: "REQUIRED"}]}))]
    await u.check(pkg)
    expect(installs).toHaveLength(1)
    expect(active[pkg]).toBe("1.1.0")
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

  test("a pass and a check of one miniapp alike ask about a running miniapp whose release launches with the paired glasses", async () => {
    responses = [served(manifest("1.1.0", {hardwareRequirements: [{type: "CAMERA", level: "REQUIRED"}]}))]
    responses.push(responses[0]!)
    installError = new RunningError("running")
    const u = updater()
    await u.checkAll()
    await u.check(pkg)
    expect(installs.map((install) => install.options.askIfRunning)).toEqual([true, true])
    expect(glassesAsked).toEqual([[{type: "CAMERA", level: "REQUIRED"}], [{type: "CAMERA", level: "REQUIRED"}]])
  })

  test("a release the paired glasses can't launch is not asked about: it waits for the miniapp to stop", async () => {
    glassesLaunch = false
    responses = [served(manifest("1.1.0"))]
    installError = new RunningError("running")
    await updater().checkAll()
    expect(installs.map((install) => install.options.askIfRunning)).toEqual([false])
    expect(warnings).toHaveLength(0)
  })

  test("a check of one miniapp during a background pass's check of it shares that check", async () => {
    installError = new RunningError("running")
    responses = [served(manifest("1.1.0"), {etag: '"v2"'})]
    const u = updater()
    let second: Promise<void> | undefined
    duringInstall = () => {
      duringInstall = undefined
      second = u.check(pkg)
    }
    await u.checkAll()
    await second
    expect(fetched).toHaveLength(1)
    expect(installs).toHaveLength(1)
  })

  test("a pass checks first the miniapp whose update waited for it to stop, or for an answer", async () => {
    const notes = "com.mentra.notes"
    active = {[pkg]: "1.0.0", [notes]: "1.0.0"}
    identities = {[pkg]: {source: "bundled_asset"}, [notes]: {source: "bundled_asset"}}
    const servedNotes = () =>
      served(manifest("1.1.0", {packageName: notes, bundle: {url: `${notes}-1.1.0.zip`, sha256: sha}}), {
        url: `${host}${notes}/miniapp.json`,
      })
    const u = new MiniappUrlUpdater({
      ...updaterDeps(),
      fetchManifest: async (url) => {
        fetched.push({url})
        return url.includes(notes) ? servedNotes() : served(manifest("1.0.0"))
      },
    })
    // Notes runs: its update waits.
    installError = new RunningError("running")
    await u.checkAll()
    expect(fetched.map((call) => call.url)).toEqual([`${sourceUrl}miniapp.json`, `${host}${notes}/miniapp.json`])

    // It stopped, or was opened again after Not now: the pass that follows starts with it.
    fetched = []
    installError = undefined
    await u.checkAll()
    expect(fetched.map((call) => call.url)).toEqual([`${host}${notes}/miniapp.json`, `${sourceUrl}miniapp.json`])
    expect(active[notes]).toBe("1.1.0")

    // Updated, it is checked in its turn again.
    fetched = []
    await u.checkAll()
    expect(fetched.map((call) => call.url)).toEqual([`${sourceUrl}miniapp.json`, `${host}${notes}/miniapp.json`])
  })

  test("a pass moves on while a prompt waits for the person's answer", async () => {
    const notes = "com.mentra.notes"
    active = {[pkg]: "1.0.0", [notes]: "1.0.0"}
    identities = {[pkg]: {source: "bundled_asset"}, [notes]: {source: "bundled_asset"}}
    responses = [
      served(manifest("1.1.0")),
      served(manifest("1.1.0", {packageName: notes, bundle: {url: `${notes}-1.1.0.zip`, sha256: sha}}), {
        url: `${host}${notes}/miniapp.json`,
      }),
    ]
    let answer: () => void = () => {}
    const u = new MiniappUrlUpdater({
      ...updaterDeps(),
      install: async (bundleUrl, options) => {
        installs.push({bundleUrl, options})
        if (options.expectedPackageName === pkg) {
          options.onAsking?.()
          await new Promise<void>((resolve) => {
            answer = resolve
          })
        }
        active[options.expectedPackageName] = options.expectedVersion
      },
    })
    await u.checkAll()
    expect(active).toEqual({[pkg]: "1.0.0", [notes]: "1.1.0"})
    answer()
    await u.check(pkg)
    expect(active[pkg]).toBe("1.1.0")
  })

  test("an update that waited for a running miniapp is checked again the next time it starts, even within a minute", async () => {
    installError = new RunningError("running")
    responses = [served(manifest("1.1.0"), {etag: '"v2"'}), {status: 304, url: `${sourceUrl}miniapp.json`}]
    const u = updater()
    await u.check(pkg)
    // It has stopped since, and starts again: the start waits for the update that waited for it.
    installError = undefined
    await u.checkBeforeStart(pkg, {checkMs: 1000, installMs: 1000})
    expect(fetched).toHaveLength(2)
    expect(installs).toHaveLength(2)
    expect(active[pkg]).toBe("1.1.0")
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

  test("a release that needs hardware installs with no glasses paired: hardware describes the glasses", async () => {
    const needsDisplay = {hardwareRequirements: [{type: "DISPLAY", level: "REQUIRED"}]}
    responses = [served(manifest("1.1.0", needsDisplay))]
    await updater().check(pkg)
    expect(installs).toHaveLength(1)
    expect(active[pkg]).toBe("1.1.0")
  })

  test("a release that needs a newer Mentra App waits, and installs once the phone has it, even after a 304", async () => {
    const u = updater()
    responses = [served(manifest("1.1.0", {minHostVersion: "3.5.0"}), {etag: '"v2"'})]
    await u.check(pkg)
    expect(installs).toHaveLength(0)
    hostVersion = "3.5.0"
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

  test("a pass stops when its session ends, before the next miniapp", async () => {
    active = {[pkg]: "1.0.0", "com.mentra.notes": "1.0.0"}
    identities = {[pkg]: {source: "bundled_asset"}, "com.mentra.notes": {source: "bundled_asset"}}
    responses = [served(manifest("1.1.0")), served(manifest("1.1.0", {packageName: "com.mentra.notes"}))]
    duringInstall = () => {
      session += 1
    }
    await updater().checkAll()
    expect(fetched.map((call) => call.url)).toEqual([`${sourceUrl}miniapp.json`])
    expect(active).toEqual({[pkg]: "1.0.0", "com.mentra.notes": "1.0.0"})
  })

  test("a check from an ended session isn't shared with the next session", async () => {
    responses = [served(manifest("1.1.0")), served(manifest("1.1.0"))]
    const u = updater()
    const first = u.check(pkg)
    session += 1
    await Promise.all([first, u.check(pkg)])
    // The first check stops before it fetches anything; the new session's own check installs.
    expect(fetched).toHaveLength(1)
    expect(installs.map((install) => install.options.isCancelled?.())).toEqual([false])
    expect(active[pkg]).toBe("1.1.0")
  })

  test("an install that keeps failing backs off further each time", async () => {
    installError = new Error("download failed")
    const u = updater()
    responses = [served(manifest("1.1.0")), served(manifest("1.1.0")), served(manifest("1.1.0"))]
    await u.check(pkg)
    now += BASE_BACKOFF_MS
    await u.check(pkg)
    now += BASE_BACKOFF_MS
    await u.check(pkg)
    expect(installs).toHaveLength(2)
    now += BASE_BACKOFF_MS
    await u.check(pkg)
    expect(installs).toHaveLength(3)
  })

  test("other bytes under the installed version install, with no version bump", async () => {
    identities[pkg] = {source: "url", sourceUrl, bundleSha256: "a".repeat(64)}
    responses = [served(manifest("1.0.0"))]
    await updater().checkAll()
    expect(installs).toHaveLength(1)
    expect(installs[0].options).toMatchObject({expectedVersion: "1.0.0", expectedBundleSha256: sha})
    expect(identities[pkg]?.bundleSha256).toBe(sha)
    // The build replaces its own version's files: nothing else is kept.
    expect(kept).toEqual([{packageName: pkg, versions: ["1.0.0", "1.0.0"]}])
  })

  test("a lower version installs like any other: the publisher rolled back", async () => {
    active[pkg] = "1.1.0"
    identities[pkg] = {source: "url", sourceUrl, bundleSha256: "a".repeat(64)}
    responses = [served(manifest("1.0.0"))]
    await updater().checkAll()
    expect(installs).toHaveLength(1)
    expect(installs[0].options).toMatchObject({expectedVersion: "1.0.0", expectedBundleSha256: sha})
    expect(active[pkg]).toBe("1.0.0")
    expect(kept).toEqual([{packageName: pkg, versions: ["1.0.0", "1.1.0"]}])
  })

  test("the build already installed never installs again, whatever version the URL says it is", async () => {
    identities[pkg] = {source: "url", sourceUrl, bundleSha256: sha}
    responses = [served(manifest("1.0.0")), served(manifest("0.9.0")), served(manifest("1.1.0"))]
    const u = updater()
    await u.checkAll()
    await u.checkAll()
    await u.checkAll()
    expect(fetched).toHaveLength(3)
    expect(installs).toHaveLength(0)
  })

  test("an update installs once: the next check finds the build it installed", async () => {
    identities[pkg] = {source: "url", sourceUrl, bundleSha256: "a".repeat(64)}
    responses = [served(manifest("1.0.0")), served(manifest("1.0.0"))]
    const u = updater()
    await u.checkAll()
    await u.checkAll()
    expect(fetched).toHaveLength(2)
    expect(installs).toHaveLength(1)
  })

  test("a release with no recorded hash counts as what its URL serves at the same version", async () => {
    identities[pkg] = {source: "url", sourceUrl}
    responses = [served(manifest("1.0.0"))]
    await updater().checkAll()
    expect(installs).toHaveLength(0)
  })

  test("a release with no recorded hash updates when the served version differs, up or down", async () => {
    identities[pkg] = {source: "bundled_asset"}
    responses = [served(manifest("0.9.0"))]
    await updater().checkAll()
    expect(installs.map((install) => install.options.expectedVersion)).toEqual(["0.9.0"])

    installs = []
    active[pkg] = "1.0.0"
    identities[pkg] = {source: "bundled_asset"}
    responses = [served(manifest("1.1.0"))]
    await updater().checkAll()
    expect(installs.map((install) => install.options.expectedVersion)).toEqual(["1.1.0"])
  })

  test("a failed install of other bytes under the installed version backs off, and is retried", async () => {
    identities[pkg] = {source: "url", sourceUrl, bundleSha256: "a".repeat(64)}
    installError = new Error("download failed")
    const u = updater()
    responses = [served(manifest("1.0.0")), served(manifest("1.0.0"))]
    await u.check(pkg)
    await u.check(pkg)
    expect(installs).toHaveLength(1)
    installError = undefined
    now += BASE_BACKOFF_MS
    await u.check(pkg)
    expect(installs).toHaveLength(2)
    expect(identities[pkg]?.bundleSha256).toBe(sha)
  })

  test("skips a release this phone can't run", async () => {
    responses = [served(manifest("1.1.0", {minHostVersion: "9.0.0"}))]
    await updater().checkAll()
    expect(installs).toHaveLength(0)
  })

  test("skips, before downloading it, a release built at a Miniapp SDK API level this app doesn't run", async () => {
    responses = [served(manifest("1.1.0", {minApiLevel: 1_000}))]
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
    developmentBuilds.add(pkg)
    await updater().checkAll()
    expect(fetched).toEqual([])
  })

  test("a bundled miniapp the retired Store updated updates from its first-party URL, and becomes a URL install", async () => {
    identities[pkg] = {source: "system_store", storePackageName: "com.mentra.store"}
    responses = [served(manifest("1.1.0"))]
    await updater().checkAll()
    expect(fetched).toEqual([{url: `${sourceUrl}miniapp.json`, etag: undefined}])
    expect(installs).toHaveLength(1)
    expect(installs[0].options.releaseIdentity).toEqual({source: "url", sourceUrl, bundleSha256: sha})
  })

  test("a third-party release a Store installed has no URL to update from", async () => {
    active = {"com.acme.weather": "1.0.0"}
    identities = {"com.acme.weather": {source: "store", storePackageName: "com.mentra.store"}}
    await updater().checkAll()
    expect(fetched).toEqual([])
  })

  test("follows a redirect to another host on the same domain", async () => {
    responses = [served(manifest("1.1.0"), {url: `https://cdn.mentraglass.com/${pkg}/miniapp.json`})]
    await updater().check(pkg)
    expect(installs.map((install) => install.bundleUrl)).toEqual([
      `https://cdn.mentraglass.com/${pkg}/${pkg}-1.1.0.zip`,
    ])
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

  test("concurrent checks of one miniapp share one request", async () => {
    responses = [served(manifest("1.0.0"))]
    const u = updater()
    await Promise.all([u.check(pkg), u.check(pkg)])
    expect(fetched).toHaveLength(1)
  })
})

// ---- Registry status ---------------------------------------------------------------------------------------------

const acme = "com.acme.tools"
const acmeUrl = "https://tools.acme.com/app/"

function acmeManifest(version: string, overrides: Record<string, unknown> = {}) {
  return manifest(version, {
    packageName: acme,
    name: "Acme Tools",
    bundle: {url: `${acme}-${version}.zip`, sha256: sha},
    ...overrides,
  })
}

/** Captions (bundled, from Mentra's host) and Acme Tools (installed from its own URL), both at 1.0.0. */
function installBoth(): void {
  active = {[pkg]: "1.0.0", [acme]: "1.0.0"}
  identities = {[pkg]: {source: "bundled_asset"}, [acme]: {source: "url", sourceUrl: acmeUrl}}
}

function answer(statuses: Record<string, "active" | "archived" | "unknown">, validForSeconds = 21_600) {
  return async (request: RegistryStatusRequest): Promise<RegistryStatusResponse> => ({
    statuses: request.entries.map((entry) => ({url: entry.url, status: statuses[entry.url] ?? "unknown"})),
    validForSeconds,
  })
}

describe("a pinned miniapp", () => {
  const OLD = "0".repeat(64)
  const OTHER = "e".repeat(64)
  const listed = (latest: string, latestSha = sha) => [
    {version: latest, url: `${pkg}-${latest}.zip`, sha256: latestSha},
    {version: "1.0.0", url: `old/${pkg}-1.0.0.zip`, sha256: OLD},
  ]
  // A miniapp that updates from its own recorded URL: the one an assignment's pin is sealed against.
  const ownUrl = () => new MiniappUrlUpdater({...updaterDeps(), isSystemPackage: () => false})

  beforeEach(() => {
    active[pkg] = "1.1.0"
    identities[pkg] = {source: "url", sourceUrl, bundleSha256: "a".repeat(64)}
    pins.set(pkg, {version: "1.0.0", sha256: OLD})
  })

  test("installs the pinned version's entry, older than what is installed, and its hash is checked", async () => {
    responses = [served(manifest("1.2.0", {versions: listed("1.2.0")}))]
    await ownUrl().checkAll()
    expect(installs).toHaveLength(1)
    expect(installs[0].bundleUrl).toBe(`${sourceUrl}old/${pkg}-1.0.0.zip`)
    expect(installs[0].options).toMatchObject({
      expectedVersion: "1.0.0",
      expectedBundleSha256: OLD,
      releaseIdentity: {source: "url", sourceUrl, bundleSha256: OLD},
    })
    expect(active[pkg]).toBe("1.0.0")
    expect(kept).toEqual([{packageName: pkg, versions: ["1.0.0", "1.1.0"]}])
  })

  test("stays on the pinned build while latest changes", async () => {
    active[pkg] = "1.0.0"
    identities[pkg] = {source: "url", sourceUrl, bundleSha256: OLD}
    responses = [
      served(manifest("1.2.0", {versions: listed("1.2.0")})),
      served(manifest("1.3.0", {bundle: {url: "x.zip", sha256: OTHER}, versions: listed("1.3.0", OTHER)})),
    ]
    const u = ownUrl()
    await u.checkAll()
    await u.checkAll()
    expect(fetched).toHaveLength(2)
    expect(installs).toHaveLength(0)
  })

  test.each([
    ["no longer lists the version", () => [{version: "1.2.0", url: "x.zip", sha256: sha}]],
    ["lists it with other bytes", () => [{version: "1.0.0", url: "x.zip", sha256: OTHER}]],
    ["lists no versions", () => undefined],
  ])("installs nothing and keeps the installed build when the URL %s, and doesn't back off", async (_why, versions) => {
    responses = [served(manifest("1.2.0", {versions: versions()})), served(manifest("1.2.0", {versions: versions()}))]
    const u = ownUrl()
    await u.checkAll()
    expect(installs).toHaveLength(0)
    expect(active[pkg]).toBe("1.1.0")
    expect(warnings).toEqual([])
    // Not a failure: the next check asks again at once.
    await u.check(pkg)
    expect(fetched).toHaveLength(2)
  })

  test("the served file's compatibility and hardware fields describe latest, so they don't hold the pinned build back", async () => {
    glassesLaunch = false
    hostVersion = "3.0.0"
    const latestNeeds = {minHostVersion: "9.0.0", hardwareRequirements: [{type: "DISPLAY", level: "REQUIRED"}]}
    responses = [served(manifest("1.2.0", {...latestNeeds, versions: listed("1.2.0")}))]
    await ownUrl().checkBeforeStart(pkg, {checkMs: 1000, installMs: 1000})
    expect(installs).toHaveLength(1)
    // The installer checks the ZIP's own manifest, and asks a running miniapp only once that passes.
    expect(installs[0].options).toMatchObject({expectedVersion: "1.0.0", askIfRunning: true})
    expect(glassesAsked).toEqual([])
  })

  test("opening it waits for the check, which installs the pinned build, not latest", async () => {
    responses = [served(manifest("1.2.0", {versions: listed("1.2.0")}))]
    let found = 0
    await ownUrl().checkBeforeStart(pkg, {checkMs: 1000, installMs: 1000}, () => found++)
    expect(found).toBe(1)
    expect(active[pkg]).toBe("1.0.0")
    expect(installs[0].options.expectedBundleSha256).toBe(OLD)
  })

  test("once the pin is removed, the next check installs latest", async () => {
    active[pkg] = "1.0.0"
    identities[pkg] = {source: "url", sourceUrl, bundleSha256: OLD}
    pins.delete(pkg)
    responses = [served(manifest("1.2.0", {versions: listed("1.2.0")}))]
    await ownUrl().checkAll()
    expect(installs[0].options).toMatchObject({expectedVersion: "1.2.0", expectedBundleSha256: sha})
  })

  test("has no effect on a system miniapp, which updates from its deployment's host", async () => {
    identities[pkg] = {source: "bundled_asset"}
    responses = [served(manifest("1.2.0", {versions: listed("1.2.0")}))]
    await updater().checkAll()
    expect(installs[0].options).toMatchObject({expectedVersion: "1.2.0", expectedBundleSha256: sha})
  })
})

function keep(stored: {core?: string; fetchedAt?: number; validForSeconds?: number; statuses: Record<string, string>}) {
  statusStore.set(REGISTRY_STATUS_KEY, JSON.stringify({core: core, fetchedAt: now, validForSeconds: 21_600, ...stored}))
}

describe("the registry status", () => {
  test("one call covers every installed URL, and its answer is kept for as long as Core says", async () => {
    installBoth()
    statusAnswer = answer({[sourceUrl]: "active", [acmeUrl]: "active"}, 3600)
    const u = updater()
    responses = [served(manifest("1.0.0")), served(acmeManifest("1.0.0"), {url: `${acmeUrl}miniapp.json`})]
    await u.checkAll()
    expect(statusCalls).toEqual([
      {
        entries: [
          {url: sourceUrl, version: "1.0.0"},
          {url: acmeUrl, version: "1.0.0"},
        ],
      },
    ])
    expect(JSON.parse(statusStore.get(REGISTRY_STATUS_KEY)!)).toEqual({
      core: "https://core.example.com",
      fetchedAt: now,
      validForSeconds: 3600,
      statuses: {[sourceUrl]: "active", [acmeUrl]: "active"},
    })

    // Still valid: no call, here or in an updater that starts from what was kept.
    now += 59 * 60_000
    responses = [served(manifest("1.0.0")), served(acmeManifest("1.0.0"), {url: `${acmeUrl}miniapp.json`})]
    await u.checkAll()
    responses = [served(manifest("1.0.0")), served(acmeManifest("1.0.0"), {url: `${acmeUrl}miniapp.json`})]
    await updater().checkAll()
    expect(statusCalls).toHaveLength(1)

    // Expired: the next check asks again.
    now += 60_000
    responses = [served(manifest("1.0.0"))]
    await u.check(pkg)
    expect(statusCalls).toHaveLength(2)
  })

  test("an archived URL is never fetched or updated; the other miniapps update", async () => {
    installBoth()
    statusAnswer = answer({[sourceUrl]: "active", [acmeUrl]: "archived"})
    responses = [served(manifest("1.1.0"))]
    await updater().checkAll()
    expect(fetched.map((call) => call.url)).toEqual([`${sourceUrl}miniapp.json`])
    expect(active).toEqual({[pkg]: "1.1.0", [acme]: "1.0.0"})
    expect(warnings).toEqual([])
  })

  test("an archived miniapp that is about to start isn't checked either", async () => {
    installBoth()
    statusAnswer = answer({[acmeUrl]: "archived"})
    await updater().checkBeforeStart(acme, {checkMs: 1000, installMs: 1000})
    expect(fetched).toEqual([])
  })

  test("a URL Core doesn't know updates", async () => {
    installBoth()
    statusAnswer = answer({})
    responses = [served(manifest("1.0.0")), served(acmeManifest("1.1.0"), {url: `${acmeUrl}miniapp.json`})]
    await updater().checkAll()
    expect(active[acme]).toBe("1.1.0")
  })

  test("Core can't be reached: the check carries on with the kept answer, and asks again later", async () => {
    installBoth()
    keep({fetchedAt: now - 7 * 60 * 60_000, statuses: {[acmeUrl]: "archived"}})
    statusAnswer = async () => {
      throw new Error("Core can't be reached")
    }
    responses = [served(manifest("1.1.0"))]
    const u = updater()
    await u.checkAll()
    expect(statusCalls).toHaveLength(1)
    expect(fetched.map((call) => call.url)).toEqual([`${sourceUrl}miniapp.json`])
    expect(active[pkg]).toBe("1.1.0")

    // Not again straight away, and the kept answer still holds.
    now += OPEN_CHECK_INTERVAL_MS
    await u.check(acme)
    expect(statusCalls).toHaveLength(1)
    expect(fetched).toHaveLength(1)

    // Later it asks again; Core's new answer lifts the archive.
    now += REGISTRY_STATUS_RETRY_MS
    statusAnswer = answer({[acmeUrl]: "active"})
    responses = [served(acmeManifest("1.1.0"), {url: `${acmeUrl}miniapp.json`})]
    await u.check(acme)
    expect(statusCalls).toHaveLength(2)
    expect(active[acme]).toBe("1.1.0")
  })

  test("Core can't be reached and nothing is kept: miniapps update", async () => {
    installBoth()
    statusAnswer = async () => {
      throw new Error("Core can't be reached")
    }
    responses = [served(manifest("1.0.0")), served(acmeManifest("1.1.0"), {url: `${acmeUrl}miniapp.json`})]
    await updater().checkAll()
    expect(active[acme]).toBe("1.1.0")
  })

  test("concurrent checks share one status call", async () => {
    installBoth()
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    statusAnswer = async (request) => {
      await held
      return answer({})(request)
    }
    responses = [served(manifest("1.0.0")), served(acmeManifest("1.0.0"), {url: `${acmeUrl}miniapp.json`})]
    const u = updater()
    const checks = Promise.all([u.check(pkg), u.check(acme)])
    release()
    await checks
    expect(statusCalls).toHaveLength(1)
  })

  test("an answer from another Core isn't used", async () => {
    installBoth()
    keep({core: "https://other-core.example.com", statuses: {[acmeUrl]: "archived"}})
    statusAnswer = async () => {
      throw new Error("Core can't be reached")
    }
    responses = [served(acmeManifest("1.1.0"), {url: `${acmeUrl}miniapp.json`})]
    await updater().check(acme)
    expect(active[acme]).toBe("1.1.0")
  })

  test("without a Core, nothing is asked and nothing kept applies", async () => {
    installBoth()
    keep({statuses: {[acmeUrl]: "archived"}})
    core = null
    responses = [served(acmeManifest("1.1.0"), {url: `${acmeUrl}miniapp.json`})]
    await updater().check(acme)
    expect(statusCalls).toEqual([])
    expect(active[acme]).toBe("1.1.0")
  })

  test("with requireRegistry off, nothing calls the registry and nothing counts as archived", async () => {
    installBoth()
    keep({statuses: {[acmeUrl]: "archived"}})
    requireRegistry = false
    responses = [served(acmeManifest("1.1.0"), {url: `${acmeUrl}miniapp.json`})]
    await updater().check(acme)
    expect(statusCalls).toEqual([])
    expect(active[acme]).toBe("1.1.0")
  })

  test("a kept answer that can't be read is ignored", async () => {
    installBoth()
    statusStore.set(REGISTRY_STATUS_KEY, "{not json")
    statusAnswer = answer({[acmeUrl]: "archived"})
    await updater().check(acme)
    expect(statusCalls).toHaveLength(1)
    expect(fetched).toEqual([])
  })

  test("a clock that went back expires the kept answer", async () => {
    installBoth()
    keep({fetchedAt: now + 60_000, statuses: {}})
    statusAnswer = answer({[acmeUrl]: "archived"})
    await updater().check(acme)
    expect(statusCalls).toHaveLength(1)
    expect(fetched).toEqual([])
  })

  test("a local-network build is never asked about or updated from its URL", async () => {
    active = {[acme]: "1.0.0", [pkg]: "1.0.0"}
    identities = {[acme]: {source: "local", sourceUrl: "http://192.168.1.20:8080/"}, [pkg]: {source: "bundled_asset"}}
    responses = [served(manifest("1.0.0"))]
    await updater().checkAll()
    expect(statusCalls).toEqual([{entries: [{url: sourceUrl, version: "1.0.0"}]}])
    expect(fetched.map((call) => call.url)).toEqual([`${sourceUrl}miniapp.json`])
  })

  test("each call asks the Core in use, and the answer is kept as that Core's", async () => {
    installBoth()
    statusAnswer = answer({[acmeUrl]: "archived"})
    await updater().check(acme)
    expect(statusCores).toEqual(["https://core.example.com"])
    expect(JSON.parse(statusStore.get(REGISTRY_STATUS_KEY)!).core).toBe("https://core.example.com")
  })

  test("no client speaking for the Core yet: nothing is kept, and the next check asks again at once", async () => {
    installBoth()
    statusAnswer = async () => null
    responses = [served(acmeManifest("1.0.0"), {url: `${acmeUrl}miniapp.json`})]
    const u = updater()
    await u.check(acme)
    expect(statusStore.has(REGISTRY_STATUS_KEY)).toBe(false)
    expect(warnings).toEqual([])
    statusAnswer = answer({[acmeUrl]: "archived"})
    now += OPEN_CHECK_INTERVAL_MS
    await u.check(acme)
    expect(statusCalls).toHaveLength(2)
    expect(fetched).toHaveLength(1)
  })

  test("a Core switch during a refresh discards its answer, and the new Core is asked at once", async () => {
    installBoth()
    // The deployment switches while the first Core's answer is on its way.
    statusAnswer = async (request) => {
      core = "https://other-core.example.com"
      return answer({[acmeUrl]: "archived"})(request)
    }
    responses = [served(acmeManifest("1.0.0"), {url: `${acmeUrl}miniapp.json`})]
    const u = updater()
    await u.check(acme)
    expect(statusStore.has(REGISTRY_STATUS_KEY)).toBe(false)
    // The first Core's verdict didn't stick to the second one.
    expect(fetched).toHaveLength(1)

    statusAnswer = answer({})
    now += OPEN_CHECK_INTERVAL_MS
    responses = [served(acmeManifest("1.0.0"), {url: `${acmeUrl}miniapp.json`})]
    await u.check(acme)
    expect(statusCores).toEqual(["https://core.example.com", "https://other-core.example.com"])
    expect(JSON.parse(statusStore.get(REGISTRY_STATUS_KEY)!).core).toBe("https://other-core.example.com")
  })

  test("a refresh that failed against one Core doesn't make the next Core wait", async () => {
    installBoth()
    statusAnswer = async () => {
      throw new Error("Core can't be reached")
    }
    responses = [served(acmeManifest("1.0.0"), {url: `${acmeUrl}miniapp.json`})]
    const u = updater()
    await u.check(acme)
    core = "https://other-core.example.com"
    statusAnswer = answer({})
    now += OPEN_CHECK_INTERVAL_MS
    responses = [served(acmeManifest("1.0.0"), {url: `${acmeUrl}miniapp.json`})]
    await u.check(acme)
    expect(statusCores).toEqual(["https://core.example.com", "https://other-core.example.com"])
  })

  test("a Core switch between batches stops the refresh", async () => {
    active = {}
    identities = {}
    for (let i = 0; i < 501; i++) {
      active[`com.acme.tool${i}`] = "1.0.0"
      identities[`com.acme.tool${i}`] = {source: "url", sourceUrl: `https://tools.acme.com/tool${i}/`}
    }
    statusAnswer = async (request) => {
      core = "https://other-core.example.com"
      return answer({})(request)
    }
    responses = [
      served(acmeManifest("1.0.0", {packageName: "com.acme.tool0"}), {
        url: "https://tools.acme.com/tool0/miniapp.json",
      }),
    ]
    await updater().check("com.acme.tool0")
    expect(statusCalls.map((call) => call.entries.length)).toEqual([500])
    expect(statusStore.has(REGISTRY_STATUS_KEY)).toBe(false)
  })

  test("more URLs than one call takes are asked about in batches", async () => {
    active = {}
    identities = {}
    for (let i = 0; i < 501; i++) {
      active[`com.acme.tool${i}`] = "1.0.0"
      identities[`com.acme.tool${i}`] = {source: "url", sourceUrl: `https://tools.acme.com/tool${i}/`}
    }
    statusAnswer = answer({"https://tools.acme.com/tool500/": "archived"})
    await updater().check("com.acme.tool500")
    expect(statusCalls.map((call) => call.entries.length)).toEqual([500, 1])
    expect(fetched).toEqual([])
  })
})

// ---- Moves, redirects and sign-in challenges, through the real miniappFetch -------------------------------------

interface Answer {
  status: number
  body?: string | Uint8Array
  headers?: Record<string, string>
}

let routes: Map<string, Answer[]>
let sent: Array<{url: string; init: MiniappRequestInit}>
let tokens: string[]
const zipBytes = new TextEncoder().encode("the tools zip")
let zipSha: string

const transport: MiniappFetchTransport = async (target, init) => {
  sent.push({url: target, init})
  const answer = routes.get(target)?.shift()
  if (!answer) return new Response(null, {status: 404}) as never
  const response = new Response(answer.status === 304 ? null : ((answer.body ?? null) as BodyInit | null), {
    status: answer.status,
    headers: answer.headers,
  })
  Object.defineProperty(response, "url", {value: target})
  return response
}

function route(target: string, ...answers: Answer[]): void {
  routes.set(target, [...(routes.get(target) ?? []), ...answers])
}

function json(body: Record<string, unknown>, headers: Record<string, string> = {}): Answer {
  return {status: 200, body: JSON.stringify(body), headers}
}

function redirect(status: number, location: string): Answer {
  return {status, headers: {Location: location}}
}

/** An updater whose requests go through miniappFetch, as the engine's do. */
function networkUpdater(overrides: Partial<ConstructorParameters<typeof MiniappUrlUpdater>[0]> = {}) {
  return new MiniappUrlUpdater({
    ...updaterDeps(),
    fetchManifest: (url, {etag, packageName}) => {
      fetched.push({url, etag})
      return fetchMiniappJson(url, {
        ...(etag ? {etag} : {}),
        packageForChallenge: packageName,
        redirect: "manual",
        transport,
      })
    },
    fetchBundle: (url, options) => fetchMiniappBundle(url, {...options, transport}),
    install: async (bundleUrl, options) => {
      // Like the installer: download through the caller's downloader, then read the identity.
      await options.downloadBundle!(bundleUrl)
      installs.push({bundleUrl, options: {...options, releaseIdentity: {...options.releaseIdentity!}}})
      if (installError) throw installError
      active[options.expectedPackageName] = options.expectedVersion
      identities[options.expectedPackageName] = {...options.releaseIdentity!}
    },
    ...overrides,
  })
}

describe("moves and redirects", () => {
  const installedSha = "c".repeat(64)

  beforeEach(async () => {
    routes = new Map()
    sent = []
    zipSha = Buffer.from(await crypto.subtle.digest("SHA-256", zipBytes)).toString("hex")
    active = {[acme]: "1.0.0"}
    identities = {[acme]: {source: "url", sourceUrl: acmeUrl, bundleSha256: installedSha}}
    registerAnswer = async (request) => ({
      result: "accepted_unverified",
      entry: {
        url: request.url,
        packageName: acme,
        registrableDomain: "acme.com",
        name: null,
        version: null,
        ageRating: null,
        iconUrl: null,
        verification: "phone_reported",
        private: false,
        status: "active",
        firstRegisteredAt: new Date(now).toISOString(),
        lastVerifiedAt: null,
      },
    })
  })

  // 1.0.0 is the build already installed; any other version is the ZIP the transport serves.
  const release = (version: string) =>
    acmeManifest(version, {
      bundle: {url: `${acme}-${version}.zip`, sha256: version === "1.0.0" ? installedSha : zipSha},
    })

  test("a 301 within the domain moves the miniapp: its release records the new URL, which is registered", async () => {
    const movedUrl = "https://apps.acme.com/tools/"
    route(`${acmeUrl}miniapp.json`, redirect(301, `${movedUrl}miniapp.json`))
    route(`${movedUrl}miniapp.json`, json(release("1.1.0"), {ETag: '"v2"'}))
    route(`${movedUrl}${acme}-1.1.0.zip`, {status: 200, body: zipBytes})
    const u = networkUpdater()
    await u.check(acme)

    expect(sent.map((request) => request.init.redirect)).toEqual(["manual", "manual", "follow"])
    expect(moves).toEqual([{packageName: acme, version: "1.0.0", fromUrl: acmeUrl, sourceUrl: movedUrl}])
    expect(registrations).toEqual([
      {url: movedUrl, reported: {packageName: acme, name: "Acme Tools", version: "1.1.0"}},
    ])
    expect(installs.map((install) => install.bundleUrl)).toEqual([`${movedUrl}${acme}-1.1.0.zip`])
    expect(installs[0].options.releaseIdentity).toEqual({source: "url", sourceUrl: movedUrl, bundleSha256: zipSha})

    // From then on it updates from the new URL, with that URL's ETag.
    route(`${movedUrl}miniapp.json`, {status: 304})
    now += OPEN_CHECK_INTERVAL_MS
    sent = []
    await u.check(acme)
    expect(sent.map((request) => request.url)).toEqual([`${movedUrl}miniapp.json`])
    expect(sent[0].init.headers["If-None-Match"]).toBe('"v2"')
  })

  test("a move is recorded even when the build already installed is served there", async () => {
    route(`${acmeUrl}miniapp.json`, redirect(308, "/v2/miniapp.json"))
    route("https://tools.acme.com/v2/miniapp.json", json(release("1.0.0")))
    await networkUpdater().check(acme)
    expect(moves.map((move) => move.sourceUrl)).toEqual(["https://tools.acme.com/v2/"])
    expect(installs).toEqual([])
  })

  test("a temporary redirect within the domain is followed for this check, and moves nothing", async () => {
    route(`${acmeUrl}miniapp.json`, redirect(302, "https://cdn.acme.com/app/miniapp.json"))
    route("https://cdn.acme.com/app/miniapp.json", json(release("1.1.0")))
    route(`https://cdn.acme.com/app/${acme}-1.1.0.zip`, {status: 200, body: zipBytes})
    await networkUpdater().check(acme)
    expect(moves).toEqual([])
    expect(registrations).toEqual([])
    expect(installs.map((install) => install.bundleUrl)).toEqual([`https://cdn.acme.com/app/${acme}-1.1.0.zip`])
    expect(installs[0].options.releaseIdentity?.sourceUrl).toBe(acmeUrl)
  })

  test("only permanent moves from the installed URL count: a temporary hop first moves nothing", async () => {
    route(`${acmeUrl}miniapp.json`, redirect(307, "https://tools.acme.com/tmp/miniapp.json"))
    route("https://tools.acme.com/tmp/miniapp.json", redirect(301, "https://tools.acme.com/v2/miniapp.json"))
    route("https://tools.acme.com/v2/miniapp.json", json(release("1.0.0")))
    await networkUpdater().check(acme)
    expect(moves).toEqual([])
  })

  test("a move then a temporary hop records the move", async () => {
    route(`${acmeUrl}miniapp.json`, redirect(301, "https://tools.acme.com/v2/miniapp.json"))
    route("https://tools.acme.com/v2/miniapp.json", redirect(302, "https://cdn.acme.com/v2/miniapp.json"))
    route("https://cdn.acme.com/v2/miniapp.json", json(release("1.0.0")))
    await networkUpdater().check(acme)
    expect(moves.map((move) => move.sourceUrl)).toEqual(["https://tools.acme.com/v2/"])
  })

  test("a permanent redirect to something other than a miniapp URL is followed, and moves nothing", async () => {
    route(`${acmeUrl}miniapp.json`, redirect(301, `${acmeUrl}miniapp.json?v=2`))
    route(`${acmeUrl}miniapp.json?v=2`, json(release("1.0.0")))
    await networkUpdater().check(acme)
    expect(moves).toEqual([])
    expect(warnings).toEqual([])
  })

  test.each([
    ["another domain", "https://tools.other.com/app/miniapp.json"],
    ["a lookalike domain", "https://acme.com.evil.example/app/miniapp.json"],
    ["plain HTTP", "http://tools.acme.com/app/miniapp.json"],
  ])("a redirect to %s is refused, records nothing and backs off", async (_name, target) => {
    route(`${acmeUrl}miniapp.json`, redirect(301, target), redirect(301, target))
    const u = networkUpdater()
    await u.check(acme)
    expect(sent.map((request) => request.url)).toEqual([`${acmeUrl}miniapp.json`])
    expect(moves).toEqual([])
    expect(installs).toEqual([])
    expect(warnings).toHaveLength(1)
    now += OPEN_CHECK_INTERVAL_MS
    await u.check(acme)
    expect(sent).toHaveLength(1)
    now += BASE_BACKOFF_MS
    await u.check(acme)
    expect(sent).toHaveLength(2)
  })

  test(`more than ${MAX_MANIFEST_REDIRECTS} redirects is a failure`, async () => {
    for (let i = 0; i <= MAX_MANIFEST_REDIRECTS; i++) {
      const from = i === 0 ? `${acmeUrl}miniapp.json` : `https://tools.acme.com/hop${i}/miniapp.json`
      route(from, redirect(301, `https://tools.acme.com/hop${i + 1}/miniapp.json`))
    }
    await networkUpdater().check(acme)
    expect(sent).toHaveLength(MAX_MANIFEST_REDIRECTS + 1)
    expect(moves).toEqual([])
    expect(warnings).toHaveLength(1)
  })

  test("a redirect with no Location is a failure", async () => {
    route(`${acmeUrl}miniapp.json`, {status: 301})
    await networkUpdater().check(acme)
    expect(installs).toEqual([])
    expect(warnings).toHaveLength(1)
  })

  test.each([
    ["archived", {result: "archived"}],
    ["not a miniapp", {result: "not_a_miniapp", reason: "invalid_manifest"}],
  ] as const)("Core answering that the new URL is %s stops the move and the update", async (_name, verdict) => {
    route(`${acmeUrl}miniapp.json`, redirect(301, "https://tools.acme.com/v2/miniapp.json"))
    route("https://tools.acme.com/v2/miniapp.json", json(release("1.1.0")))
    registerAnswer = async () => verdict as RegistryRegisterResponse
    await networkUpdater().check(acme)
    expect(registrations).toHaveLength(1)
    expect(moves).toEqual([])
    expect(installs).toEqual([])
    expect(warnings).toHaveLength(1)
  })

  test("a move to a URL the kept answer archives is refused without asking Core", async () => {
    keep({statuses: {[acmeUrl]: "active", "https://tools.acme.com/v2/": "archived"}})
    route(`${acmeUrl}miniapp.json`, redirect(301, "https://tools.acme.com/v2/miniapp.json"))
    route("https://tools.acme.com/v2/miniapp.json", json(release("1.1.0")))
    await networkUpdater().check(acme)
    expect(statusCalls).toEqual([])
    expect(registrations).toEqual([])
    expect(moves).toEqual([])
    expect(installs).toEqual([])
  })

  test.each([
    ["a temporary redirect", 302, "https://tools.acme.com/v2/miniapp.json"],
    ["a move", 301, "https://tools.acme.com/v2/miniapp.json"],
    ["a temporary redirect to the slashless URL", 302, "https://tools.acme.com/v2"],
    ["a move to the slashless URL", 301, "https://tools.acme.com/v2"],
    ["a redirect to the URL itself", 307, "https://tools.acme.com/v2/"],
    ["a redirect to a file under it", 302, "https://TOOLS.acme.com:443/v2/files/miniapp.json?v=1"],
    ["a temporary redirect through the host's final dot", 302, "https://tools.acme.com./v2/miniapp.json"],
    ["a move through the host's final dot", 301, "https://tools.acme.com./v2"],
  ])("%s into a URL the kept answer archives is refused before fetching it", async (_name, status, target) => {
    keep({statuses: {[acmeUrl]: "active", "https://tools.acme.com/v2/": "archived"}})
    route(`${acmeUrl}miniapp.json`, redirect(status, target))
    route(target, json(release("1.1.0")))
    await networkUpdater().check(acme)
    expect(sent.map((request) => request.url)).toEqual([`${acmeUrl}miniapp.json`])
    expect(registrations).toEqual([])
    expect(moves).toEqual([])
    expect(installs).toEqual([])
    expect(warnings).toEqual([expect.stringContaining("archived")])
  })

  test("a redirect to a sibling of an archived URL is followed", async () => {
    keep({statuses: {[acmeUrl]: "active", "https://tools.acme.com/v2/": "archived"}})
    route(`${acmeUrl}miniapp.json`, redirect(302, "https://tools.acme.com/v20/miniapp.json"))
    route("https://tools.acme.com/v20/miniapp.json", json(release("1.0.0")))
    await networkUpdater().check(acme)
    expect(sent.map((request) => request.url)).toEqual([
      `${acmeUrl}miniapp.json`,
      "https://tools.acme.com/v20/miniapp.json",
    ])
    expect(warnings).toEqual([])
  })

  test("Core not answering doesn't stop a move", async () => {
    route(`${acmeUrl}miniapp.json`, redirect(301, "https://tools.acme.com/v2/miniapp.json"))
    route("https://tools.acme.com/v2/miniapp.json", json(release("1.0.0")))
    registerAnswer = async () => {
      throw new Error("Core can't be reached")
    }
    await networkUpdater().check(acme)
    expect(moves.map((move) => move.sourceUrl)).toEqual(["https://tools.acme.com/v2/"])
  })

  test("with requireRegistry off, a move isn't registered", async () => {
    requireRegistry = false
    route(`${acmeUrl}miniapp.json`, redirect(301, "https://tools.acme.com/v2/miniapp.json"))
    route("https://tools.acme.com/v2/miniapp.json", json(release("1.0.0")))
    await networkUpdater().check(acme)
    expect(registrations).toEqual([])
    expect(moves).toHaveLength(1)
  })

  test("a move to a URL that answers with no valid miniapp.json moves nothing", async () => {
    route(`${acmeUrl}miniapp.json`, redirect(301, "https://tools.acme.com/parked/miniapp.json"))
    route("https://tools.acme.com/parked/miniapp.json", {status: 200, body: "<html>parked</html>"})
    await networkUpdater().check(acme)
    expect(moves).toEqual([])
    expect(registrations).toEqual([])
    expect(warnings).toHaveLength(1)
  })

  test("a bundled miniapp follows its deployment's host: a permanent redirect there moves nothing", async () => {
    active = {[pkg]: "1.0.0"}
    identities = {[pkg]: {source: "url", sourceUrl}}
    const moved = `https://miniapps.mentraglass.com/v2/${pkg}/`
    route(`${sourceUrl}miniapp.json`, redirect(301, `${moved}miniapp.json`))
    route(`${moved}miniapp.json`, json(manifest("1.0.0")))
    await networkUpdater().check(pkg)
    expect(sent.map((request) => request.url)).toEqual([`${sourceUrl}miniapp.json`, `${moved}miniapp.json`])
    expect(moves).toEqual([])
    expect(registrations).toEqual([])
  })
})

describe("sign-in challenges", () => {
  const challenge = (packageName = acme) => ({
    status: 401,
    headers: {"WWW-Authenticate": `Bearer realm="mentra", package="${packageName}"`},
  })

  beforeEach(async () => {
    routes = new Map()
    sent = []
    tokens = []
    zipSha = Buffer.from(await crypto.subtle.digest("SHA-256", zipBytes)).toString("hex")
    active = {[acme]: "1.0.0"}
    identities = {[acme]: {source: "url", sourceUrl: acmeUrl}}
    cloudClientService.hasCore = () => true
    cloudClientService.getMiniappAuthToken = async (packageName: string) => {
      tokens.push(packageName)
      return {token: `token-for-${packageName}`, mentraUserId: "user", tenantId: "mentra", expiresAt: 0}
    }
  })

  const release = (version: string) => acmeManifest(version, {bundle: {url: `${acme}-${version}.zip`, sha256: zipSha}})

  test("a challenge is answered with that package's token, once, and the release is recorded as private", async () => {
    route(`${acmeUrl}miniapp.json`, challenge(), json(release("1.1.0")))
    route(`${acmeUrl}${acme}-1.1.0.zip`, challenge(), {status: 200, body: zipBytes})
    await networkUpdater().check(acme)

    expect(tokens).toEqual([acme, acme])
    const requests = sent.map((request) => ({
      url: request.url,
      authorization: (request.init.headers.Authorization as string | undefined) ?? null,
      redirect: request.init.redirect,
    }))
    expect(requests).toEqual([
      {url: `${acmeUrl}miniapp.json`, authorization: null, redirect: "manual"},
      {url: `${acmeUrl}miniapp.json`, authorization: `Bearer token-for-${acme}`, redirect: "error"},
      {url: `${acmeUrl}${acme}-1.1.0.zip`, authorization: null, redirect: "follow"},
      {url: `${acmeUrl}${acme}-1.1.0.zip`, authorization: `Bearer token-for-${acme}`, redirect: "error"},
    ])
    expect(installs[0].options.releaseIdentity).toEqual({
      source: "url",
      sourceUrl: acmeUrl,
      bundleSha256: zipSha,
      private: true,
    })
  })

  test("a ZIP whose server alone asks for sign-in is recorded as private too", async () => {
    route(`${acmeUrl}miniapp.json`, json(release("1.1.0")))
    route(`${acmeUrl}${acme}-1.1.0.zip`, challenge(), {status: 200, body: zipBytes})
    await networkUpdater().check(acme)
    expect(installs[0].options.releaseIdentity?.private).toBe(true)
  })

  test("a private miniapp answered with a 304 stays private", async () => {
    route(`${acmeUrl}miniapp.json`, challenge(), json(release("1.1.0"), {ETag: '"v2"'}))
    route(`${acmeUrl}miniapp.json`, challenge(), {status: 304})
    route(`${acmeUrl}${acme}-1.1.0.zip`, {status: 200, body: zipBytes}, {status: 200, body: zipBytes})
    installError = new RunningError("running")
    const u = networkUpdater({isRunningError: (error) => error instanceof RunningError})
    await u.check(acme)
    installError = undefined
    await u.check(acme)
    expect(installs.map((install) => install.options.releaseIdentity?.private)).toEqual([true, true])
    expect(active[acme]).toBe("1.1.0")
  })

  test("a public miniapp whose server starts asking for sign-in is private, even when it answers 304", async () => {
    route(`${acmeUrl}miniapp.json`, json(release("1.1.0"), {ETag: '"v2"'}))
    route(`${acmeUrl}miniapp.json`, challenge(), {status: 304})
    route(`${acmeUrl}${acme}-1.1.0.zip`, {status: 200, body: zipBytes}, {status: 200, body: zipBytes})
    installError = new RunningError("running")
    const u = networkUpdater({isRunningError: (error) => error instanceof RunningError})
    await u.check(acme)
    installError = undefined
    await u.check(acme)
    expect(tokens).toEqual([acme])
    expect(installs.map((install) => install.options.releaseIdentity?.private)).toEqual([undefined, true])
  })

  test("a refused token stops updates: nothing installs, and the check backs off", async () => {
    route(`${acmeUrl}miniapp.json`, challenge(), {status: 403})
    const u = networkUpdater()
    await u.check(acme)
    expect(tokens).toEqual([acme])
    expect(installs).toEqual([])
    expect(warnings).toEqual([expect.stringContaining("refused the token")])

    now += OPEN_CHECK_INTERVAL_MS
    await u.check(acme)
    expect(sent).toHaveLength(2)
    expect(tokens).toHaveLength(1)

    // Access back: updates resume after the backoff.
    now += BASE_BACKOFF_MS
    route(`${acmeUrl}miniapp.json`, challenge(), json(release("1.1.0")))
    route(`${acmeUrl}${acme}-1.1.0.zip`, {status: 200, body: zipBytes})
    await u.check(acme)
    expect(active[acme]).toBe("1.1.0")
  })

  test("a challenge for another package gets no token", async () => {
    route(`${acmeUrl}miniapp.json`, challenge("com.acme.other"))
    await networkUpdater().check(acme)
    expect(tokens).toEqual([])
    expect(installs).toEqual([])
    expect(warnings).toHaveLength(1)
  })

  test("no token can be had: the check fails and backs off", async () => {
    cloudClientService.getMiniappAuthToken = async () => {
      throw new Error("signed out")
    }
    route(`${acmeUrl}miniapp.json`, challenge())
    const u = networkUpdater()
    await u.check(acme)
    now += OPEN_CHECK_INTERVAL_MS
    await u.check(acme)
    expect(sent).toHaveLength(1)
    expect(warnings).toHaveLength(1)
  })

  test("without a challenge, no request carries a token or cookie", async () => {
    route(`${acmeUrl}miniapp.json`, json(release("1.1.0")))
    route(`${acmeUrl}${acme}-1.1.0.zip`, {status: 200, body: zipBytes})
    await networkUpdater().check(acme)
    expect(tokens).toEqual([])
    expect(sent.every((request) => !request.init.headers.Authorization && request.init.credentials === "omit")).toBe(
      true,
    )
    expect(installs[0].options.releaseIdentity?.private).toBeUndefined()
  })
})

describe("a development build from a local address", () => {
  const dev = "com.acme.notes"
  const address = "http://192.168.1.50:3000/"
  const devSha = "c".repeat(64)
  const nextSha = "d".repeat(64)

  function localManifest(sha256: string, overrides: Record<string, unknown> = {}) {
    return {
      packageName: dev,
      version: "0.1.0",
      name: "Notes",
      bundle: {url: `bundle-${sha256.slice(0, 8)}.zip`, sha256},
      development: {reload: "ws://192.168.1.50:3001/__mentra_dev"},
      ...overrides,
    }
  }

  function servedLocally(body: Record<string, unknown>, extra: Partial<ManifestFetchResult> = {}): ManifestFetchResult {
    return {status: 200, url: `${address}miniapp.json`, body: JSON.stringify(body), ...extra}
  }

  beforeEach(() => {
    active = {[dev]: "dev-1000"}
    identities = {[dev]: {source: "local", sourceUrl: address, bundleSha256: devSha}}
    developmentBuilds = new Set([dev])
  })

  test("installs a build with another hash from its address, over HTTP, without asking or asking Core", async () => {
    responses = [servedLocally(localManifest(nextSha))]
    await updater().checkNow(dev)
    expect(localFetches).toEqual([{url: `${address}miniapp.json`, local: true}])
    expect(statusCalls).toEqual([])
    expect(registrations).toEqual([])
    expect(installs).toEqual([])
    expect(localInstalls).toHaveLength(1)
    const [{bundleUrl, install}] = localInstalls
    expect(bundleUrl).toBe(`${address}bundle-dddddddd.zip`)
    expect(install).toMatchObject({
      packageName: dev,
      version: "0.1.0",
      sourceUrl: address,
      sha256: nextSha,
      reloadUrl: "ws://192.168.1.50:3001/__mentra_dev",
    })
    expect(active[dev]).not.toBe("dev-1000")
  })

  test("does nothing when its address serves the build it has", async () => {
    responses = [servedLocally(localManifest(devSha))]
    await updater().checkNow(dev)
    expect(localFetches).toHaveLength(1)
    expect(localInstalls).toEqual([])
  })

  test("a pass never asks a local address; other miniapps are still checked", async () => {
    active[pkg] = "1.0.0"
    identities[pkg] = {source: "bundled_asset"}
    responses = [served(manifest("1.0.0"))]
    await updater().checkAll()
    expect(fetched.map((request) => request.url)).toEqual([`${sourceUrl}miniapp.json`])
  })

  test("checkNow ignores the minute rule and the failure backoff", async () => {
    const u = updater()
    responses = [servedLocally(localManifest(devSha))]
    await u.checkNow(dev)
    // Checked a moment ago: asked again at once.
    responses = [servedLocally(localManifest(devSha))]
    await u.checkNow(dev)
    expect(localFetches).toHaveLength(2)
    // The computer went away: the check failed, and a backoff would wait minutes.
    responses = [{status: 503, url: `${address}miniapp.json`}]
    await u.checkNow(dev)
    expect(warnings.some((warning) => warning.includes(dev))).toBe(true)
    responses = [servedLocally(localManifest(nextSha))]
    await u.checkNow(dev)
    expect(localInstalls).toHaveLength(1)
  })

  test("a start checks a local address every time, even right after a failed check", async () => {
    const u = updater()
    responses = [{status: 503, url: `${address}miniapp.json`}]
    await u.checkBeforeStart(dev, {checkMs: 5000, installMs: 5000})
    responses = [servedLocally(localManifest(nextSha))]
    await u.checkBeforeStart(dev, {checkMs: 5000, installMs: 5000})
    expect(localFetches).toHaveLength(2)
    expect(localInstalls).toHaveLength(1)
  })

  test("a checkNow during a check runs one more check after it, shared by every checkNow meanwhile", async () => {
    let answer!: (result: ManifestFetchResult) => void
    const u = new MiniappUrlUpdater({
      ...updaterDeps(),
      fetchManifest: async (url, {local}) => {
        localFetches.push({url, ...(local ? {local} : {})})
        if (localFetches.length === 1) {
          return new Promise<ManifestFetchResult>((resolve) => {
            answer = resolve
          })
        }
        return servedLocally(localManifest(nextSha))
      },
    })
    const first = u.checkNow(dev)
    // The first check is asking the address, and hasn't heard back.
    for (let i = 0; i < 50 && localFetches.length === 0; i++) await Promise.resolve()
    expect(localFetches).toHaveLength(1)
    const second = u.checkNow(dev)
    const third = u.checkNow(dev)
    answer(servedLocally(localManifest(devSha)))
    await Promise.all([first, second, third])
    expect(localFetches).toHaveLength(2)
    expect(localInstalls).toHaveLength(1)
  })

  test("follows a redirect that stays on the local network, and refuses one that leaves it", async () => {
    responses = [
      {status: 307, url: `${address}miniapp.json`, location: "http://192.168.1.51:3000/miniapp.json"},
      {...servedLocally(localManifest(nextSha)), url: "http://192.168.1.51:3000/miniapp.json"},
    ]
    const u = updater()
    await u.checkNow(dev)
    expect(localFetches.map((request) => request.url)).toEqual([
      `${address}miniapp.json`,
      "http://192.168.1.51:3000/miniapp.json",
    ])
    expect(localInstalls).toHaveLength(1)
    // The address it updates from is the one the person installed, not where it was sent for this check.
    expect(localInstalls[0].install.sourceUrl).toBe(address)

    localFetches = []
    responses = [{status: 302, url: `${address}miniapp.json`, location: "https://evil.example/miniapp.json"}]
    await u.checkNow(dev)
    expect(localFetches).toHaveLength(1)
    expect(localInstalls).toHaveLength(1)
    expect(warnings.at(-1)).toContain("off the local network")
  })

  test("refuses a miniapp.json served from, or naming a bundle, off the local network", async () => {
    responses = [{...servedLocally(localManifest(nextSha)), url: "https://cdn.example/miniapp.json"}]
    await updater().checkNow(dev)
    responses = [servedLocally(localManifest(nextSha, {bundle: {url: "https://cdn.example/b.zip", sha256: nextSha}}))]
    await updater().checkNow(dev)
    expect(localInstalls).toEqual([])
  })

  test("a failed install is counted as a failed check, and the build it has stays", async () => {
    localInstallError = new Error("bundle SHA-256 mismatch")
    responses = [servedLocally(localManifest(nextSha))]
    await updater().checkNow(dev)
    expect(localInstalls).toHaveLength(1)
    expect(active[dev]).toBe("dev-1000")
    expect(warnings.at(-1)).toContain("could not install")
  })

  test("is never replaced by an update from another URL: it checks only its own address", async () => {
    // A system package's name: its release would update from Mentra's host.
    active = {[pkg]: "dev-1000"}
    identities = {[pkg]: {source: "local", sourceUrl: address, bundleSha256: devSha}}
    developmentBuilds = new Set([pkg])
    responses = [servedLocally(localManifest(nextSha, {packageName: pkg}))]
    await updater().checkNow(pkg)
    expect(fetched.map((request) => request.url)).toEqual([`${address}miniapp.json`])
    expect(installs).toEqual([])
    expect(localInstalls).toHaveLength(1)
  })

  test("leaves a release alone while the person's development build of it is installed", async () => {
    // Development is off in this deployment, so the release runs; the development build still holds the package.
    active = {[pkg]: "1.0.0"}
    identities = {[pkg]: {source: "bundled_asset"}}
    developmentBuilds = new Set([pkg])
    await updater().checkAll()
    await updater().checkNow(pkg)
    expect(fetched).toEqual([])
  })

  test("doesn't check where the deployment doesn't allow development", async () => {
    developmentAllowed = false
    await updater().checkNow(dev)
    expect(localFetches).toEqual([])
  })

  test("a build from an older CLI's release QR has no address, and doesn't update", async () => {
    identities = {[dev]: {source: "local", bundleSha256: devSha}}
    await updater().checkNow(dev)
    await updater().checkBeforeStart(dev, {checkMs: 5000, installMs: 5000})
    expect(localFetches).toEqual([])
  })

  test("reads the console connection only on the local network", () => {
    expect(developmentReloadUrl("ws://192.168.1.50:3001/__mentra_dev", address)).toBe(
      "ws://192.168.1.50:3001/__mentra_dev",
    )
    expect(developmentReloadUrl("ws://evil.example:3001/__mentra_dev", address)).toBeUndefined()
    expect(developmentReloadUrl("http://192.168.1.50:3001/", address)).toBeUndefined()
    expect(developmentReloadUrl(undefined, address)).toBeUndefined()
  })
})

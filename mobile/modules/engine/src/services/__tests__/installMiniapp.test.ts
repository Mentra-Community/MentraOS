/// <reference types="bun-types" />

import {beforeEach, describe, expect, mock, test} from "bun:test"

import type {MiniappReleaseIdentity} from "../AppRegistry"
import {assertMiniappUpdateVersion, miniappInstallIdentityError} from "../miniappInstallIdentity"
import type {ReleaseInstallOptions} from "../miniappReleaseInstall"
import {MiniappRunningError} from "../../utils/storeInstallRuntime"
import {cloudClientService} from "./cloudClientServiceTestMock"

// The engine's own wiring is not under test here; its heavy modules only need to load.
class CancelledError extends Error {}
mock.module("expo/fetch", () => ({
  fetch: async () => {
    throw new Error("the tests pass their own transport")
  },
}))
mock.module("../AppRegistry", () => ({default: {}}))
mock.module("../LocalMiniappRuntime", () => ({default: {}}))
mock.module("../miniappReleaseInstall", () => ({
  installMiniappRelease: async () => {},
  MiniappInstallCancelledError: CancelledError,
}))
mock.module("../localBuildInstall", () => ({
  installLocalBuild: async () => {},
  restoreInstalledRelease: async () => {},
}))

const {createMiniappInstaller, InstallMiniappError} = await import("../installMiniapp")
const {fetchMiniappBundle, fetchMiniappJson} = await import("../miniappFetch")
type InstallMiniappDependencies = import("../installMiniapp").InstallMiniappDependencies
type InstallMiniappOptions = import("../installMiniapp").InstallMiniappOptions
type MiniappInstallPreview = import("../installMiniapp").MiniappInstallPreview
type MiniappRegistrationAnswer = import("@mentra/cloud-protocol").RegistryRegisterResponse
type MiniappRegistrationRequest = import("@mentra/cloud-protocol").RegistryRegisterRequest
type MiniappFetchTransport = import("../miniappFetch").MiniappFetchTransport
type AgeGateVerdict = import("../miniappAgeGate").AgeGateVerdict
type AgeRatedMiniapp = import("../miniappAgeGate").AgeRatedMiniapp
type MiniappRequestInit = import("../miniappFetch").MiniappRequestInit
type LocalBuildInstall = import("../localBuildInstall").LocalBuildInstall

const pkg = "com.acme.tools"
const url = "https://tools.acme.com/app/"
const manifestUrl = `${url}miniapp.json`
const zipBytes = new TextEncoder().encode("the tools zip")
let zipSha: string
const challenge = `Bearer realm="mentra", package="${pkg}"`

interface Answer {
  status: number
  body?: string | Uint8Array
  headers?: Record<string, string>
  url?: string
}

let routes: Map<string, Answer[]>
let sent: Array<{url: string; init: MiniappRequestInit}>
let tokens: string[]
let served: Record<string, unknown>
let registrations: MiniappRegistrationRequest[]
let registryAnswer: () => Promise<MiniappRegistrationAnswer>
let requireRegistry: boolean
let installed: {version: string; identity: MiniappReleaseIdentity | null} | null
let installs: Array<{bundleUrl: string; options: ReleaseInstallOptions; identity: MiniappReleaseIdentity}>
let zipManifest: {packageName: string; version: string} | null
let installFailure: Error | undefined
let allowed: boolean
let hostVersion: string
let session: number
let kept: string[][]
let warnings: string[]
/** What the age gate answers, and every miniapp it was asked about. */
let ageVerdict: () => Promise<AgeGateVerdict>
let ageChecks: AgeRatedMiniapp[]
/** Every step, in order, for the tests that check where the age gate comes. */
let steps: string[]
let developmentSelected: boolean
let developmentAllowed: boolean
let localInstalls: Array<{bundleUrl: string; install: LocalBuildInstall}>
let localInstallFailure: Error | undefined
let restored: string[]
let restoreFailure: Error | undefined

function manifest(overrides: Record<string, unknown> = {}) {
  return {
    packageName: pkg,
    version: "1.2.0",
    name: "Acme Tools",
    icon: "icon.png",
    ageRating: "4+",
    sdkVersion: "3.3.0",
    minHostVersion: "3.3.0",
    hardwareRequirements: [],
    bundle: {url: `${pkg}-1.2.0.zip`, sha256: zipSha},
    ...overrides,
  }
}

/** Answer requests to `target` with these answers, in order; `miniapp.json` defaults to `served`. */
function route(target: string, ...answers: Answer[]): void {
  routes.set(target, answers)
}

const transport: MiniappFetchTransport = async (target, init) => {
  sent.push({url: target, init})
  const queued = routes.get(target)
  let answer: Answer | undefined = queued?.shift()
  if (!answer && target === manifestUrl) answer = {status: 200, body: JSON.stringify(served)}
  if (!answer && target === `${url}${pkg}-1.2.0.zip`) answer = {status: 200, body: zipBytes}
  if (!answer) return new Response(null, {status: 404}) as never
  const response = new Response(answer.status === 304 ? null : ((answer.body ?? null) as BodyInit | null), {
    status: answer.status,
    headers: answer.headers,
  })
  Object.defineProperty(response, "url", {value: answer.url ?? target})
  return response
}

function deps(overrides: Partial<InstallMiniappDependencies> = {}): InstallMiniappDependencies {
  return {
    // As the engine's own: a local-network address never has a challenge answered.
    fetchManifest: (target, {local}) =>
      fetchMiniappJson(target, local ? {transport} : {packageForChallenge: true, transport}),
    fetchBundle: (target, {local, ...options}) =>
      fetchMiniappBundle(target, {...options, ...(local ? {answerChallenge: false} : {}), transport}),
    requireRegistry: () => requireRegistry,
    register: async (request) => {
      registrations.push(request)
      return registryAnswer()
    },
    activeRelease: (packageName) => (packageName === pkg ? installed : null),
    hasDevelopmentSelection: () => developmentSelected,
    developmentAllowed: () => developmentAllowed,
    updateUrl: (_packageName, identity) => (identity?.source === "url" ? identity.sourceUrl : undefined),
    assertCanInstallVersion: (packageName, version) =>
      assertMiniappUpdateVersion(packageName, version, installed && packageName === pkg ? [installed.version] : []),
    allowsRelease: () => allowed,
    checkAge: async (miniapp) => {
      ageChecks.push(miniapp)
      steps.push("age gate")
      return ageVerdict()
    },
    compatibilityPolicy: (source) =>
      source === "assignment"
        ? {hostVersion, supportedSdkRange: ">=3.0.0 <4.0.0"}
        : {
            hostVersion,
            supportedSdkRange: ">=3.0.0 <4.0.0",
            hardwareCapabilities: {} as never,
          },
    install: async (bundleUrl, options) => {
      // Like the installer: download through the caller's downloader, then read the identity, then the ZIP's manifest.
      const bytes = await options.downloadBundle!(bundleUrl)
      expect(bytes.byteLength).toBeGreaterThan(0)
      installs.push({bundleUrl, options, identity: {...options.releaseIdentity!}})
      if (options.isCancelled?.()) throw new CancelledError()
      const identityError = miniappInstallIdentityError(zipManifest ?? (served as never), {
        packageName: options.expectedPackageName,
        version: options.expectedVersion,
      })
      if (identityError) throw new Error(identityError)
      if (installFailure) throw installFailure
      installed = {version: options.expectedVersion, identity: options.releaseIdentity!}
    },
    installLocal: async (bundleUrl, local) => {
      // Like the local installer: download through the caller's downloader, then bind the ZIP to the manifest.
      const bytes = await local.downloadBundle!(bundleUrl)
      expect(bytes.byteLength).toBeGreaterThan(0)
      localInstalls.push({bundleUrl, install: local})
      if (local.isCancelled?.()) throw new CancelledError()
      if (localInstallFailure) throw localInstallFailure
    },
    restoreRelease: async (packageName, isCancelled) => {
      if (isCancelled()) throw new CancelledError()
      if (restoreFailure) throw restoreFailure
      restored.push(packageName)
      developmentSelected = false
    },
    keepVersions: async (_packageName, versions) => {
      kept.push(versions)
    },
    installSession: () => session,
    warn: (message) => warnings.push(message),
    ...overrides,
  }
}

function install(
  target = url,
  options: Partial<InstallMiniappOptions> = {},
  overrides?: Partial<InstallMiniappDependencies>,
) {
  return createMiniappInstaller(deps(overrides))(target, {source: "link", confirm: async () => true, ...options})
}

async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(InstallMiniappError)
    return (error as InstanceType<typeof InstallMiniappError>).code
  }
  throw new Error("the install did not fail")
}

beforeEach(async () => {
  zipSha = Buffer.from(await crypto.subtle.digest("SHA-256", zipBytes)).toString("hex")
  routes = new Map()
  sent = []
  tokens = []
  served = manifest()
  registrations = []
  registryAnswer = async () => ({result: "accepted", entry: {}, manifest: served as never})
  requireRegistry = true
  installed = null
  installs = []
  zipManifest = null
  installFailure = undefined
  allowed = true
  hostVersion = "3.4.0"
  session = 1
  kept = []
  warnings = []
  ageVerdict = async () => "allowed"
  ageChecks = []
  steps = []
  developmentSelected = false
  developmentAllowed = true
  localInstalls = []
  localInstallFailure = undefined
  restored = []
  restoreFailure = undefined
  cloudClientService.hasCore = () => true
  cloudClientService.getMiniappAuthToken = async (packageName: string) => {
    tokens.push(packageName)
    return {token: `token-for-${packageName}`}
  }
})

describe("installing from a miniapp URL", () => {
  test("fetches, registers, asks, downloads and installs through the shared installer", async () => {
    const previews: MiniappInstallPreview[] = []
    const result = await install("https://Tools.Acme.com/app", {
      confirm: async (preview) => {
        previews.push(preview)
        return true
      },
    })
    expect(result).toEqual({status: "installed", packageName: pkg, version: "1.2.0"})
    expect(registrations).toEqual([
      {url, reported: {packageName: pkg, name: "Acme Tools", version: "1.2.0", ageRating: "4+"}},
    ])
    expect(previews).toEqual([
      {
        url,
        host: "tools.acme.com",
        local: false,
        packageName: pkg,
        name: "Acme Tools",
        iconUrl: `${url}icon.png`,
        ageRating: "4+",
        private: false,
        alreadyInstalled: false,
      },
    ])
    expect(installs).toHaveLength(1)
    const {bundleUrl, options, identity} = installs[0]!
    expect(bundleUrl).toBe(`${url}${pkg}-1.2.0.zip`)
    expect(options).toMatchObject({
      expectedPackageName: pkg,
      expectedVersion: "1.2.0",
      expectedBundleSha256: zipSha,
      installReason: "explicit",
    })
    expect(options.onlyIfStopped).toBeUndefined()
    expect(identity).toEqual({source: "url", sourceUrl: url, bundleSha256: zipSha})
    expect(kept).toEqual([["1.2.0"]])
  })

  test("no request to the miniapp's URL carries a token or cookie unless its server asks", async () => {
    await install()
    expect(sent.map((request) => request.url)).toEqual([manifestUrl, `${url}${pkg}-1.2.0.zip`])
    for (const request of sent) {
      expect(request.init.headers.Authorization).toBeUndefined()
      expect(request.init.credentials).toBe("omit")
    }
    expect(tokens).toEqual([])
  })

  test("a private miniapp gets its own package's token, once per request that asks, and is recorded as private", async () => {
    const asks = {status: 401, headers: {"www-authenticate": challenge}}
    route(manifestUrl, asks, {status: 200, body: JSON.stringify(served)})
    route(`${url}${pkg}-1.2.0.zip`, asks, {status: 200, body: zipBytes})
    const previews: MiniappInstallPreview[] = []
    await install(url, {
      confirm: async (preview) => {
        previews.push(preview)
        return true
      },
    })
    expect(tokens).toEqual([pkg, pkg])
    expect(
      sent.map((request) => [request.url, request.init.headers.Authorization ?? null, request.init.redirect]),
    ).toEqual([
      [manifestUrl, null, "follow"],
      [manifestUrl, `Bearer token-for-${pkg}`, "error"],
      [`${url}${pkg}-1.2.0.zip`, null, "follow"],
      [`${url}${pkg}-1.2.0.zip`, `Bearer token-for-${pkg}`, "error"],
    ])
    expect(previews[0]!.private).toBe(true)
    expect(installs[0]!.identity.private).toBe(true)
  })

  test("a ZIP whose server alone asks for sign-in is recorded as private", async () => {
    route(
      `${url}${pkg}-1.2.0.zip`,
      {status: 401, headers: {"www-authenticate": challenge}},
      {status: 200, body: zipBytes},
    )
    await install()
    expect(tokens).toEqual([pkg])
    expect(installs[0]!.identity.private).toBe(true)
  })

  test("a server that refuses the token is access_denied", async () => {
    route(manifestUrl, {status: 401, headers: {"www-authenticate": challenge}}, {status: 403})
    expect(await failure(install())).toBe("access_denied")
    route(`${url}${pkg}-1.2.0.zip`, {status: 401, headers: {"www-authenticate": challenge}}, {status: 401})
    expect(await failure(install())).toBe("access_denied")
  })

  test("a challenge for a package its domain doesn't own gets no token", async () => {
    route(manifestUrl, {status: 401, headers: {"www-authenticate": 'Bearer realm="mentra", package="com.mentra.call"'}})
    expect(await failure(install())).toBe("domain_mismatch")
    expect(tokens).toEqual([])
  })

  test("a server that asks as one package and serves another is not_a_miniapp", async () => {
    route(
      manifestUrl,
      {status: 401, headers: {"www-authenticate": 'Bearer realm="mentra", package="com.acme.other"'}},
      {status: 200, body: JSON.stringify(served)},
    )
    expect(await failure(install())).toBe("not_a_miniapp")
    expect(installs).toEqual([])
  })
})

describe("what stops an install", () => {
  test.each([
    ["an HTTP URL", "http://tools.acme.com/app/"],
    ["a URL with a query", "https://tools.acme.com/app/?x=1"],
    ["not a URL", "tools"],
  ])("%s is not_a_miniapp, fetched from nowhere", async (_name, target) => {
    expect(await failure(install(target))).toBe("not_a_miniapp")
    expect(sent).toEqual([])
  })

  test.each([
    ["invalid JSON", {status: 200, body: "{"}],
    ["no bundle", {status: 200, body: JSON.stringify(manifest({bundle: undefined}))}],
    ["no name", {status: 200, body: JSON.stringify(manifest({name: undefined}))}],
    ["a version that isn't SemVer", {status: 200, body: JSON.stringify(manifest({version: "latest"}))}],
    [
      "an HTTP bundle",
      {status: 200, body: JSON.stringify(manifest({bundle: {url: "http://x.acme.com/z.zip", sha256: "a".repeat(64)}}))},
    ],
    ["a 404", {status: 404}],
  ])("a miniapp.json with %s is not_a_miniapp", async (_name, answer) => {
    route(manifestUrl, answer)
    expect(await failure(install())).toBe("not_a_miniapp")
    expect(registrations).toEqual([])
  })

  test("a URL that serves another package than the caller agreed to is not_a_miniapp, before anything else", async () => {
    expect(
      await failure(install(url, {source: "system", confirm: undefined, expectedPackageName: "com.acme.other"})),
    ).toBe("not_a_miniapp")
    expect(registrations).toEqual([])
    expect(installs).toEqual([])
    const result = await install(url, {source: "system", confirm: undefined, expectedPackageName: pkg})
    expect(result).toMatchObject({status: "installed", packageName: pkg})
    expect(installs).toHaveLength(1)
  })

  test("a package its domain doesn't own is domain_mismatch, and is never registered", async () => {
    served = manifest({packageName: "com.mentra.notes"})
    expect(await failure(install())).toBe("domain_mismatch")
    served = manifest({packageName: "com.other.tools"})
    expect(await failure(install())).toBe("domain_mismatch")
    expect(registrations).toEqual([])
  })

  test("a redirect to another domain can't serve the URL's package", async () => {
    route(manifestUrl, {status: 200, body: JSON.stringify(served), url: "https://evil.example.org/miniapp.json"})
    expect(await failure(install())).toBe("domain_mismatch")
  })

  test("a redirect within the domain serves it, and the ZIP resolves against where it was served from", async () => {
    const moved = "https://cdn.acme.com/tools/"
    route(manifestUrl, {status: 200, body: JSON.stringify(served), url: `${moved}miniapp.json`})
    route(`${moved}${pkg}-1.2.0.zip`, {status: 200, body: zipBytes})
    await install()
    expect(installs[0]!.bundleUrl).toBe(`${moved}${pkg}-1.2.0.zip`)
    expect(installs[0]!.identity.sourceUrl).toBe(url)
  })

  test("the registry's archived and not_a_miniapp stop it", async () => {
    registryAnswer = async () => ({result: "archived"})
    expect(await failure(install())).toBe("archived")
    registryAnswer = async () => ({result: "not_a_miniapp", reason: "domain_mismatch"})
    expect(await failure(install())).toBe("domain_mismatch")
    registryAnswer = async () => ({result: "not_a_miniapp", reason: "invalid_manifest"})
    expect(await failure(install())).toBe("not_a_miniapp")
    expect(installs).toEqual([])
  })

  test("a server that says 410 Gone is archived", async () => {
    route(manifestUrl, {status: 410})
    expect(await failure(install())).toBe("archived")
  })

  test("a server that asks for sign-in without a Mentra challenge is access_denied", async () => {
    route(manifestUrl, {status: 401})
    expect(await failure(install())).toBe("access_denied")
    expect(tokens).toEqual([])
  })

  test("a deployment that doesn't allow URL installs is access_denied, before anyone is asked", async () => {
    allowed = false
    let asked = false
    const promise = install(url, {
      confirm: async () => {
        asked = true
        return true
      },
    })
    expect(await failure(promise)).toBe("access_denied")
    expect(asked).toBe(false)
  })

  test("a phone that can't run it needs a newer Mentra App, after the sheet named it", async () => {
    hostVersion = "3.2.0"
    let asked = false
    const promise = install(url, {
      confirm: async () => {
        asked = true
        return true
      },
    })
    expect(await failure(promise)).toBe("needs_newer_app")
    expect(asked).toBe(true)
    expect(installs).toEqual([])
  })

  test("the server or the network failing is network", async () => {
    route(manifestUrl, {status: 503})
    expect(await failure(install())).toBe("network")
    expect(
      await failure(
        install(
          url,
          {},
          {
            fetchManifest: async () => {
              throw new TypeError("Network request failed")
            },
          },
        ),
      ),
    ).toBe("network")
    route(`${url}${pkg}-1.2.0.zip`, {status: 500})
    expect(await failure(install())).toBe("network")
  })

  test("no token to be had is network", async () => {
    cloudClientService.getMiniappAuthToken = async () => {
      throw new Error("Core is down")
    }
    route(manifestUrl, {status: 401, headers: {"www-authenticate": challenge}})
    expect(await failure(install())).toBe("network")
  })

  test("a ZIP with another SHA-256 is integrity", async () => {
    route(`${url}${pkg}-1.2.0.zip`, {status: 200, body: new TextEncoder().encode("other bytes")})
    expect(await failure(install())).toBe("integrity")
  })

  test.each([
    ["package name", {packageName: "com.acme.other", version: "1.2.0"}],
    ["version", {packageName: pkg, version: "1.3.0"}],
  ])("a ZIP whose own %s differs is integrity", async (_name, zip) => {
    zipManifest = zip
    expect(await failure(install())).toBe("integrity")
    expect(installed).toBeNull()
  })

  test("a ZIP the signing rule refuses is signature_invalid", async () => {
    installFailure = new Error("Unsigned bundle cannot replace signed miniapp com.acme.tools; uninstall it first")
    expect(await failure(install())).toBe("signature_invalid")
    installFailure = new Error("bundle publisher signature is invalid")
    expect(await failure(install())).toBe("signature_invalid")
  })

  test("a ZIP whose own manifest this phone can't run needs a newer Mentra App", async () => {
    installFailure = new Error("Requires Mentra App 9.0.0+; this host is 3.4.0.")
    expect(await failure(install())).toBe("needs_newer_app")
  })

  test("a broken ZIP is not_a_miniapp", async () => {
    installFailure = new Error("bundle must contain exactly one root miniapp.json")
    expect(await failure(install())).toBe("not_a_miniapp")
  })

  test("a ZIP that unpacks a symbolic link is not_a_miniapp", async () => {
    installFailure = new Error("bundle contains a symbolic link: ui/data.json")
    expect(await failure(install())).toBe("not_a_miniapp")
  })
})

describe("cancelling", () => {
  test("declining the sheet is cancelled, and nothing downloads", async () => {
    expect(await failure(install(url, {confirm: async () => false}))).toBe("cancelled")
    expect(sent.map((request) => request.url)).toEqual([manifestUrl])
    expect(installs).toEqual([])
  })

  test("a sheet that fails is cancelled", async () => {
    const promise = install(url, {
      confirm: async () => {
        throw new Error("the sheet went away")
      },
    })
    expect(await failure(promise)).toBe("cancelled")
  })

  test("isCancelled stops it at the next step", async () => {
    let stop = false
    const promise = install(url, {
      isCancelled: () => stop,
      confirm: async () => {
        stop = true
        return true
      },
    })
    expect(await failure(promise)).toBe("cancelled")
    expect(installs).toEqual([])
  })

  test("an engine session that ends during the install never commits it", async () => {
    const promise = install(
      url,
      {
        confirm: async () => true,
      },
      {
        fetchBundle: async (target, options) => {
          session += 1
          return fetchMiniappBundle(target, {...options, transport})
        },
      },
    )
    expect(await failure(promise)).toBe("cancelled")
    expect(installed).toBeNull()
  })
})

describe("what is already installed", () => {
  test("a miniapp installed from this URL opens, without registering or asking", async () => {
    installed = {version: "1.0.0", identity: {source: "url", sourceUrl: url}}
    let asked = false
    const result = await install("https://tools.acme.com/app", {
      confirm: async () => {
        asked = true
        return true
      },
    })
    expect(result).toEqual({status: "opened", packageName: pkg, version: "1.0.0"})
    expect(registrations).toEqual([])
    expect(asked).toBe(false)
    expect(installs).toEqual([])
  })

  test("a bundled miniapp that updates from this URL opens", async () => {
    installed = {version: "1.1.0", identity: {source: "bundled_asset"}}
    const result = await install(url, {}, {updateUrl: () => url})
    expect(result.status).toBe("opened")
  })

  test("installed from elsewhere, the sheet says so and installing replaces it", async () => {
    installed = {version: "1.0.0", identity: {source: "direct_download"}}
    const previews: MiniappInstallPreview[] = []
    const result = await install(url, {
      confirm: async (preview) => {
        previews.push(preview)
        return true
      },
    })
    expect(previews[0]!.alreadyInstalled).toBe(true)
    expect(result).toEqual({status: "installed", packageName: pkg, version: "1.2.0"})
    expect(kept).toEqual([["1.2.0", "1.0.0"]])
  })

  test("a newer release installed from elsewhere stays, and opens", async () => {
    installed = {version: "2.0.0", identity: {source: "direct_download"}}
    const result = await install()
    expect(result).toEqual({status: "opened", packageName: pkg, version: "2.0.0"})
    expect(installs).toEqual([])
  })

  test("another install that commits a newer release first is what opens", async () => {
    installed = {version: "1.0.0", identity: {source: "direct_download"}}
    const result = await install(
      url,
      {},
      {
        install: async () => {
          installed = {version: "3.0.0", identity: {source: "url", sourceUrl: url}}
          throw new Error(`Cannot install ${pkg}: version 3.0.0 is already installed`)
        },
      },
    )
    expect(result).toEqual({status: "opened", packageName: pkg, version: "3.0.0"})
  })

  test("a newer release standing behind a development build of its name comes back, after the sheet, and opens", async () => {
    installed = {version: "2.0.0", identity: {source: "url", sourceUrl: url}}
    developmentSelected = true
    const previews: MiniappInstallPreview[] = []
    const result = await install(url, {
      confirm: async (preview) => {
        previews.push(preview)
        return true
      },
    })
    expect(result).toEqual({status: "opened", packageName: pkg, version: "2.0.0"})
    expect(previews.map((preview) => preview.alreadyInstalled)).toEqual([true])
    expect(restored).toEqual([pkg])
    // Nothing downgrades.
    expect(installs).toEqual([])
  })

  test("bringing a release back from behind a development build meets the age gate before its sheet", async () => {
    installed = {version: "2.0.0", identity: {source: "url", sourceUrl: url}}
    developmentSelected = true
    served = manifest({ageRating: "18+"})
    ageVerdict = async () => "too_young"
    let sheets = 0
    const pending = install(url, {
      confirm: async () => {
        sheets += 1
        return true
      },
    })
    expect(await failure(pending)).toBe("age_restricted")
    expect(sheets).toBe(0)
    expect(restored).toEqual([])
  })

  test("declining the sheet leaves the development build running", async () => {
    installed = {version: "2.0.0", identity: {source: "url", sourceUrl: url}}
    developmentSelected = true
    expect(await failure(install(url, {confirm: async () => false}))).toBe("cancelled")
    expect(restored).toEqual([])
  })

  test("a headless install brings the newer release back too; a Fleet assignment leaves that to the reconciler", async () => {
    installed = {version: "2.0.0", identity: {source: "url", sourceUrl: url}}
    developmentSelected = true
    expect((await install(url, {source: "system", confirm: undefined})).status).toBe("opened")
    expect(restored).toEqual([pkg])
    developmentSelected = true
    restored = []
    const assignment = {workspaceId: "ws_1", coreUrl: "https://core.example", mentraUserId: "mu_1"} as never
    expect((await install(url, {source: "assignment", assignment, confirm: undefined})).status).toBe("opened")
    expect(restored).toEqual([])
  })

  test("a session that ends before the release comes back is cancelled", async () => {
    installed = {version: "2.0.0", identity: {source: "url", sourceUrl: url}}
    developmentSelected = true
    expect(
      await failure(
        install(url, {
          confirm: async () => {
            session = 2
            return true
          },
        }),
      ),
    ).toBe("cancelled")
    expect(restored).toEqual([])
  })

  test("with no development build in its place, a newer release just opens", async () => {
    installed = {version: "2.0.0", identity: {source: "url", sourceUrl: url}}
    let asked = false
    const result = await install(url, {
      confirm: async () => {
        asked = true
        return true
      },
    })
    expect(result.status).toBe("opened")
    expect(asked).toBe(false)
    expect(restored).toEqual([])
  })

  test("installed from this URL, but standing behind a development build of its name, it installs again over that build", async () => {
    installed = {version: "1.2.0", identity: {source: "url", sourceUrl: url}}
    developmentSelected = true
    const result = await install()
    expect(result).toEqual({status: "installed", packageName: pkg, version: "1.2.0"})
    expect(installs.map((entry) => entry.identity)).toEqual([{source: "url", sourceUrl: url, bundleSha256: zipSha}])
  })
})

describe("the registry", () => {
  test("requireRegistry off: nothing is registered, and the domain rule still applies", async () => {
    requireRegistry = false
    expect((await install()).status).toBe("installed")
    expect(registrations).toEqual([])
    served = manifest({packageName: "com.other.tools"})
    expect(await failure(install())).toBe("domain_mismatch")
  })

  test("unreachable, or refusing the call, the install goes on as one only this phone can reach", async () => {
    registryAnswer = async () => {
      throw new Error("Core request failed: no answer")
    }
    expect((await install()).status).toBe("installed")
    registryAnswer = async () => {
      throw Object.assign(new Error("Core request failed (HTTP 403)"), {status: 403, code: "email_unverified"})
    }
    installed = null
    expect((await install()).status).toBe("installed")
    expect(warnings).toHaveLength(2)
  })

  test("an answer it can't read is no answer", async () => {
    registryAnswer = async () => ({result: "maybe"}) as never
    expect((await install()).status).toBe("installed")
  })

  test("accepted unverified installs", async () => {
    registryAnswer = async () => ({result: "accepted_unverified", entry: {}})
    expect((await install()).status).toBe("installed")
  })
})

describe("headless installs", () => {
  const assignment = {
    assignmentId: "a1",
    assignmentRevision: 3,
    workspaceId: "w1",
    coreUrl: "https://core.example.com",
    mentraUserId: "u1",
    url,
  }

  test("an assignment installs silently with its reason, and never closes a running miniapp", async () => {
    const result = await install(url, {source: "assignment", assignment, confirm: undefined})
    expect(result.status).toBe("installed")
    expect(registrations).toHaveLength(1)
    expect(installs[0]!.options).toMatchObject({
      installReason: "assignment",
      assignment,
      onlyIfStopped: true,
      askIfRunning: true,
      firstInstall: true,
      compatibilityPolicy: {hostVersion: "3.4.0", supportedSdkRange: ">=3.0.0 <4.0.0"},
    })
    expect("hardwareCapabilities" in installs[0]!.options.compatibilityPolicy!).toBe(false)
  })

  test("an assignment of a package installed from its URL still installs: the reconciler decides", async () => {
    installed = {version: "1.0.0", identity: {source: "url", sourceUrl: url}}
    expect((await install(url, {source: "assignment", assignment, confirm: undefined})).status).toBe("installed")
  })

  test("an assignment must name its assignment", async () => {
    await expect(install(url, {source: "assignment", confirm: undefined})).rejects.toThrow("must name its assignment")
  })

  test("a headless install tells its caller when the update prompt waits for the person", async () => {
    let asked = 0
    const onAsking = () => {
      asked += 1
    }
    await install(url, {source: "assignment", assignment, confirm: undefined, onAsking})
    expect(installs[0]!.options.onAsking).toBe(onAsking)
    installs[0]!.options.onAsking!()
    expect(asked).toBe(1)
    // An install from the sheet stops and restarts a running copy: it never waits for the prompt.
    installed = null
    await install(url, {source: "link", onAsking})
    expect(installs[1]!.options.onAsking).toBeUndefined()
  })

  test("an assignment installs only the package its reconciler resolved", async () => {
    const result = await install(url, {source: "assignment", assignment, confirm: undefined, expectedPackageName: pkg})
    expect(result.status).toBe("installed")
    served = manifest({packageName: "com.acme.other"})
    expect(
      await failure(install(url, {source: "assignment", assignment, confirm: undefined, expectedPackageName: pkg})),
    ).toBe("not_a_miniapp")
    // Nothing of the other package is registered or downloaded.
    expect(registrations).toHaveLength(1)
    expect(installs).toHaveLength(1)
  })

  test("the deployment's policy is asked about the release as the assignment's", async () => {
    const asked: string[] = []
    await install(
      url,
      {source: "assignment", assignment, confirm: undefined},
      {
        allowsRelease: (_packageName, _version, _identity, source) => {
          asked.push(source)
          return true
        },
      },
    )
    installed = null
    await install(url, {source: "paste"}, {allowsRelease: (_p, _v, _i, source) => (asked.push(source), true)})
    expect(asked).toEqual(["assignment", "paste"])
  })

  test("a running miniapp's headless update is deferred", async () => {
    installed = {version: "1.0.0", identity: {source: "direct_download"}}
    installFailure = new MiniappRunningError(pkg)
    const result = await install(url, {source: "system", confirm: undefined})
    expect(result).toEqual({status: "deferred", packageName: pkg, version: "1.0.0"})
    expect(installs[0]!.options).toMatchObject({installReason: "explicit", onlyIfStopped: true, askIfRunning: true})
    expect(kept).toEqual([])
  })
})

describe("the age gate", () => {
  /** An install with the sheet, recording when the sheet opens. */
  function installWithSheet(options: Partial<InstallMiniappOptions> = {}) {
    return install(url, {
      confirm: async () => {
        steps.push("sheet")
        return true
      },
      ...options,
    })
  }

  test("comes after registration and before the sheet, with the served name and rating", async () => {
    served = manifest({ageRating: "18+"})
    const register = deps().register
    await install(
      url,
      {
        confirm: async () => {
          steps.push("sheet")
          return true
        },
      },
      {
        register: async (request) => {
          steps.push("register")
          return register(request)
        },
      },
    )
    expect(ageChecks).toEqual([{packageName: pkg, name: "Acme Tools", ageRating: "18+"}])
    expect(steps).toEqual(["register", "age gate", "sheet"])
    expect(installs).toHaveLength(1)
  })

  test("a miniapp without a rating goes to the gate too, which lets it through", async () => {
    served = manifest({ageRating: undefined})
    await installWithSheet()
    expect(ageChecks).toEqual([{packageName: pkg, name: "Acme Tools", ageRating: null}])
    expect(installs).toHaveLength(1)
  })

  test.each(["too_young", "unknown", "unavailable"] as const)(
    "%s stops it as age_restricted, before the sheet and before anything downloads",
    async (verdict) => {
      served = manifest({ageRating: "18+"})
      ageVerdict = async () => verdict
      expect(await failure(installWithSheet())).toBe("age_restricted")
      expect(steps).toEqual(["age gate"])
      expect(sent.map((request) => request.url)).toEqual([manifestUrl])
      expect(installs).toEqual([])
    },
  )

  test("closing the age question is cancelled, and no sheet opens", async () => {
    ageVerdict = async () => "cancelled"
    expect(await failure(installWithSheet())).toBe("cancelled")
    expect(steps).toEqual(["age gate"])
    expect(installs).toEqual([])
  })

  test("an install cancelled while the person answers never opens the sheet", async () => {
    let cancelled = false
    ageVerdict = async () => {
      cancelled = true
      return "allowed"
    }
    expect(await failure(installWithSheet({isCancelled: () => cancelled}))).toBe("cancelled")
    expect(steps).toEqual(["age gate"])
    expect(installs).toEqual([])
  })

  test.each(["system", "assignment"] as const)(
    "a headless %s install doesn't meet it until the miniapp opens",
    async (source) => {
      served = manifest({ageRating: "18+"})
      ageVerdict = async () => "too_young"
      const result = await install(url, {
        source,
        confirm: undefined,
        ...(source === "assignment"
          ? {
              assignment: {
                assignmentId: "a1",
                assignmentRevision: 3,
                workspaceId: "w1",
                coreUrl: "https://core.example.com",
                mentraUserId: "u1",
                url,
              },
            }
          : {}),
      })
      expect(result.status).toBe("installed")
      expect(ageChecks).toEqual([])
    },
  )

  test("a miniapp installed from this URL opens without it: opening meets the gate", async () => {
    served = manifest({ageRating: "18+"})
    installed = {version: "1.2.0", identity: {source: "url", sourceUrl: url}}
    ageVerdict = async () => "too_young"
    expect((await installWithSheet()).status).toBe("opened")
    expect(ageChecks).toEqual([])
  })
})

describe("the error", () => {
  test("carries its code, a message and the cause", async () => {
    route(manifestUrl, {status: 503})
    try {
      await install()
      throw new Error("did not fail")
    } catch (error) {
      expect(error).toBeInstanceOf(InstallMiniappError)
      expect(error).toBeInstanceOf(Error)
      expect((error as InstanceType<typeof InstallMiniappError>).name).toBe("InstallMiniappError")
      expect((error as InstanceType<typeof InstallMiniappError>).message).toContain("503")
    }
  })
})

describe("a local-network address", () => {
  const localUrl = "http://192.168.1.20:8080/"
  const localManifestUrl = `${localUrl}miniapp.json`
  const localZipUrl = `${localUrl}bundle.zip`
  // Nothing proves a local build's name, so it may claim any, Notes' included.
  const claimed = "com.mentra.notes"

  function serveLocal(overrides: Record<string, unknown> = {}): void {
    route(localManifestUrl, {
      status: 200,
      body: JSON.stringify(
        manifest({packageName: claimed, name: "Notes", bundle: {url: "bundle.zip", sha256: zipSha}, ...overrides}),
      ),
    })
    route(localZipUrl, {status: 200, body: zipBytes})
  }

  test("installs as a local build over HTTP: never registered, and its name checked against no domain", async () => {
    serveLocal()
    const previews: MiniappInstallPreview[] = []
    const result = await install(localUrl, {
      source: "local",
      confirm: async (preview) => {
        previews.push(preview)
        return true
      },
    })
    expect(result).toEqual({status: "installed", packageName: claimed, version: "1.2.0"})
    expect(registrations).toEqual([])
    expect(installs).toEqual([])
    expect(previews).toEqual([
      {
        url: localUrl,
        host: "192.168.1.20",
        local: true,
        packageName: claimed,
        name: "Notes",
        iconUrl: `${localUrl}icon.png`,
        ageRating: "4+",
        private: false,
        alreadyInstalled: false,
      },
    ])
    expect(localInstalls).toHaveLength(1)
    const {bundleUrl, install: local} = localInstalls[0]!
    expect(bundleUrl).toBe(localZipUrl)
    expect(local).toMatchObject({packageName: claimed, version: "1.2.0", sourceUrl: localUrl, sha256: zipSha})
    expect(local.server).toBeUndefined()
    expect(sent.map((request) => request.url)).toEqual([localManifestUrl, localZipUrl])
  })

  test("meets the age gate before its sheet, as any install with a sheet does", async () => {
    serveLocal({ageRating: "18+"})
    ageVerdict = async () => "too_young"
    expect(await failure(install(localUrl, {source: "local"}))).toBe("age_restricted")
    expect(ageChecks).toEqual([{packageName: claimed, name: "Notes", ageRating: "18+"}])
    expect(localInstalls).toEqual([])
  })

  test.each(["link", "scanner", "paste"] as const)("installs as a local build from a %s too", async (source) => {
    serveLocal()
    expect((await install(localUrl, {source})).status).toBe("installed")
    expect(localInstalls).toHaveLength(1)
  })

  test("names its development server: live from its URL, reloading over its channel, by its .local name too", async () => {
    serveLocal({
      development: {reload: "ws://192.168.1.20:8081/__mentra_dev", mdns: "laptop.local"},
      type: "standard",
      permissions: [{type: "MICROPHONE", required: true}],
      hardwareRequirements: [{type: "MICROPHONE", level: "REQUIRED"}],
      actions: [{id: "open", description: "Open."}],
    })
    await install(localUrl, {source: "local"})
    expect(localInstalls[0]!.install.server).toEqual({
      name: "Notes",
      iconUrl: `${localUrl}icon.png`,
      devUrl: "http://192.168.1.20:8080",
      devPort: 8081,
      mdnsHost: "laptop.local",
      type: "standard",
      permissions: [{type: "MICROPHONE", required: true}],
      hardwareRequirements: [{type: "MICROPHONE", level: "REQUIRED"}],
      actions: [{id: "open", description: "Open."}],
    })
  })

  test("a development field it can't read leaves out what it can't", async () => {
    serveLocal({development: {reload: "http://192.168.1.20:8081/", mdns: "laptop.example.com"}})
    await install(localUrl, {source: "local"})
    const server = localInstalls[0]!.install.server!
    expect(server.devPort).toBeUndefined()
    expect(server.mdnsHost).toBe("")
  })

  test("is never installed for Fleet or by a system miniapp, and nothing is fetched", async () => {
    serveLocal()
    expect(await failure(install(localUrl, {source: "assignment", assignment: {} as never}))).toBe("not_a_miniapp")
    expect(await failure(install(localUrl, {source: "system"}))).toBe("not_a_miniapp")
    expect(sent).toEqual([])
  })

  test("is access_denied where the deployment doesn't allow development builds, before anyone is asked", async () => {
    serveLocal()
    developmentAllowed = false
    let asked = false
    const code = await failure(
      install(localUrl, {
        source: "local",
        confirm: async () => {
          asked = true
          return true
        },
      }),
    )
    expect(code).toBe("access_denied")
    expect(asked).toBe(false)
    expect(localInstalls).toEqual([])
  })

  test("its server's sign-in challenge is never answered: no token goes to a local address", async () => {
    route(localManifestUrl, {status: 401, headers: {"www-authenticate": `Bearer realm="mentra", package="${claimed}"`}})
    expect(await failure(install(localUrl, {source: "local"}))).toBe("access_denied")
    serveLocal()
    route(localZipUrl, {status: 401, headers: {"www-authenticate": `Bearer realm="mentra", package="${claimed}"`}})
    expect(await failure(install(localUrl, {source: "local"}))).toBe("access_denied")
    expect(tokens).toEqual([])
    for (const request of sent) expect(request.init.headers.Authorization).toBeUndefined()
  })

  test("a redirect off the local network is not_a_miniapp", async () => {
    route(localManifestUrl, {
      status: 200,
      url: "https://tools.acme.com/app/miniapp.json",
      body: JSON.stringify(manifest({packageName: claimed})),
    })
    expect(await failure(install(localUrl, {source: "local"}))).toBe("not_a_miniapp")
    expect(localInstalls).toEqual([])
  })

  test("its ZIP comes over HTTP only from the local network; over HTTPS from anywhere", async () => {
    serveLocal({bundle: {url: "http://cdn.acme.com/notes.zip", sha256: zipSha}})
    expect(await failure(install(localUrl, {source: "local"}))).toBe("not_a_miniapp")
    serveLocal({bundle: {url: "https://cdn.acme.com/notes.zip", sha256: zipSha}})
    route("https://cdn.acme.com/notes.zip", {status: 200, body: zipBytes})
    expect((await install(localUrl, {source: "local"})).status).toBe("installed")
    expect(localInstalls[0]!.bundleUrl).toBe("https://cdn.acme.com/notes.zip")
  })

  test("a ZIP with another SHA-256 is integrity", async () => {
    serveLocal()
    route(localZipUrl, {status: 200, body: new TextEncoder().encode("other bytes")})
    expect(await failure(install(localUrl, {source: "local"}))).toBe("integrity")
  })

  test("the sheet says the package is installed already when a release or a development build of it is", async () => {
    const previews: MiniappInstallPreview[] = []
    const confirm = async (preview: MiniappInstallPreview) => {
      previews.push(preview)
      return true
    }
    serveLocal({packageName: pkg})
    installed = {version: "1.0.0", identity: {source: "url", sourceUrl: url}}
    await install(localUrl, {source: "local", confirm})
    installed = null
    developmentSelected = true
    serveLocal({packageName: pkg})
    await install(localUrl, {source: "local", confirm})
    expect(previews.map((preview) => preview.alreadyInstalled)).toEqual([true, true])
  })

  test("declining the sheet is cancelled, and nothing downloads", async () => {
    serveLocal()
    expect(await failure(install(localUrl, {source: "local", confirm: async () => false}))).toBe("cancelled")
    expect(sent.map((request) => request.url)).toEqual([localManifestUrl])
  })

  test("a phone that can't run it needs a newer Mentra App", async () => {
    serveLocal({minHostVersion: "9.0.0"})
    expect(await failure(install(localUrl, {source: "local"}))).toBe("needs_newer_app")
    expect(localInstalls).toEqual([])
  })

  test.each([
    [
      "the signing rule refuses its ZIP",
      "Unsigned bundle cannot replace signed miniapp com.mentra.notes",
      "signature_invalid",
    ],
    ["development is off", "This deployment does not allow miniapp development", "access_denied"],
    ["its ZIP names another version", "bundle version mismatch: expected 1.2.0, got 1.3.0", "integrity"],
  ])("the local installer's refusal when %s is %s", async (_name, message, code) => {
    serveLocal()
    localInstallFailure = new Error(message)
    expect(await failure(install(localUrl, {source: "local"}))).toBe(code)
  })

  test("isCancelled stops it before its files activate", async () => {
    serveLocal()
    let cancel = false
    const promise = install(localUrl, {
      source: "local",
      confirm: async () => {
        cancel = true
        return true
      },
      isCancelled: () => cancel,
    })
    expect(await failure(promise)).toBe("cancelled")
    expect(localInstalls).toEqual([])
  })
})

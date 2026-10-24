/**
 * `installMiniapp(url)`: the one engine call for every install from a miniapp URL, whichever way it came in (a link,
 * the scanner, the paste box, a system miniapp, a Fleet assignment).
 *
 * 1. Fetch `<url>/miniapp.json`, answering a sign-in challenge. A miniapp already installed from that URL opens.
 * 2. The domain rule: the URL's domain, and the domain it was served from, must own the package name.
 * 3. Register the URL in Core's registry. `archived` and `not_a_miniapp` stop the install; when the registry can't
 *    be reached, or Core refuses the call, the install goes on, as for an entry only the phone can reach.
 * 4. Ask the person, unless the install is headless.
 * 5. Check the phone can run it: `minHostVersion`, `sdkVersion` and `hardwareRequirements`.
 * 6. Download the ZIP (answering its server's challenge), check its SHA-256, and install it through the shared
 *    installer, which checks the ZIP's own package name and version and applies the signing and version rules.
 */
import type {RegistryRegisterRequest, RegistryRegisterResponse} from "@mentra/cloud-protocol"
import {
  normalizeMiniappUrl,
  ServedMiniappManifestSchema,
  type ServedMiniappManifest,
} from "@mentra/cloud-protocol/miniapp-url"

import {getConfigValues, isInstalledMiniappAllowed} from "../runtime/bootstrap"
import {MiniappRunningError} from "../utils/storeInstallRuntime"
import appRegistry, {type InstallableReleaseIdentity, type MiniappReleaseIdentity} from "./AppRegistry"
import {cloudClientService} from "./CloudClientService"
import type {ManagedAssignment} from "./fleet/assignmentReconciler"
import localMiniappRuntime from "./LocalMiniappRuntime"
import {checkManifestVersions} from "./manifestVersionGate"
import {isPackageNameAllowedForUrl} from "./miniappDomainRule"
import {fetchMiniappBundle, fetchMiniappJson, MiniappFetchError, type MiniappJsonResult} from "./miniappFetch"
import {checkMiniappInstallCompatibility, type MiniappCompatibilityPolicy} from "./miniappInstallCompatibility"
import {installMiniappRelease, MiniappInstallCancelledError, type ReleaseInstallOptions} from "./miniappReleaseInstall"
import {miniappUpdateUrl} from "./miniappUrlUpdates"
import {isSystemMiniappPackage} from "./SystemMiniappPolicy"
import {firstPartyMiniappUrl} from "./systemMiniappTrust"

export type {ManagedAssignment}

/** How the install came in. `confirm` decides whether the person is asked; `assignment` installs for Fleet. */
export type InstallMiniappSource = "link" | "scanner" | "paste" | "system" | "assignment" | "local"

/** What the install sheet shows. */
export interface MiniappInstallPreview {
  /** The miniapp URL, normalized: it ends in `/`. */
  url: string
  host: string
  /** A local-network address. Always false until local-network installs arrive. */
  local: boolean
  packageName: string
  name: string
  /** The icon `miniapp.json` names, as an absolute HTTPS URL. */
  iconUrl: string | null
  ageRating: string | null
  /** Its server asked for sign-in. */
  private: boolean
  /** The package is installed already, from another source; installing replaces it. */
  alreadyInstalled: boolean
}

export interface InstallMiniappOptions {
  source: InstallMiniappSource
  /** Show the install sheet; resolve true to install. Omitted: headless. */
  confirm?: (preview: MiniappInstallPreview) => Promise<boolean>
  /** Fleet only: the assignment the install records with the release. */
  assignment?: ManagedAssignment
  /** True once the install should stop. Nothing commits after that. */
  isCancelled?: () => boolean
}

export interface InstallMiniappResult {
  /**
   * `installed`: this release installed. `opened`: nothing installed, because the package is installed from this URL
   * already, or a newer release of it is; the caller opens it, if it opens anything. `deferred`: a headless update of
   * a running miniapp waits for it to stop, or for the person's answer to the update prompt.
   */
  status: "installed" | "opened" | "deferred"
  packageName: string
  /** The installed version: the new release, or the one that stays. */
  version: string
}

export type InstallMiniappErrorCode =
  | "not_a_miniapp"
  | "domain_mismatch"
  | "archived"
  | "needs_newer_app"
  | "access_denied"
  | "age_restricted"
  | "network"
  | "cancelled"
  | "integrity"
  | "signature_invalid"

export class InstallMiniappError extends Error {
  readonly code: InstallMiniappErrorCode

  constructor(code: InstallMiniappErrorCode, message: string, options: {cause?: unknown} = {}) {
    super(message)
    this.name = "InstallMiniappError"
    this.code = code
    if (options.cause !== undefined) (this as {cause?: unknown}).cause = options.cause
  }
}

// ---- The installer ------------------------------------------------------------------------------------------

export interface InstallMiniappDependencies {
  /** `miniapp.json`, answering a sign-in challenge for whichever package the asking URL's domain owns. */
  fetchManifest(url: string): Promise<MiniappJsonResult>
  /** The ZIP's bytes with this SHA-256, answering a sign-in challenge for this package only. */
  fetchBundle(url: string, options: {packageName: string; sha256: string; onChallenge: () => void}): Promise<Uint8Array>
  /** Register every install's URL (the engine's `requireRegistry`). */
  requireRegistry(): boolean
  /** Core's answer (`POST /api/client/registry/register`). Rejects when Core can't be reached or refuses the call. */
  register(request: RegistryRegisterRequest): Promise<RegistryRegisterResponse>
  /** The active installed release (not a development build), or null. */
  activeRelease(packageName: string): {version: string; identity: MiniappReleaseIdentity | null} | null
  /** The URL an installed release updates from, or undefined. */
  updateUrl(packageName: string, identity: MiniappReleaseIdentity | null): string | undefined
  /** Throws when a newer release of the package is installed. */
  assertCanInstallVersion(packageName: string, version: string): void
  /** The deployment lets this release run once it is installed. */
  allowsRelease(packageName: string, version: string, identity: MiniappReleaseIdentity): boolean
  /** The phone's compatibility policy, or null when the host configured none. Fleet's leaves out hardware. */
  compatibilityPolicy(
    source: InstallMiniappSource,
  ): MiniappCompatibilityPolicy | Omit<MiniappCompatibilityPolicy, "hardwareCapabilities"> | null
  install(bundleUrl: string, options: ReleaseInstallOptions): Promise<void>
  /** Keep only these releases of the package. */
  keepVersions(packageName: string, versions: string[]): Promise<void>
  /** Changes when the engine session ends; an install started before then never commits. */
  installSession(): number
  warn(message: string, error?: unknown): void
}

/** Build `installMiniapp` over its dependencies. */
export function createMiniappInstaller(
  deps: InstallMiniappDependencies,
): (url: string, options: InstallMiniappOptions) => Promise<InstallMiniappResult> {
  return async (url, options) => {
    if (options.source === "assignment" && !options.assignment) {
      throw new Error("An assignment install must name its assignment")
    }
    const session = deps.installSession()
    const cancelled = () => options.isCancelled?.() === true || deps.installSession() !== session
    const assertCurrent = () => {
      if (cancelled()) throw new InstallMiniappError("cancelled", `The install of ${url} was cancelled`)
    }

    const target = normalizeMiniappUrl(url)
    if (!target) throw new InstallMiniappError("not_a_miniapp", `${url} is not an HTTPS miniapp URL`)
    if (target.kind === "local") {
      throw new InstallMiniappError("not_a_miniapp", `${url} is on the local network, which doesn't install from a URL`)
    }
    const served = await readServedManifest(deps, target.url)
    assertCurrent()
    const {manifest} = served
    const packageName = manifest.packageName

    // A miniapp installed from this URL opens. Fleet's reconciler decides for itself what an assignment installs.
    const active = deps.activeRelease(packageName)
    if (options.source !== "assignment" && active) {
      const installedFrom = deps.updateUrl(packageName, active.identity)
      if (installedFrom && normalizeMiniappUrl(installedFrom)?.url === target.url) {
        return {status: "opened", packageName, version: active.version}
      }
    }

    if (!isPackageNameAllowedForUrl(packageName, target.url) || !isPackageNameAllowedForUrl(packageName, served.url)) {
      throw new InstallMiniappError("domain_mismatch", `${target.host} can't serve ${packageName}`)
    }
    if (served.challenge && served.challenge.packageName !== packageName) {
      throw new InstallMiniappError(
        "not_a_miniapp",
        `${target.url} asked for sign-in as ${served.challenge.packageName} but serves ${packageName}`,
      )
    }

    if (deps.requireRegistry()) await register(deps, target.url, manifest)
    assertCurrent()

    // A newer release is installed already: it stays, and opens.
    try {
      deps.assertCanInstallVersion(packageName, manifest.version)
    } catch (error) {
      if (!isNewerInstalled(error)) throw installError(error, packageName)
      return {status: "opened", packageName, version: active?.version ?? manifest.version}
    }

    const identity: InstallableReleaseIdentity = {
      source: "url",
      sourceUrl: target.url,
      bundleSha256: manifest.bundle.sha256,
      ...(served.challenge ? {private: true} : {}),
    }
    if (!deps.allowsRelease(packageName, manifest.version, identity)) {
      throw new InstallMiniappError(
        "access_denied",
        `This deployment doesn't allow installing ${packageName} from a URL`,
      )
    }

    if (options.confirm) {
      const preview: MiniappInstallPreview = {
        url: target.url,
        host: target.host,
        local: false,
        packageName,
        name: manifest.name,
        iconUrl: served.iconUrl,
        ageRating: manifest.ageRating ?? null,
        private: Boolean(served.challenge),
        alreadyInstalled: active !== null,
      }
      let accepted: boolean
      try {
        accepted = await options.confirm(preview)
      } catch (error) {
        throw new InstallMiniappError("cancelled", `The install sheet for ${packageName} failed`, {cause: error})
      }
      if (!accepted) throw new InstallMiniappError("cancelled", `The install of ${packageName} was declined`)
      assertCurrent()
    }

    const policy = deps.compatibilityPolicy(options.source)
    if (policy) {
      const compatibility =
        "hardwareCapabilities" in policy
          ? checkMiniappInstallCompatibility(manifest, policy)
          : toCompatibility(checkManifestVersions(manifest, policy))
      if (!compatibility.compatible) {
        throw new InstallMiniappError(
          "needs_newer_app",
          `${manifest.name} can't run on this phone: ${compatibility.reason}`,
        )
      }
    }

    const headless = !options.confirm
    try {
      await deps.install(served.bundleUrl, {
        expectedPackageName: packageName,
        expectedVersion: manifest.version,
        expectedBundleSha256: manifest.bundle.sha256,
        ...(policy ? {compatibilityPolicy: policy} : {}),
        releaseIdentity: identity,
        // The installer reads the identity after the download, so a ZIP whose server alone asked for sign-in is
        // recorded as private too.
        downloadBundle: (bundleUrl) =>
          deps.fetchBundle(bundleUrl, {
            packageName,
            sha256: manifest.bundle.sha256,
            onChallenge: () => {
              identity.private = true
            },
          }),
        installReason: options.assignment ? "assignment" : "explicit",
        ...(options.assignment ? {assignment: options.assignment} : {}),
        isCancelled: cancelled,
        // A headless install never closes a running miniapp: its update waits, or asks.
        ...(headless ? {onlyIfStopped: true, askIfRunning: true, firstInstall: true} : {}),
      })
    } catch (error) {
      if (error instanceof MiniappRunningError) {
        return {status: "deferred", packageName, version: active?.version ?? manifest.version}
      }
      if (error instanceof MiniappInstallCancelledError || cancelled()) {
        throw new InstallMiniappError("cancelled", `The install of ${packageName} was cancelled`, {cause: error})
      }
      // Another install of a newer release committed first.
      if (isNewerInstalled(error)) {
        return {status: "opened", packageName, version: deps.activeRelease(packageName)?.version ?? manifest.version}
      }
      throw installError(error, packageName)
    }

    await deps
      .keepVersions(packageName, [manifest.version, ...(active ? [active.version] : [])])
      .catch((error) => deps.warn(`Could not remove older releases of ${packageName}`, error))
    return {status: "installed", packageName, version: manifest.version}
  }
}

interface ServedRelease {
  manifest: ServedMiniappManifest
  /** Where `miniapp.json` was served from, after redirects. */
  url: string
  bundleUrl: string
  iconUrl: string | null
  /** The sign-in challenge its server answered with. */
  challenge?: {packageName: string}
}

/** `<url>/miniapp.json`: fetched, valid, and naming an HTTPS ZIP. */
async function readServedManifest(deps: InstallMiniappDependencies, url: string): Promise<ServedRelease> {
  const manifestUrl = new URL("miniapp.json", url).href
  let response: MiniappJsonResult
  try {
    response = await deps.fetchManifest(manifestUrl)
  } catch (error) {
    if (error instanceof MiniappFetchError) {
      switch (error.code) {
        case "challenge_domain":
          throw new InstallMiniappError("domain_mismatch", error.message, {cause: error})
        case "challenge_package":
        case "too_large":
          throw new InstallMiniappError("not_a_miniapp", error.message, {cause: error})
        default:
          throw new InstallMiniappError("network", error.message, {cause: error})
      }
    }
    throw new InstallMiniappError("network", `Could not fetch ${manifestUrl}`, {cause: error})
  }
  const {status} = response
  if (status === 401 || status === 403) {
    throw new InstallMiniappError("access_denied", `${manifestUrl} answered ${status}`)
  }
  if (status === 404) throw new InstallMiniappError("not_a_miniapp", `${manifestUrl} answered 404`)
  if (status === 410) throw new InstallMiniappError("archived", `${manifestUrl} answered 410`)
  if (status < 200 || status >= 300 || response.body === undefined) {
    throw new InstallMiniappError("network", `${manifestUrl} answered ${status}`)
  }
  let raw: unknown
  try {
    raw = JSON.parse(response.body)
  } catch {
    throw new InstallMiniappError("not_a_miniapp", `${manifestUrl} is not JSON`)
  }
  const parsed = ServedMiniappManifestSchema.safeParse(raw)
  if (!parsed.success) throw new InstallMiniappError("not_a_miniapp", `${manifestUrl} is not a valid miniapp.json`)
  const manifest = parsed.data
  const bundleUrl = httpsUrl(manifest.bundle.url, response.url)
  if (!bundleUrl) throw new InstallMiniappError("not_a_miniapp", `${manifestUrl} names no HTTPS bundle`)
  return {
    manifest,
    url: response.url,
    bundleUrl,
    iconUrl: manifest.icon ? httpsUrl(manifest.icon, response.url) : null,
    ...(response.challenge ? {challenge: response.challenge} : {}),
  }
}

/** A path relative to where `miniapp.json` was served from, or an absolute URL; HTTPS only. */
function httpsUrl(path: string, base: string): string | null {
  try {
    const resolved = new URL(path.trim(), base)
    return resolved.protocol === "https:" ? resolved.href : null
  } catch {
    return null
  }
}

const REGISTRY_RESULTS = new Set(["accepted", "accepted_unverified", "not_a_miniapp", "archived"])

/** Register the URL. Only Core's own answer can stop the install; without one, it goes on. */
async function register(deps: InstallMiniappDependencies, url: string, manifest: ServedMiniappManifest): Promise<void> {
  let answer: RegistryRegisterResponse
  try {
    answer = await deps.register({
      url,
      reported: {
        packageName: manifest.packageName,
        name: manifest.name,
        version: manifest.version,
        ...(manifest.ageRating ? {ageRating: manifest.ageRating} : {}),
      },
    })
  } catch (error) {
    deps.warn(`Could not register ${url}; installing it as only this phone can reach it`, error)
    return
  }
  if (!answer || typeof answer !== "object" || !REGISTRY_RESULTS.has(answer.result)) {
    deps.warn(`The registry's answer for ${url} is not usable; installing it as only this phone can reach it`)
    return
  }
  if (answer.result === "archived") throw new InstallMiniappError("archived", `${url} is archived`)
  if (answer.result === "not_a_miniapp") {
    if (answer.reason === "domain_mismatch") {
      throw new InstallMiniappError("domain_mismatch", `Core found ${url} can't serve ${manifest.packageName}`)
    }
    throw new InstallMiniappError("not_a_miniapp", `Core found ${url} is not a miniapp (${String(answer.reason)})`)
  }
}

function toCompatibility(
  result: ReturnType<typeof checkManifestVersions>,
): {compatible: true} | {compatible: false; reason: string} {
  return result.ok ? {compatible: true} : {compatible: false, reason: result.reason}
}

/** The version rule refused the release because a newer one is installed (`assertMiniappUpdateVersion`). */
function isNewerInstalled(error: unknown): boolean {
  return error instanceof Error && /^Cannot install .+: version .+ is already installed$/.test(error.message)
}

/** Map an installer or download failure to its code. Never the error text. */
function installError(error: unknown, packageName: string): InstallMiniappError {
  const message = error instanceof Error ? error.message : String(error)
  const fail = (code: InstallMiniappErrorCode) =>
    new InstallMiniappError(code, `${packageName} did not install: ${message}`, {cause: error})
  if (error instanceof MiniappFetchError) {
    switch (error.code) {
      case "integrity":
        return fail("integrity")
      case "challenge_domain":
        return fail("domain_mismatch")
      case "challenge_package":
      case "too_large":
        return fail("not_a_miniapp")
      case "http":
        return fail(error.status === 401 || error.status === 403 ? "access_denied" : "network")
      default:
        return fail("network")
    }
  }
  if (/SHA-256 mismatch|bundle (package|version) mismatch/i.test(message)) return fail("integrity")
  if (/signature|signer|unsigned bundle|publisher/i.test(message)) return fail("signature_invalid")
  if (
    /Requires Mentra App|Built for SDK|Invalid minimum Mentra App version|Invalid Mentra Miniapp SDK version|not available on your connected glasses/i.test(
      message,
    )
  )
    return fail("needs_newer_app")
  if (/^bundle |miniapp\.json|UNZIP_FAILED|READ_MANIFEST_FAILED|invalid miniapp version/i.test(message)) {
    return fail("not_a_miniapp")
  }
  return fail("network")
}

// ---- The engine's installer -----------------------------------------------------------------------------------

const engineDependencies: InstallMiniappDependencies = {
  fetchManifest: (url) => fetchMiniappJson(url, {packageForChallenge: true}),
  fetchBundle: (url, {packageName, sha256, onChallenge}) => fetchMiniappBundle(url, {packageName, sha256, onChallenge}),
  requireRegistry: () => getConfigValues().requireRegistry !== false,
  register: (request) => cloudClientService.core.registry.register(request),
  activeRelease: (packageName) => {
    const version = appRegistry.getActiveReleaseVersion(packageName)
    return version ? {version, identity: appRegistry.getReleaseIdentity(packageName, version)} : null
  },
  updateUrl: (packageName, identity) =>
    miniappUpdateUrl(packageName, identity, {
      isSystemPackage: isSystemMiniappPackage,
      firstPartyUrl: (name) => firstPartyMiniappUrl(getConfigValues(), name),
    }),
  assertCanInstallVersion: (packageName, version) => appRegistry.assertCanInstallVersion(packageName, version),
  allowsRelease: (packageName, version, identity) => isInstalledMiniappAllowed(packageName, version, identity),
  compatibilityPolicy: (source) => {
    const policy = localMiniappRuntime.currentInstallCompatibilityPolicy()
    if (!policy) return null
    // An assignment installs whichever glasses are paired now, as Fleet always has.
    if (source === "assignment") return {hostVersion: policy.hostVersion, supportedSdkRange: policy.supportedSdkRange}
    return policy
  },
  install: (bundleUrl, options) => installMiniappRelease(bundleUrl, options),
  keepVersions: (packageName, versions) => appRegistry.gcReleaseVersions(packageName, versions),
  installSession: () => localMiniappRuntime.installSession(),
  warn: (message, error) => console.warn(`installMiniapp: ${message}`, error ?? ""),
}

let engineInstaller: ((url: string, options: InstallMiniappOptions) => Promise<InstallMiniappResult>) | null = null

/**
 * Install the miniapp at a miniapp URL (see the module comment). Throws {@link InstallMiniappError}.
 */
export function installMiniapp(url: string, options: InstallMiniappOptions): Promise<InstallMiniappResult> {
  engineInstaller ??= createMiniappInstaller(engineDependencies)
  return engineInstaller(url, options)
}

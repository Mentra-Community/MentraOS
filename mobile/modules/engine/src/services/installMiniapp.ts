/**
 * `installMiniapp(url)`: the one engine call for every install from a miniapp URL, whichever way it came in (a link,
 * the scanner, the paste box, a system miniapp, a Fleet assignment).
 *
 * 1. Fetch `<url>/miniapp.json`, answering a sign-in challenge. A miniapp already installed from that URL opens.
 * 2. The domain rule: the URL's domain, and the domain it was served from, must own the package name.
 * 3. Register the URL in Core's registry. `archived` and `not_a_miniapp` stop the install; when the registry can't
 *    be reached, or Core refuses the call, the install goes on, as for an entry only the phone can reach.
 * 4. Ask the person, unless the install is headless. First the age gate: a miniapp rated above the host app's own
 *    rating needs the person's declared age to be old enough. A headless install meets the gate when it first opens.
 * 5. Check the phone can run it: `minHostVersion` and `sdkVersion`. `hardwareRequirements` describe the glasses, which
 *    may not be paired yet, so they never refuse an install: the sheet says what the paired glasses lack.
 * 6. Download the ZIP (answering its server's challenge), check its SHA-256, and install it through the shared
 *    installer, which checks the ZIP's own package name and version and applies the signing and version rules.
 *
 * A local-network address (spec, "Local-network miniapps") has no domain to own a package name, so it installs as a
 * development build of the name it serves, over HTTP or HTTPS: never registered, never updated from its URL, with
 * its own data, tokens marked as a local build's, and no system privileges ({@link installLocalBuild}).
 */
import type {FleetInstallFailureReason, RegistryRegisterRequest, RegistryRegisterResponse} from "@mentra/cloud-protocol"
import {
  isLocalNetworkHost,
  normalizeMiniappUrl,
  ServedMiniappManifestSchema,
  type ServedMiniappManifest,
} from "@mentra/cloud-protocol/miniapp-url"

import type {HardwareType} from "../types"
import {getConfigValues, isDevMiniappAllowed, isInstalledMiniappAllowed} from "../runtime/bootstrap"
import {MiniappRunningError} from "../utils/storeInstallRuntime"
import appRegistry, {type InstallableReleaseIdentity, type MiniappReleaseIdentity} from "./AppRegistry"
import {cloudClientService} from "./CloudClientService"
import type {ManagedAssignment} from "./fleet/assignmentReconciler"
import {fleetEvents, type FleetInstallEvent} from "./fleet/fleetEvents"
import localMiniappRuntime from "./LocalMiniappRuntime"
import {checkMiniappAge, type AgeGateVerdict, type AgeRatedMiniapp} from "./miniappAgeGate"
import {isPackageNameAllowedForUrl} from "./miniappDomainRule"
import {fetchMiniappBundle, fetchMiniappJson, MiniappFetchError, type MiniappJsonResult} from "./miniappFetch"
import {
  checkMiniappRunsOnPhone,
  missingRequiredHardware,
  type MiniappVersionPolicy,
} from "./miniappInstallCompatibility"
import {
  installLocalBuild,
  restoreInstalledRelease,
  type LocalBuildInstall,
  type LocalBuildServer,
} from "./localBuildInstall"
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
  /** A local-network address: the sheet says "From your local network", with the address. */
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
  /** Required hardware the paired glasses lack (all of it with none paired). The sheet says so; the install goes on. */
  missingHardware: HardwareType[]
}

export interface InstallMiniappOptions {
  source: InstallMiniappSource
  /** Show the install sheet; resolve true to install. Omitted: headless. */
  confirm?: (preview: MiniappInstallPreview) => Promise<boolean>
  /** Fleet only: the assignment the install records with the release. */
  assignment?: ManagedAssignment
  /**
   * The package the caller resolved the URL to (Fleet's reconciler). A URL that serves another package by now is
   * `not_a_miniapp`, before anything is registered or downloaded.
   */
  expectedPackageName?: string
  /** True once the install should stop. Nothing commits after that. */
  isCancelled?: () => boolean
  /**
   * Called once the installer knows the package, the release it would replace (null for none) and the version it would
   * install, before anything is downloaded or asked: how Fleet reports the attempt whatever comes after
   * (`installMiniapp`).
   */
  onResolved?: (packageName: string, previousVersion: string | null, version: string) => void
  /**
   * Headless only: called when the update of a running miniapp is staged and waits for the person's answer to its
   * update prompt. The call resolves once they answer: `installed`, or `deferred` for Not now.
   */
  onAsking?: () => void
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

/**
 * Why an install stopped. `age_restricted`: the age gate stopped it, because the person's declared age is below the
 * miniapp's rating, or couldn't be read, kept or asked for. In the first two cases the engine has already told them
 * why, through the host's `showAgeRestricted` seam. `cancelled`: the install was cancelled, or the person declined
 * the sheet or closed the age question.
 */
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
  /**
   * `miniapp.json`, answering a sign-in challenge for whichever package the asking URL's domain owns. A local-network
   * address owns no domain: with `local`, a challenge comes back unanswered.
   */
  fetchManifest(url: string, options: {local: boolean}): Promise<MiniappJsonResult>
  /** The ZIP's bytes with this SHA-256, answering a sign-in challenge for this package only (never with `local`). */
  fetchBundle(
    url: string,
    options: {packageName: string; sha256: string; onChallenge: () => void; local?: boolean},
  ): Promise<Uint8Array>
  /** Register every install's URL (the engine's `requireRegistry`). */
  requireRegistry(): boolean
  /** Core's answer (`POST /api/client/registry/register`). Rejects when Core can't be reached or refuses the call. */
  register(request: RegistryRegisterRequest): Promise<RegistryRegisterResponse>
  /** The active installed release (not a development build), or null. */
  activeRelease(packageName: string): {version: string; identity: MiniappReleaseIdentity | null} | null
  /** A development build (a local-network install, a development server or snapshot) runs instead of the release. */
  hasDevelopmentSelection(packageName: string): boolean
  /** The deployment allows development builds of the package, local-network builds included. */
  developmentAllowed(packageName: string): boolean
  /** The URL an installed release updates from, or undefined. */
  updateUrl(packageName: string, identity: MiniappReleaseIdentity | null): string | undefined
  /** Throws when a newer release of the package is installed. */
  assertCanInstallVersion(packageName: string, version: string): void
  /** The deployment lets this release run once it is installed, for an install that came in this way. */
  allowsRelease(
    packageName: string,
    version: string,
    identity: MiniappReleaseIdentity,
    source: InstallMiniappSource,
  ): boolean
  /**
   * The age gate for an install with a sheet (`miniappAgeGate.ts`): the person may be asked their age, and is told why
   * when the gate stops the install.
   */
  checkAge(miniapp: AgeRatedMiniapp): Promise<AgeGateVerdict>
  /** What the phone can run (its Mentra App and SDK versions), or null when the host configured none. */
  compatibilityPolicy(): MiniappVersionPolicy | null
  /** The required hardware of these `hardwareRequirements` that the paired glasses (or none) lack. */
  missingHardware(hardwareRequirements: unknown): HardwareType[]
  install(bundleUrl: string, options: ReleaseInstallOptions): Promise<void>
  /** Install a local-network build of the package ({@link installLocalBuild}). */
  installLocal(bundleUrl: string, install: LocalBuildInstall): Promise<void>
  /** Run the installed release again in place of a development build of its name ({@link restoreInstalledRelease}). */
  restoreRelease(packageName: string, isCancelled: () => boolean): Promise<void>
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
    if (target.kind === "local") return installFromLocalNetwork(deps, target, options, cancelled, assertCurrent)
    const served = await readServedManifest(deps, target.url, false)
    assertCurrent()
    const {manifest} = served
    const packageName = manifest.packageName
    if (options.expectedPackageName !== undefined && packageName !== options.expectedPackageName) {
      throw new InstallMiniappError(
        "not_a_miniapp",
        `${target.url} serves ${packageName} now, not ${options.expectedPackageName}`,
      )
    }

    // A miniapp installed from this URL opens, unless a development build of its name runs in its place: installing
    // it again replaces that build. Fleet's reconciler decides for itself what an assignment installs.
    const active = deps.activeRelease(packageName)
    options.onResolved?.(packageName, active?.version ?? null, manifest.version)
    if (options.source !== "assignment" && active && !deps.hasDevelopmentSelection(packageName)) {
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
      missingHardware: deps.missingHardware(manifest.hardwareRequirements),
    }

    // A newer release is installed already: it stays, and opens. Where a development build of its name runs in its
    // place, installing the URL again brings that release back.
    try {
      deps.assertCanInstallVersion(packageName, manifest.version)
    } catch (error) {
      if (!isNewerInstalled(error)) throw installError(error, packageName)
      if (options.source !== "assignment" && deps.hasDevelopmentSelection(packageName)) {
        if (options.confirm) {
          await askToInstall(deps, options.confirm, preview, assertCurrent)
          assertCurrent()
        }
        try {
          await deps.restoreRelease(packageName, cancelled)
        } catch (restoreError) {
          if (restoreError instanceof MiniappInstallCancelledError || cancelled()) {
            throw new InstallMiniappError("cancelled", `The install of ${packageName} was cancelled`, {
              cause: restoreError,
            })
          }
          throw installError(restoreError, packageName)
        }
      }
      return {status: "opened", packageName, version: active?.version ?? manifest.version}
    }

    const identity: InstallableReleaseIdentity = {
      source: "url",
      sourceUrl: target.url,
      bundleSha256: manifest.bundle.sha256,
      ...(served.challenge ? {private: true} : {}),
    }
    if (!deps.allowsRelease(packageName, manifest.version, identity, options.source)) {
      throw new InstallMiniappError(
        "access_denied",
        `This deployment doesn't allow installing ${packageName} from a URL`,
      )
    }

    if (options.confirm) {
      await askToInstall(deps, options.confirm, preview, assertCurrent)
      assertCurrent()
    }

    const policy = assertCompatible(deps, manifest)

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
        ...(headless && options.onAsking ? {onAsking: options.onAsking} : {}),
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

/**
 * A miniapp at a local-network address: a development build of the name it serves. Only the person installs one
 * (never Fleet or a system miniapp), and nothing registers it or checks its name against a domain. It installs beside
 * any release of that name, which it stands in for until that release is installed again or the package is
 * uninstalled; the signing rule still applies.
 */
async function installFromLocalNetwork(
  deps: InstallMiniappDependencies,
  target: {url: string; host: string},
  options: InstallMiniappOptions,
  cancelled: () => boolean,
  assertCurrent: () => void,
): Promise<InstallMiniappResult> {
  if (options.source === "assignment" || options.source === "system") {
    throw new InstallMiniappError(
      "not_a_miniapp",
      `${target.url} is on the local network, which only the person's own link, scan or paste installs from`,
    )
  }
  const served = await readServedManifest(deps, target.url, true)
  assertCurrent()
  const {manifest} = served
  const packageName = manifest.packageName
  options.onResolved?.(packageName, deps.activeRelease(packageName)?.version ?? null, manifest.version)
  if (!deps.developmentAllowed(packageName)) {
    throw new InstallMiniappError(
      "access_denied",
      `This deployment doesn't allow local-network builds of ${packageName}`,
    )
  }

  if (options.confirm) {
    await askToInstall(
      deps,
      options.confirm,
      {
        url: target.url,
        host: target.host,
        local: true,
        packageName,
        name: manifest.name,
        iconUrl: served.iconUrl,
        ageRating: manifest.ageRating ?? null,
        private: false,
        alreadyInstalled: deps.activeRelease(packageName) !== null || deps.hasDevelopmentSelection(packageName),
        missingHardware: deps.missingHardware(manifest.hardwareRequirements),
      },
      assertCurrent,
    )
    assertCurrent()
  }

  const policy = assertCompatible(deps, manifest)
  const server = developmentServer(manifest, target.url, served.iconUrl)
  try {
    await deps.installLocal(served.bundleUrl, {
      packageName,
      version: manifest.version,
      sourceUrl: target.url,
      sha256: manifest.bundle.sha256,
      ...(server ? {server} : {}),
      ...(policy ? {compatibilityPolicy: policy} : {}),
      downloadBundle: (bundleUrl) =>
        deps.fetchBundle(bundleUrl, {packageName, sha256: manifest.bundle.sha256, onChallenge: () => {}, local: true}),
      isCancelled: cancelled,
    })
  } catch (error) {
    if (error instanceof MiniappInstallCancelledError || cancelled()) {
      throw new InstallMiniappError("cancelled", `The install of ${packageName} was cancelled`, {cause: error})
    }
    throw installError(error, packageName)
  }
  return {status: "installed", packageName, version: manifest.version}
}

/**
 * Ask the person to install: first the age gate, so nobody is offered a miniapp they're too young for, then the install
 * sheet. A headless install meets the age gate when the miniapp first opens (`MiniappLauncher`).
 */
async function askToInstall(
  deps: InstallMiniappDependencies,
  confirm: (preview: MiniappInstallPreview) => Promise<boolean>,
  preview: MiniappInstallPreview,
  assertCurrent: () => void,
): Promise<void> {
  const {packageName, name, ageRating} = preview
  const verdict = await deps.checkAge({packageName, name, ageRating})
  assertCurrent()
  if (verdict === "cancelled") {
    throw new InstallMiniappError("cancelled", `The age question for ${packageName} was closed`)
  }
  if (verdict !== "allowed") {
    throw new InstallMiniappError("age_restricted", `${packageName} is rated ${String(ageRating)} (${verdict})`)
  }
  await confirmInstall(confirm, preview)
}

/** Show the install sheet. A sheet that fails, or that the person declines, cancels the install. */
async function confirmInstall(
  confirm: (preview: MiniappInstallPreview) => Promise<boolean>,
  preview: MiniappInstallPreview,
): Promise<void> {
  let accepted: boolean
  try {
    accepted = await confirm(preview)
  } catch (error) {
    throw new InstallMiniappError("cancelled", `The install sheet for ${preview.packageName} failed`, {cause: error})
  }
  if (!accepted) throw new InstallMiniappError("cancelled", `The install of ${preview.packageName} was declined`)
}

/** The phone's compatibility policy, once the manifest is known to pass it; null when none. */
function assertCompatible(
  deps: InstallMiniappDependencies,
  manifest: ServedMiniappManifest,
): MiniappVersionPolicy | null {
  const policy = deps.compatibilityPolicy()
  if (!policy) return null
  const compatibility = checkMiniappRunsOnPhone(manifest, policy)
  if (!compatibility.compatible) {
    throw new InstallMiniappError(
      "needs_newer_app",
      `${manifest.name} can't run on this phone: ${compatibility.reason}`,
    )
  }
  return policy
}

/**
 * The development server a local-network build's `miniapp.json` names in `development` (as `mentra dev` serves it):
 * the build then loads live from its URL, and the server reloads it over `development.reload`, on the same host.
 * Read for local-network URLs only. Undefined when it names none: the installed snapshot is the build.
 */
function developmentServer(
  manifest: ServedMiniappManifest,
  url: string,
  iconUrl: string | null,
): LocalBuildServer | undefined {
  const raw = manifest as ServedMiniappManifest & Record<string, unknown>
  const development = raw.development
  if (!development || typeof development !== "object" || Array.isArray(development)) return undefined
  const {reload, mdns} = development as {reload?: unknown; mdns?: unknown}
  let devPort: number | undefined
  if (typeof reload === "string") {
    try {
      const parsed = new URL(reload)
      const port = Number(parsed.port)
      if ((parsed.protocol === "ws:" || parsed.protocol === "wss:") && Number.isInteger(port) && port > 0) {
        devPort = port
      }
    } catch {
      // No reload channel: the build runs live without hot reload.
    }
  }
  // A `.local` name the phone may reach the same server by after its address changes.
  const mdnsHost =
    typeof mdns === "string" && /\.local$/i.test(mdns.trim()) && isLocalNetworkHost(mdns.trim()) ? mdns.trim() : ""
  const devUrl = url.replace(/\/+$/, "")
  return {
    name: manifest.name,
    iconUrl: iconUrl ?? `${devUrl}/icon.png`,
    devUrl,
    ...(devPort ? {devPort} : {}),
    mdnsHost,
    ...(typeof raw.type === "string" ? {type: raw.type as LocalBuildServer["type"]} : {}),
    ...(Array.isArray(raw.permissions) ? {permissions: raw.permissions as LocalBuildServer["permissions"]} : {}),
    ...(Array.isArray(raw.hardwareRequirements)
      ? {hardwareRequirements: raw.hardwareRequirements as LocalBuildServer["hardwareRequirements"]}
      : {}),
    ...(Array.isArray(raw.actions) ? {actions: raw.actions as LocalBuildServer["actions"]} : {}),
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

/**
 * `<url>/miniapp.json`: fetched, valid, and naming a ZIP over HTTPS (or, from a local-network address, over HTTP on the
 * local network too).
 */
async function readServedManifest(
  deps: InstallMiniappDependencies,
  url: string,
  local: boolean,
): Promise<ServedRelease> {
  const manifestUrl = new URL("miniapp.json", url).href
  let response: MiniappJsonResult
  try {
    response = await deps.fetchManifest(manifestUrl, {local})
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
  // Nothing checks a local build's name against a domain, so it must come from the local network.
  if (local && !isLocalNetworkUrl(response.url)) {
    throw new InstallMiniappError("not_a_miniapp", `${manifestUrl} redirected off the local network`)
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
  const bundleUrl = servedFileUrl(manifest.bundle.url, response.url, local)
  if (!bundleUrl) throw new InstallMiniappError("not_a_miniapp", `${manifestUrl} names no bundle it may serve`)
  return {
    manifest,
    url: response.url,
    bundleUrl,
    iconUrl: manifest.icon ? servedFileUrl(manifest.icon, response.url, local) : null,
    ...(response.challenge ? {challenge: response.challenge} : {}),
  }
}

/**
 * A path relative to where `miniapp.json` was served from, or an absolute URL: HTTPS, or for a local-network build,
 * HTTP on the local network too.
 */
function servedFileUrl(path: string, base: string, local: boolean): string | null {
  try {
    const resolved = new URL(path.trim(), base)
    if (resolved.protocol === "https:") return resolved.href
    return local && resolved.protocol === "http:" && isLocalNetworkUrl(resolved.href) ? resolved.href : null
  } catch {
    return null
  }
}

function isLocalNetworkUrl(url: string): boolean {
  try {
    return isLocalNetworkHost(new URL(url).hostname)
  } catch {
    return false
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
  if (/does not allow miniapp development/i.test(message)) return fail("access_denied")
  if (/signature|signer|unsigned bundle|publisher/i.test(message)) return fail("signature_invalid")
  if (
    /Requires Mentra App|Built for SDK|Invalid minimum Mentra App version|Invalid Mentra Miniapp SDK version/i.test(
      message,
    )
  )
    return fail("needs_newer_app")
  if (/^bundle |miniapp\.json|UNZIP_FAILED|READ_MANIFEST_FAILED|invalid miniapp version/i.test(message)) {
    return fail("not_a_miniapp")
  }
  return fail("network")
}

/** A miniapp URL at a local-network address: it installs as a local build (see the module comment). */
export function isLocalNetworkMiniappUrl(url: string): boolean {
  return normalizeMiniappUrl(url)?.kind === "local"
}

// ---- The engine's installer -----------------------------------------------------------------------------------

const engineDependencies: InstallMiniappDependencies = {
  fetchManifest: (url, {local}) => fetchMiniappJson(url, local ? {} : {packageForChallenge: true}),
  fetchBundle: (url, {packageName, sha256, onChallenge, local}) =>
    fetchMiniappBundle(url, {packageName, sha256, onChallenge, ...(local ? {answerChallenge: false} : {})}),
  requireRegistry: () => getConfigValues().requireRegistry !== false,
  register: (request) => cloudClientService.core.registry.register(request),
  activeRelease: (packageName) => {
    const version = appRegistry.getActiveReleaseVersion(packageName)
    return version ? {version, identity: appRegistry.getReleaseIdentity(packageName, version)} : null
  },
  hasDevelopmentSelection: (packageName) => appRegistry.hasDevelopmentSelection(packageName),
  developmentAllowed: (packageName) => isDevMiniappAllowed(packageName),
  updateUrl: (packageName, identity) =>
    miniappUpdateUrl(packageName, identity, {
      isSystemPackage: isSystemMiniappPackage,
      firstPartyUrl: (name) => firstPartyMiniappUrl(getConfigValues(), name),
    }),
  assertCanInstallVersion: (packageName, version) => appRegistry.assertCanInstallVersion(packageName, version),
  // A Fleet assignment is its workspace's administration, which the deployment's policy weighs apart from development.
  allowsRelease: (packageName, version, identity, source) =>
    isInstalledMiniappAllowed(packageName, version, identity, {assigned: source === "assignment"}),
  checkAge: (miniapp) => checkMiniappAge(miniapp, {interactive: true}),
  compatibilityPolicy: () => {
    const policy = localMiniappRuntime.currentInstallCompatibilityPolicy()
    return policy ? {hostVersion: policy.hostVersion, supportedSdkRange: policy.supportedSdkRange} : null
  },
  missingHardware: (hardwareRequirements) => {
    const capabilities = localMiniappRuntime.currentInstallCompatibilityPolicy()?.hardwareCapabilities
    return capabilities ? missingRequiredHardware(hardwareRequirements, capabilities) : []
  },
  install: (bundleUrl, options) => installMiniappRelease(bundleUrl, options),
  installLocal: (bundleUrl, install) => installLocalBuild(bundleUrl, install),
  restoreRelease: (packageName, isCancelled) => restoreInstalledRelease(packageName, {isCancelled}),
  keepVersions: (packageName, versions) => appRegistry.gcReleaseVersions(packageName, versions),
  installSession: () => localMiniappRuntime.installSession(),
  warn: (message, error) => console.warn(`installMiniapp: ${message}`, error ?? ""),
}

let engineInstaller: ((url: string, options: InstallMiniappOptions) => Promise<InstallMiniappResult>) | null = null

/** Fleet's install reason for an install that stopped (Phase 12): `assignment_outcome`'s reasons where they apply. */
const FLEET_INSTALL_REASON: Record<InstallMiniappErrorCode, FleetInstallFailureReason> = {
  not_a_miniapp: "not_a_miniapp",
  domain_mismatch: "not_a_miniapp",
  archived: "archived",
  needs_newer_app: "incompatible_host",
  access_denied: "access_denied",
  age_restricted: "access_denied",
  network: "network",
  cancelled: "user_cancelled",
  integrity: "download_failed",
  signature_invalid: "signature_invalid",
}

/**
 * Install the miniapp at a miniapp URL (see the module comment). Throws {@link InstallMiniappError}.
 *
 * Every attempt whose package the installer resolved is reported to Fleet (`miniapp_install`): an update when it
 * replaces an installed release, an install otherwise; installed, deferred, or failed with its reason. One the person
 * declined is deferred, not failed. An attempt that stopped before its package was known (an unreachable URL) cannot be
 * attributed, and is not reported.
 */
export function installMiniapp(url: string, options: InstallMiniappOptions): Promise<InstallMiniappResult> {
  engineInstaller ??= withFleetReport(createMiniappInstaller(engineDependencies))
  return engineInstaller(url, options)
}

/** `installer`, reporting each attempt to Fleet as `installMiniapp` describes. Exported for tests. */
export function withFleetReport(
  installer: (url: string, options: InstallMiniappOptions) => Promise<InstallMiniappResult>,
): (url: string, options: InstallMiniappOptions) => Promise<InstallMiniappResult> {
  return (url, options) => reportAttempt(installer, url, options)
}

async function reportAttempt(
  installer: (url: string, options: InstallMiniappOptions) => Promise<InstallMiniappResult>,
  url: string,
  options: InstallMiniappOptions,
): Promise<InstallMiniappResult> {
  const source = options.source === "assignment" ? "assignment" : options.source === "local" ? "local" : "url"
  // What the installer resolved: the package and the release it replaces, for an update and for a failure.
  type Attempt = {packageName: string; previousVersion: string | null; version: string}
  let attempt: Attempt | null = null
  const resolved: InstallMiniappOptions = {
    ...options,
    onResolved: (packageName, previousVersion, version) => {
      attempt = {packageName, previousVersion, version}
      options.onResolved?.(packageName, previousVersion, version)
    },
  }
  // Every report names the version the attempt was installing, whatever is installed when it is made.
  const report = (fields: Pick<FleetInstallEvent, "outcome" | "reason">) => {
    const known = attempt as Attempt | null
    if (known === null) return
    fleetEvents.install({
      packageName: known.packageName,
      operation: known.previousVersion ? "update" : "install",
      source,
      ...(known.previousVersion ? {fromVersion: known.previousVersion} : {}),
      toVersion: known.version,
      ...fields,
    } as FleetInstallEvent)
  }
  try {
    const result = await installer(url, resolved)
    if (result.status === "installed") report({outcome: "succeeded"})
    else if (result.status === "deferred") report({outcome: "deferred", reason: "unknown"})
    return result
  } catch (error) {
    const reason = error instanceof InstallMiniappError ? FLEET_INSTALL_REASON[error.code] : "unknown"
    report({outcome: reason === "user_cancelled" ? "deferred" : "failed", reason})
    throw error
  }
}

/**
 * AppRegistry — on-disk install/uninstall registry for local miniapps.
 *
 * Owns the `Documents/lmas/<packageName>/<version>/` filesystem layout, the
 * one installer every source uses (QR/manual releases, bundled ZIPs,
 * deployment-managed releases, dev snapshots), and the active-version pointer
 * in MMKV. It does NOT touch the apps store directly — instead it notifies
 * subscribers when the install set changes, so the host (mobile manager, OEM
 * app) can refresh its own state.
 *
 * Every install validates the archive, applies the publisher signer rule and
 * the version rule (never lower than an installed release), and activates the
 * bundle and its registry metadata in one serialized, crash-recoverable
 * transaction. See {@link InstallBundleOptions}.
 *
 * Public surface:
 *   - installFromUrl(url, opts?)            install/replace a miniapp from a URL
 *   - installFromLocalZip(path, opts?)      install/replace from a local zip
 *   - uninstall(packageName, version?)      remove one or all versions
 *   - getInstalledMiniapps()                ClientApp[] derived from disk
 *   - getActiveVersion(packageName)         active version string for a package
 *   - getPublisherKeyFingerprint(pkg)       recorded publisher signer, if any
 *   - getLatestDevSnapshotVersion(pkg)      newest on-disk `dev-*` snapshot
 *   - getBundleDir / getMiniappManifest     filesystem helpers used by hosts
 *   - subscribe(fn)                         register a refresh listener
 */

import {fetch as expoFetch} from "expo/fetch"
import {Directory, Paths, File} from "expo-file-system"
import {unzip} from "react-native-zip-archive"
import {createMMKV, type MMKV} from "react-native-mmkv"
import semver from "semver"
import {AsyncResult, Result, result as Res} from "typesafe-ts"

import type {AppletType, ClientApp} from "../types/applet"
import {HardwareRequirement, HardwareRequirementLevel, HardwareType} from "../types"
import {readBoundedByteStream} from "../utils/boundedByteStream"
import {configuredDevHost} from "../utils/configuredDevHost"
import {invalidateDevSnapshotRequests} from "../utils/devSnapshotRequests"
import {storage} from "../utils/storage/storage"
import {printDirectory} from "../utils/storage/zip"
import {sha256Hex} from "../utils/sha256"
import {
  assertMiniappDevelopmentAllowed,
  getConfigValues,
  isDevMiniappAllowed,
  isInstalledMiniappAllowed,
  isMiniappAvailable,
  isOfflineSystemMiniappAllowed,
} from "../runtime/bootstrap"
import {
  type ActivatedInstall,
  type ActivationArtifact,
  type InstallFinalization,
  completeInstallFilesystemTransaction,
  installedVersionDirectoryNames,
  interruptedActivationRecovery,
  isInstallScratchDirectoryName,
  nextInstallOperationId,
  parseActivationArtifact,
  runInstallFilesystemTransaction,
} from "./installOperation"
import {checkManifestVersions} from "./manifestVersionGate"
import {checkMiniappInstallCompatibility, type MiniappCompatibilityPolicy} from "./miniappInstallCompatibility"
import {normalizeManifestActions} from "./manifestActions"
import {normalizeManifestPermissions} from "./manifestPermissions"
import {
  assertMiniappUpdateVersion,
  miniappInstallIdentityError,
  type MiniappInstallExpectations,
} from "./miniappInstallIdentity"
import {miniappRunningRegistry} from "./MiniappRunningRegistry"
import {assertPublisherIdentityPolicy, assertUnsignedDevBuildAllowed} from "./publisherIdentityPolicy"
import {selectReleaseVersionsForGarbageCollection} from "./releaseVersionGc"
import {sameMiniappBundle} from "./sameMiniappBundle"
import {requiresConnectedGlasses} from "./SystemMiniappPolicy"
import {validateInstallBundleArchive} from "./validateInstallBundle"

export {normalizeManifestActions} from "./manifestActions"
export {normalizeManifestPermissions} from "./manifestPermissions"
export {SignedMiniappDevBuildError} from "./publisherIdentityPolicy"

function normalizeManifestType(raw: unknown): AppletType {
  return raw === "background" || raw === "system_dashboard" || raw === "standard" ? raw : "standard"
}

/**
 * Convert declared hardwareRequirements from a miniapp.json manifest into
 * runtime `HardwareRequirement[]`, always appending `{EXIST, REQUIRED}` so
 * launchers show "Glasses Required" when no glasses are connected.
 *
 * Malformed entries are dropped with a single warning per package so the
 * rest of the manifest still works.
 */
export function buildHardwareRequirements(
  raw: Array<{type: string; level: string; description?: string}> | undefined,
  packageName: string,
): HardwareRequirement[] {
  const out: HardwareRequirement[] = []
  const validTypes = new Set(Object.values(HardwareType) as string[])
  const validLevels = new Set(Object.values(HardwareRequirementLevel) as string[])

  if (!Array.isArray(raw)) {
    if (raw !== undefined) {
      console.warn(`APP_REGISTRY: ${packageName} has invalid hardwareRequirements (not an array); treating as []`)
    }
  } else {
    let warned = false
    for (const r of raw) {
      if (
        !r ||
        typeof r !== "object" ||
        typeof r.type !== "string" ||
        typeof r.level !== "string" ||
        !validTypes.has(r.type) ||
        !validLevels.has(r.level)
      ) {
        if (!warned) {
          console.warn(
            `APP_REGISTRY: ${packageName} has malformed hardwareRequirements entry; skipping invalid entries`,
            r,
          )
          warned = true
        }
        continue
      }
      out.push({
        type: r.type as HardwareType,
        level: r.level as HardwareRequirementLevel,
        ...(typeof r.description === "string" ? {description: r.description} : {}),
      })
    }
  }

  // Most miniapps require connected glasses. A Store manages apps from the
  // phone and runs its background updates while the glasses are away.
  if (requiresConnectedGlasses(packageName)) {
    out.push({type: HardwareType.EXIST, level: HardwareRequirementLevel.REQUIRED})
  }
  return out
}

interface InstalledInfo {
  name: string
  logoUrl: string
}

interface InstalledLma {
  packageName: string
  versions: Record<string, InstalledInfo>
}

export interface MiniappReleaseIdentity {
  /**
   * `store`: installed by a bundled Store. `system_store`: a bundled package
   * updated by the Store the build assigns to it. `preinstalled_registry`:
   * installed by Core's retired preinstall registry (read for existing installs).
   */
  source:
    | "direct_download"
    | "bundled_asset"
    | "preinstalled_registry"
    | "deployment_manifest"
    | "dev_snapshot"
    | "store"
    | "system_store"
  releaseId?: string
  bundleSha256?: string
  channel?: string
  /** The Store that installed this release (`store` / `system_store`). */
  storePackageName?: string
  deploymentId?: string
  deploymentOrigin?: string
  /**
   * Verified Ed25519 publisher fingerprint from the bundle's
   * `META-INF/MENTRA.SIG`. Set only by the installer after verification.
   */
  publisherKeyFingerprint?: string
}

/** Options shared by every install entry point. */
export interface InstallBundleOptions {
  /**
   * Install under this version instead of `manifest.version`. The dev caching
   * path uses `dev-<ms>` so snapshots coexist with semver-installed versions.
   */
  versionOverride?: string
  releaseIdentity?: MiniappReleaseIdentity
  /** The archive's manifest must name this package. */
  expectedPackageName?: string
  /** The archive's manifest must declare this version. */
  expectedVersion?: string
  /** Refuse to overwrite a version that is already installed. */
  rejectExistingVersion?: boolean
  /** The downloaded ZIP must have this SHA-256 (a Store's selected release). */
  expectedBundleSha256?: string
  /**
   * Bearer the calling Store already holds for its own backend. Attached
   * verbatim to the download only; never followed across a redirect, never
   * minted, inspected or reused by the host.
   */
  bundleAuthorization?: string
  /** Refuse a bundle this host or the user's glasses cannot run. */
  compatibilityPolicy?: MiniappCompatibilityPolicy | Omit<MiniappCompatibilityPolicy, "hardwareCapabilities">
  onProgress?: (phase: InstallProgressPhase) => void
  /**
   * Runs once the bundle is downloaded, verified, checked against the signer,
   * version and compatibility rules, and unpacked, before the serialized
   * activation. It may wait (for example for the user's consent) without
   * holding up other installs. Throwing discards the unpacked files.
   */
  whenStaged?: () => Promise<void>
  /**
   * Synchronous check run inside the serialized install, after extraction and
   * immediately before installed files change. Throwing aborts the install
   * and leaves the previous installation untouched.
   */
  beforeActivate?: () => void
}

export type InstallProgressPhase = "downloading" | "verifying" | "extracting" | "activating"

/** Local ZIP installs may additionally adopt an identical, already installed bundle. */
export interface LocalZipInstallOptions extends InstallBundleOptions {
  /** Host-only migration after the deployment ZIP's digest is verified. */
  adoptIdenticalInstalledVersion?: boolean
}

const MAX_REMOTE_BUNDLE_BYTES = 50 * 1024 * 1024
const REMOTE_BUNDLE_TIMEOUT_MS = 45_000
const INSTALL_METADATA_ROLLBACK_FILE = "metadata-rollback.json"

function releaseIdentityKey(packageName: string, version: string): string {
  return `miniapp_release_identity:${packageName}:${version}`
}

function publisherIdentityKey(packageName: string): string {
  return `miniapp_publisher_identity:${packageName}`
}

function activeVersionKey(packageName: string): string {
  return `${packageName}_active_version`
}

interface StorageSnapshot<T> {
  present: boolean
  value?: T
}

// Live-dev routing for a package. A release install clears it in the same
// metadata transaction that activates the release, so an interrupted install
// can never leave a committed release shadowed by its old dev registration.
const DEV_ROUTING_FIELDS = ["meta", "url", "port", "mdns", "last_reachable", "selected_snapshot"] as const
type DevRoutingSnapshot = Record<(typeof DEV_ROUTING_FIELDS)[number], StorageSnapshot<unknown>>

/** Written into the pending activation marker before any metadata changes. */
interface InstallMetadataRollbackJournal {
  schemaVersion: 1
  packageName: string
  version: string
  publisher: StorageSnapshot<string>
  release: StorageSnapshot<MiniappReleaseIdentity>
  active: StorageSnapshot<string>
  devRouting?: DevRoutingSnapshot
}

function snapshotStorage<T>(key: string): StorageSnapshot<T> {
  const loaded = storage.load<T>(key)
  return loaded.is_ok() ? {present: true, value: loaded.value} : {present: false}
}

function restoreStorage<T>(key: string, snapshot: StorageSnapshot<T>): void {
  if (!snapshot.present) {
    const removed = storage.remove(key)
    if (removed.is_error()) throw removed.error
    return
  }
  const restored = storage.save(key, snapshot.value)
  if (restored.is_error()) throw restored.error
}

function isStorageSnapshot(value: unknown, valueType: "object" | "string" | "any"): value is StorageSnapshot<unknown> {
  if (!value || typeof value !== "object" || typeof (value as {present?: unknown}).present !== "boolean") return false
  const snapshot = value as {present: boolean; value?: unknown}
  if (!snapshot.present) return true
  if (valueType === "any") return Object.prototype.hasOwnProperty.call(snapshot, "value")
  return valueType === "string"
    ? typeof snapshot.value === "string"
    : Boolean(snapshot.value && typeof snapshot.value === "object" && !Array.isArray(snapshot.value))
}

function readMetadataRollbackJournal(
  pendingDir: Directory,
  packageName: string,
  version: string,
): InstallMetadataRollbackJournal | null {
  try {
    const file = new File(pendingDir, INSTALL_METADATA_ROLLBACK_FILE)
    if (!file.exists) return null
    const parsed = JSON.parse(file.textSync()) as Partial<InstallMetadataRollbackJournal>
    if (
      parsed.schemaVersion !== 1 ||
      parsed.packageName !== packageName ||
      parsed.version !== version ||
      !isStorageSnapshot(parsed.publisher, "string") ||
      !isStorageSnapshot(parsed.release, "object") ||
      !isStorageSnapshot(parsed.active, "string") ||
      (parsed.devRouting !== undefined &&
        (!parsed.devRouting ||
          DEV_ROUTING_FIELDS.some((field) => !isStorageSnapshot(parsed.devRouting?.[field], "any"))))
    ) {
      console.warn(`APP_REGISTRY: ignoring invalid metadata rollback journal for ${packageName}@${version}`)
      return null
    }
    return parsed as InstallMetadataRollbackJournal
  } catch (error) {
    // Metadata writes start only after this file has been written successfully,
    // so a missing/corrupt journal means there is no partial metadata commit to
    // undo. Filesystem rollback remains safe and authoritative.
    console.warn(`APP_REGISTRY: could not read metadata rollback journal for ${packageName}@${version}`, error)
    return null
  }
}

// Bundle files survive logout; their provenance and publisher must survive with
// them. Keep installation metadata out of the default, session-cleared MMKV store.
let installationMetadata: MMKV | undefined
function getInstallationMetadata(): MMKV {
  return (installationMetadata ??= createMMKV({id: "mentra-miniapp-installations"}))
}

function snapshotInstallationMetadata<T>(key: string): StorageSnapshot<T> {
  const metadata = getInstallationMetadata()
  const stored = metadata.getString(key)
  if (stored) return {present: true, value: JSON.parse(stored) as T}
  // Migrate pre-upgrade metadata from the default store when it still exists.
  const legacy = snapshotStorage<T>(key)
  if (legacy.present) {
    metadata.set(key, JSON.stringify(legacy.value))
    storage.remove(key)
  }
  return legacy
}

function restoreInstallationMetadata<T>(key: string, snapshot: StorageSnapshot<T>): void {
  const metadata = getInstallationMetadata()
  if (snapshot.present) metadata.set(key, JSON.stringify(snapshot.value))
  else metadata.remove(key)
  const removed = storage.remove(key)
  if (removed.is_error()) throw removed.error
}

function restoreDevRouting(packageName: string, snapshot: DevRoutingSnapshot): void {
  for (const field of DEV_ROUTING_FIELDS) restoreStorage(`${packageName}_dev_${field}`, snapshot[field])
}

function restoreInstallMetadata(journal: InstallMetadataRollbackJournal): void {
  if (journal.devRouting) restoreDevRouting(journal.packageName, journal.devRouting)
  restoreStorage(activeVersionKey(journal.packageName), journal.active)
  restoreInstallationMetadata(releaseIdentityKey(journal.packageName, journal.version), journal.release)
  restoreInstallationMetadata(publisherIdentityKey(journal.packageName), journal.publisher)
}

/** The installed signer decides which bundles may replace a package. */
function assertPublisherContinuity(packageName: string, publisherKeyFingerprint: string | undefined): void {
  const installed = snapshotInstallationMetadata<string>(publisherIdentityKey(packageName))
  assertPublisherIdentityPolicy({
    packageName,
    candidateFingerprint: publisherKeyFingerprint,
    installedFingerprint: installed.present ? installed.value : null,
  })
}

function assertInstallCompatibility(
  manifest: Awaited<ReturnType<typeof validateInstallBundleArchive>>,
  policy: NonNullable<InstallBundleOptions["compatibilityPolicy"]>,
): void {
  if (!("hardwareCapabilities" in policy)) {
    const versions = checkManifestVersions(manifest, policy)
    if (!versions.ok) throw new Error(versions.reason)
    return
  }
  const compatibility = checkMiniappInstallCompatibility(manifest, policy)
  if (!compatibility.compatible) throw new Error(compatibility.reason)
}

/**
 * Download a miniapp zip from `url` and return its bytes. The response is
 * streamed through a size ceiling and a deadline, so an attacker-controlled
 * server cannot exhaust memory or hang an install. An expected SHA-256 is
 * checked before any other step reads the bytes.
 */
async function downloadMiniAppZip(
  url: string,
  options: Pick<InstallBundleOptions, "expectedBundleSha256" | "bundleAuthorization" | "onProgress"> = {},
): Promise<Uint8Array> {
  const abortController = new AbortController()
  const timeout = setTimeout(() => abortController.abort(), REMOTE_BUNDLE_TIMEOUT_MS)
  try {
    options.onProgress?.("downloading")
    // React Native's global fetch polyfill does not expose Response.body.
    // Expo fetch provides the native ReadableStream required for bounded
    // downloads without buffering an attacker-controlled response first.
    const requestUrl = new URL(url)
    const authorization = options.bundleAuthorization?.trim()
    const response = await expoFetch(
      url,
      authorization
        ? {
            signal: abortController.signal,
            headers: {Authorization: `Bearer ${authorization}`},
            // Never forward the caller's bearer credential through a redirect.
            redirect: "error",
          }
        : {signal: abortController.signal},
    )
    if (!response.ok) throw new Error(`bundle download failed with HTTP ${response.status}`)
    if (requestUrl.protocol === "https:" && response.url && new URL(response.url).protocol !== "https:") {
      throw new Error("bundle download redirected away from HTTPS")
    }
    if (authorization && response.url && new URL(response.url).origin !== requestUrl.origin) {
      throw new Error("authorized bundle download changed origin")
    }
    const declaredSize = Number(response.headers.get("content-length"))
    if (Number.isFinite(declaredSize) && declaredSize > MAX_REMOTE_BUNDLE_BYTES) {
      throw new Error(`bundle exceeds ${MAX_REMOTE_BUNDLE_BYTES} bytes`)
    }
    if (!response.body) throw new Error("bundle download returned no response body")
    const bytes = await readBoundedByteStream(response.body, MAX_REMOTE_BUNDLE_BYTES)
    if (bytes.byteLength === 0) {
      throw new Error(`bundle must be between 1 and ${MAX_REMOTE_BUNDLE_BYTES} bytes`)
    }
    if (options.expectedBundleSha256 !== undefined) {
      const expected = options.expectedBundleSha256.toLowerCase()
      if (!/^[a-f0-9]{64}$/.test(expected)) throw new Error("expected bundle SHA-256 is invalid")
      const actual = await sha256Hex(bytes)
      if (actual !== expected) throw new Error(`bundle SHA-256 mismatch: expected ${expected}, got ${actual}`)
    }
    return bytes
  } catch (error) {
    console.error("ZIP: Error downloading zip file", error)
    if (abortController.signal.aborted) {
      throw new Error(`bundle download timed out after ${REMOTE_BUNDLE_TIMEOUT_MS}ms`)
    }
    throw error instanceof Error ? error : new Error("bundle download failed")
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Write validated archive bytes to a unique host-owned cache file. Native
 * extraction reads this private copy, never a caller's path that could change
 * while the install waits in the queue. Startup cleanup removes leftovers.
 */
function writePrivateArchive(bytes: Uint8Array): File {
  const directory = new Directory(Paths.cache, "lma_downloads")
  try {
    if (!directory.exists) directory.create()
  } catch (error) {
    console.error("ZIP: Error creating the archive cache directory", error)
    throw new Error("CREATE_DOWNLOAD_DIR_FAILED")
  }
  // Never derive the name from an untrusted URL or caller path, and never let
  // two simultaneous installs alias the same file.
  const archive = new File(
    directory,
    `bundle-${nextInstallOperationId()}-${Math.random().toString(36).slice(2, 10)}.zip`,
  )
  archive.write(bytes)
  return archive
}

type AdoptExistingBundle = (
  packageName: string,
  version: string,
  extracted: Directory,
  installed: Directory,
) => Promise<boolean>

interface InstalledBundle {
  packageName: string
  version: string
}

interface UnpackOptions {
  onProgress?: InstallBundleOptions["onProgress"]
  whenStaged?: InstallBundleOptions["whenStaged"]
}

/**
 * Unpack a local miniapp zip and install it under
 * `lmas/<packageName>/<version>/` inside the serialized install transaction.
 *
 * Zip layout: flat — files at root, `miniapp.json` at the top level. We're
 * strict on shape so we fail loudly on malformed bundles.
 *
 * `validate` runs first inside the queue (after any earlier install
 * committed), `beforeActivate` runs after extraction and before installed
 * files change, and `finalize` writes registry metadata before the atomic
 * commit. Any failure before commit restores the previous installation.
 *
 * With `whenStaged`, extraction happens first, into a private cache directory
 * outside the queue, and the hook may wait before the queue is entered; the
 * queue then activates the already-unpacked files. Without it, extraction stays
 * inside the queue.
 *
 * @param zipPath          file:// URI of the zip on local disk.
 * @param versionOverride  override the manifest's version field (dev snapshots).
 */
async function unpackMiniApp(
  zipPath: string,
  versionOverride: string | undefined,
  expected: MiniappInstallExpectations,
  finalize: (
    installed: InstalledBundle,
    activation: ActivatedInstall<InstalledBundle>,
  ) => InstallFinalization | Promise<InstallFinalization>,
  beforeActivate: () => void,
  validate: () => void,
  adoptExisting?: AdoptExistingBundle,
  options: UnpackOptions = {},
): Promise<InstalledBundle> {
  if (!options.whenStaged) {
    return completeInstallFilesystemTransaction(
      () =>
        withExtractedMiniApp(zipPath, expected, options.onProgress, (extracted) =>
          activateExtractedMiniApp(
            extracted,
            versionOverride,
            expected,
            beforeActivate,
            adoptExisting,
            options.onProgress,
          ),
        ),
      finalize,
      validate,
    )
  }
  const whenStaged = options.whenStaged
  return withExtractedMiniApp(zipPath, expected, options.onProgress, async (extracted) => {
    await whenStaged()
    return completeInstallFilesystemTransaction(
      () =>
        activateExtractedMiniApp(
          extracted,
          versionOverride,
          expected,
          beforeActivate,
          adoptExisting,
          options.onProgress,
        ),
      finalize,
      validate,
    )
  })
}

interface ExtractedMiniApp {
  directory: Directory
  operationId: string
  packageName: string
  manifestVersion: string
}

/** Unzip into a private cache directory, run `run`, and always remove the directory afterwards. */
async function withExtractedMiniApp<T>(
  zipPath: string,
  expected: MiniappInstallExpectations,
  onProgress: InstallBundleOptions["onProgress"],
  run: (extracted: ExtractedMiniApp) => Promise<T>,
): Promise<T> {
  const operationId = nextInstallOperationId()
  const unzipDir = new Directory(Paths.cache, `lma_unzip-${operationId}`)
  try {
    unzipDir.create()
  } catch (error) {
    console.error("ZIP: Error creating the unzip directory", error)
    throw new Error("CREATE_CACHE_DIR_FAILED")
  }

  try {
    return await run(await extractMiniApp(zipPath, unzipDir, operationId, expected, onProgress))
  } finally {
    try {
      if (unzipDir.exists) unzipDir.delete()
    } catch (error) {
      console.warn("ZIP: Error cleaning the unzip directory", error)
    }
  }
}

async function extractMiniApp(
  zipPath: string,
  unzipDir: Directory,
  operationId: string,
  expected: MiniappInstallExpectations,
  onProgress: InstallBundleOptions["onProgress"],
): Promise<ExtractedMiniApp> {
  try {
    onProgress?.("extracting")
    console.log("ZIP: unzipping", zipPath)
    await unzip(zipPath, unzipDir.uri)
  } catch (error) {
    console.error("Error unzipping zip file", error)
    throw new Error("UNZIP_FAILED")
  }

  // Strict zip shape: miniapp.json at unzip root. No tolerance for an
  // enclosing folder or app.json fallback — we own the dev-server emit
  // format, so any deviation indicates a corrupt bundle.
  const appDir = unzipDir
  let packageName: string
  let manifestVersion: string
  try {
    const miniappJsonFile = new File(appDir, "miniapp.json")
    if (!miniappJsonFile.exists) throw new Error("miniapp.json missing at zip root")
    const manifest = JSON.parse(miniappJsonFile.textSync())
    if (!manifest.packageName) throw new Error("miniapp.json missing packageName")
    if (!manifest.version) throw new Error("miniapp.json missing version")
    packageName = manifest.packageName
    manifestVersion = manifest.version
  } catch (error) {
    console.error("Error reading miniapp.json from zip:", error)
    throw new Error("READ_MANIFEST_FAILED")
  }
  // The extracted manifest must be the one that was validated.
  const identityError = miniappInstallIdentityError({packageName, version: manifestVersion}, expected)
  if (identityError) throw new Error(identityError)
  return {directory: unzipDir, operationId, packageName, manifestVersion}
}

async function activateExtractedMiniApp(
  extracted: ExtractedMiniApp,
  versionOverride: string | undefined,
  expected: MiniappInstallExpectations,
  beforeActivate: () => void,
  adoptExisting: AdoptExistingBundle | undefined,
  onProgress: InstallBundleOptions["onProgress"],
): Promise<ActivatedInstall<InstalledBundle>> {
  const {directory: appDir, operationId, packageName} = extracted
  const version = versionOverride ?? extracted.manifestVersion
  console.log(`ZIP: installing ${packageName} as version ${version}`)

  const basePackageDir = new Directory(Paths.document, "lmas", packageName)
  try {
    if (!basePackageDir.exists) {
      basePackageDir.create({intermediates: true})
    }
  } catch (error) {
    console.error("Error creating the base package directory", error)
    throw new Error("CREATE_PACKAGE_DIR_FAILED")
  }

  const directory = (name: string) => new Directory(basePackageDir, name)
  const stagingName = `.staging-${version}-${operationId}`
  const backupName = `.backup-${version}-${operationId}`
  const hadExisting = directory(version).exists
  let adoptingExisting = false
  if (expected.rejectExistingVersion && hadExisting) {
    // A verified deployment may claim identical bundled bytes without replacing
    // the installed directory. Ownership still commits through the same journal.
    adoptingExisting = Boolean(adoptExisting && (await adoptExisting(packageName, version, appDir, directory(version))))
    if (!adoptingExisting) throw new Error(`Miniapp ${packageName}@${version} is already installed`)
  }
  const activationKind = hadExisting ? "existing" : "new"
  const pendingName = `.pending-${activationKind}-${version}-${operationId}`
  const committedName = `.committed-${activationKind}-${version}-${operationId}`
  try {
    if (!adoptingExisting) directory(stagingName).create()
  } catch (error) {
    console.error("Error creating the staging directory", error)
    throw new Error("CREATE_VERSION_DIR_FAILED")
  }

  try {
    const contents = adoptingExisting ? [] : appDir.list()
    for (const item of contents) {
      item.move(directory(stagingName))
    }
  } catch (error) {
    console.error("Error moving the contents of the folder to the destination directory", error)
    if (directory(stagingName).exists) directory(stagingName).delete()
    throw new Error("INSTALL_CONTENTS_FAILED")
  }

  // Recheck the signer and version rules (and any caller guard) now that the
  // bundle is staged and no installed file has changed yet.
  try {
    beforeActivate()
  } catch (error) {
    if (directory(stagingName).exists) directory(stagingName).delete()
    throw error
  }

  // Swap only after the complete bundle is staged. If activation fails,
  // restore a previous same-version directory instead of leaving a partial
  // installation behind.
  let movedExisting = false
  onProgress?.("activating")
  try {
    // Move an existing target aside before creating the pending marker. A
    // crash in that first move leaves only a backup, which startup restores.
    // Once the marker exists its name records whether a prior target existed,
    // making recovery idempotent even if it is interrupted itself.
    if (!adoptingExisting && directory(version).exists) {
      directory(version).move(directory(backupName))
      movedExisting = true
    }
    directory(pendingName).create()
    if (!adoptingExisting) directory(stagingName).move(directory(version))
  } catch (error) {
    console.error("Error activating the staged miniapp", error)
    try {
      if (movedExisting) {
        if (directory(version).exists) directory(version).delete()
        if (directory(backupName).exists) directory(backupName).move(directory(version))
      } else if (!hadExisting && directory(version).exists) {
        // No prior install can be harmed; remove a partially moved first
        // install if the filesystem move failed after creating its target.
        directory(version).delete()
      }
      if (directory(stagingName).exists) directory(stagingName).delete()
      if (directory(pendingName).exists) directory(pendingName).delete()
    } catch (rollbackError) {
      console.error("Error restoring the previous miniapp version", rollbackError)
    }
    throw new Error("ACTIVATE_VERSION_FAILED")
  }

  console.log("ZIP: local mini app installed at", directory(version).uri)
  printDirectory(directory(version), 2)
  return {
    value: {packageName, version},
    commit: () => {
      // Renaming the journal is the atomic commit boundary. Recovery keeps a
      // candidate with a committed marker and rolls back one with a pending
      // marker. Cleanup after the rename may be retried on the next launch.
      if (directory(pendingName).exists) directory(pendingName).move(directory(committedName))
      else if (!directory(committedName).exists) throw new Error("activation journal disappeared before commit")
      try {
        if (directory(backupName).exists) directory(backupName).delete()
        if (directory(committedName).exists) directory(committedName).delete()
      } catch (error) {
        console.warn("ZIP: Error cleaning committed miniapp activation artifacts", error)
      }
    },
    rollback: (options?: {preserveRecoveryState?: boolean}) => {
      try {
        if (options?.preserveRecoveryState && directory(committedName).exists) {
          if (directory(pendingName).exists) directory(committedName).delete()
          else directory(committedName).move(directory(pendingName))
        }
        if (!adoptingExisting) {
          if (directory(version).exists) directory(version).delete()
          if (directory(backupName).exists) directory(backupName).move(directory(version))
        }
        if (!options?.preserveRecoveryState) {
          if (directory(pendingName).exists) directory(pendingName).delete()
          if (directory(committedName).exists) directory(committedName).delete()
        }
      } catch (error) {
        console.error("ZIP: Error rolling back miniapp after metadata finalization failed", error)
        throw error
      }
    },
    recordRecoveryState: (serializedState: string) => {
      const file = new File(directory(pendingName), INSTALL_METADATA_ROLLBACK_FILE)
      file.write(serializedState)
    },
  }
}

function directoryNames(directory: Directory): string[] {
  return directory
    .list()
    .filter((entry): entry is Directory => entry instanceof Directory)
    .map((entry) => entry.name)
}

/** Delete the locally cached icon named by a serialized dev record, best effort. */
function deleteCachedDevIcon(serializedRecord: string, packageName: string): void {
  try {
    const iconUrl = (JSON.parse(serializedRecord) as Partial<DevAppRecord>).iconUrl
    if (typeof iconUrl !== "string" || !iconUrl.startsWith("file://")) return
    const icon = new File(iconUrl)
    if (icon.exists) icon.delete()
  } catch (error) {
    console.warn(`APP_REGISTRY: failed to delete dev icon for ${packageName}:`, error)
  }
}

type Listener = () => void

class AppRegistry {
  private cachedApps: ClientApp[] = []
  // Offline apps live in a separate layer so they survive the disk-rebuild
  // path in getInstalledMiniapps (which reassigns cachedApps).
  private offlineApps: ClientApp[] = []
  /** Package names whose start() requires the on-device STT model (host-declared). */
  private sttModelRequired = new Set<string>()
  private refreshNeeded: boolean = true
  private listeners = new Set<Listener>()
  private retainedDevVersions = new Map<string, Set<string>>()

  /** Hold the running and rollback bundles while an explicit replacement settles. */
  public retainDevVersions(packageName: string, versions: string[]): () => void {
    if (this.retainedDevVersions.has(packageName)) throw new Error("A miniapp replacement is already in progress")
    this.retainedDevVersions.set(packageName, new Set(versions.filter(version => version.startsWith("dev-"))))
    return () => {this.retainedDevVersions.delete(packageName)}
  }

  private protectedDevVersions(packageName: string): Set<string> {
    const versions = new Set(this.retainedDevVersions.get(packageName))
    const selected = this.getSelectedDevSnapshot(packageName)
    if (selected) versions.add(selected)
    const active = storage.load<string>(activeVersionKey(packageName))
    if (active.is_ok() && active.value.startsWith("dev-") && miniappRunningRegistry.has(packageName)) versions.add(active.value)
    return versions
  }

  private removeReleaseIdentity(packageName: string, version: string): void {
    const key = releaseIdentityKey(packageName, version)
    getInstallationMetadata().remove(key)
    storage.remove(key)
  }

  private static instance: AppRegistry | null = null

  private constructor() {
    this.cleanupInterruptedInstallCache()
    this.recoverInterruptedActivations()
  }

  /** Remove cache artifacts left behind when the process died mid-install. */
  private cleanupInterruptedInstallCache(): void {
    try {
      for (const item of Paths.cache.list()) {
        if (item instanceof Directory && isInstallScratchDirectoryName(item.name)) item.delete()
      }

      const downloadDir = new Directory(Paths.cache, "lma_downloads")
      if (downloadDir.exists) {
        for (const item of downloadDir.list()) item.delete()
      }
    } catch (error) {
      console.warn("APP_REGISTRY: interrupted install cache cleanup failed", error)
    }
  }

  /**
   * Recover an activation interrupted by process death. Pending markers roll
   * back both durable metadata and the filesystem; their encoded prior-target
   * state makes that rollback idempotent. A committed marker is the opposite:
   * metadata and the candidate are authoritative and only cleanup remains.
   * Unjournaled backups are restored when their target is absent. Staging
   * directories are always inert and removable.
   */
  private recoverInterruptedActivations(): void {
    try {
      const lmasDir = new Directory(Paths.document, "lmas")
      if (!lmasDir.exists) return
      for (const packageDir of lmasDir.list()) {
        if (!(packageDir instanceof Directory)) continue
        const artifacts = packageDir
          .list()
          .filter((item): item is Directory => item instanceof Directory)
          .map((directory) => ({directory, parsed: parseActivationArtifact(directory.name)}))
          .filter((item): item is {directory: Directory; parsed: ActivationArtifact} => item.parsed !== null)

        const committed = artifacts
          .filter((item) => item.parsed.kind === "committed")
          .sort((left, right) => right.parsed.timestamp - left.parsed.timestamp)
        for (const {directory, parsed} of committed) {
          const matchingBackup = artifacts.find(
            (item) =>
              item.parsed.kind === "backup" &&
              item.parsed.version === parsed.version &&
              item.parsed.timestamp === parsed.timestamp,
          )?.directory
          if (matchingBackup?.exists) matchingBackup.delete()
          if (directory.exists) directory.delete()
        }

        const pending = artifacts
          .filter((item) => item.parsed.kind === "pending")
          .sort((left, right) => right.parsed.timestamp - left.parsed.timestamp)
        for (const {directory, parsed} of pending) {
          const target = new Directory(packageDir, parsed.version)
          const matchingBackup = artifacts.find(
            (item) =>
              item.parsed.kind === "backup" &&
              item.parsed.version === parsed.version &&
              item.parsed.timestamp === parsed.timestamp,
          )?.directory
          const metadataJournal = readMetadataRollbackJournal(directory, packageDir.name, parsed.version)
          if (metadataJournal) restoreInstallMetadata(metadataJournal)

          const recovery = interruptedActivationRecovery({
            hasBackup: matchingBackup?.exists === true,
            hadExisting: parsed.hadExisting === true,
          })
          if (recovery === "restore-backup") {
            if (target.exists) target.delete()
            new Directory(packageDir, matchingBackup!.name).move(target)
          } else if (recovery === "remove-target" && target.exists) {
            target.delete()
          }
          if (directory.exists) directory.delete()
        }

        const backups = artifacts
          .filter((item) => item.parsed.kind === "backup")
          .sort((left, right) => right.parsed.timestamp - left.parsed.timestamp)
        for (const {directory, parsed} of backups) {
          const target = new Directory(packageDir, parsed.version)
          if (!directory.exists) continue
          if (target.exists) directory.delete()
          else new Directory(packageDir, directory.name).move(target)
        }
        for (const {directory, parsed} of artifacts) {
          if (
            (parsed.kind === "staging" || parsed.kind === "pending" || parsed.kind === "committed") &&
            directory.exists
          ) {
            directory.delete()
          }
        }
      }
    } catch (error) {
      console.warn("APP_REGISTRY: interrupted activation recovery failed", error)
    }
  }

  public static getInstance(): AppRegistry {
    if (!AppRegistry.instance) {
      AppRegistry.instance = new AppRegistry()
    }
    return AppRegistry.instance
  }

  /** Subscribe to install/uninstall events. Listener fires after refreshNeeded flips. */
  public subscribe(fn: Listener): () => void {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  private notify(): void {
    for (const fn of this.listeners) {
      try {
        fn()
      } catch (e) {
        console.warn("AppRegistry: listener threw", e)
      }
    }
  }

  /**
   * On-disk path for a given miniapp bundle version.
   */
  public getBundleDir(packageName: string, version: string): string {
    const bundleDir = new Directory(Paths.document, "lmas", packageName, version)
    return bundleDir.uri
  }

  /**
   * Resolve the two-layer entry paths for an installed miniapp version.
   * Returns absolute file:// URIs for `background` and (when present) `ui`.
   *
   * Legacy single-layer bundles (no `entry` object in manifest) fall back
   * to `index.html` discovery so the WebView host keeps working unchanged.
   * Two-layer bundles ship `entry.background` and optional `entry.ui`
   * paths relative to the bundle root.
   *
   * Returns null if neither shape resolves to existing files on disk.
   */
  public getMiniappEntryPaths(
    packageName: string,
    version: string,
  ): {background: string | null; ui: string | null} | null {
    const manifest = this.getMiniappManifest(packageName, version) as {
      entry?: {background?: string; ui?: string}
    } | null
    const bundleDir = this.getBundleDir(packageName, version)
    const resolve = (rel: string): string | null => {
      const trimmed = rel.replace(/^\.?\/+/, "")
      const file = new File(bundleDir, trimmed)
      return file.exists ? file.uri : null
    }
    if (manifest?.entry) {
      console.log("manifest.entry", manifest.entry)
      const bg = manifest.entry.background ? resolve(manifest.entry.background) : null
      console.log("bg", bg)
      const ui = manifest.entry.ui ? resolve(manifest.entry.ui) : null
      console.log("ui", ui)
      if (bg || ui) {
        return {background: bg, ui: ui}
      }
    }
    // Legacy single-bundle fallback — `index.html` at the bundle root.
    const legacy = new File(new Directory(bundleDir.replace(/^file:\/\//, "")), "index.html")
    return {
      background: null,
      ui: legacy.exists ? legacy.uri : null,
    }
  }

  /**
   * Verify a manifest declares an SDK / host version range compatible
   * with the current host. Delegates to the pure
   * {@link checkManifestVersions} helper — same shape, no React Native
   * imports, unit-testable. Manifests missing either field pass
   * through unchanged (legacy single-layer path).
   */
  public checkManifestVersions(
    manifest: {sdkVersion?: string; minHostVersion?: string} | null,
    options: {hostVersion: string; supportedSdkRange: string},
  ): {ok: true} | {ok: false; reason: string} {
    return checkManifestVersions(manifest, options)
  }

  /**
   * Read and parse the miniapp manifest (miniapp.json with app.json fallback)
   * from a given bundle directory.
   */
  public getMiniappManifest(packageName: string, version: string): any {
    const bundleDir = new Directory(Paths.document, "lmas", packageName, version)
    try {
      const miniappJsonFile = new File(bundleDir, "miniapp.json")
      if (miniappJsonFile.exists) {
        return JSON.parse(miniappJsonFile.textSync())
      }
    } catch (e) {
      console.warn("AppRegistry: Error reading miniapp.json, trying app.json fallback", e)
    }
    try {
      const appJsonFile = new File(bundleDir, "app.json")
      if (appJsonFile.exists) {
        return JSON.parse(appJsonFile.textSync())
      }
    } catch (e) {
      console.warn("AppRegistry: Error reading app.json fallback", e)
    }
    return null
  }

  /**
   * One version rule for every install source: an incoming release must be
   * greater than or equal to every installed release; an equal version is a
   * reinstall. Dev snapshot versions (`dev-*`) are sessions, not releases.
   */
  public assertCanInstallVersion(packageName: string, version: string): void {
    const policy = getConfigValues().localMiniappPolicy
    const workspaceManaged = policy?.managed.some((entry) => entry.packageName === packageName) ?? false
    const installed = this.getInstalledVersions(packageName).filter((installedVersion) => {
      if (!policy) return true
      // In a workspace, consumer releases retained on disk are not installations
      // in that environment; compare only releases its policy can use. For a
      // package the workspace manages, its deployment releases are the
      // installation, never a consumer copy of the same package.
      const identity = this.getReleaseIdentity(packageName, installedVersion)
      if (workspaceManaged && identity?.source !== "deployment_manifest") return false
      return isInstalledMiniappAllowed(packageName, installedVersion, identity)
    })
    assertMiniappUpdateVersion(packageName, version, installed)
  }

  /**
   * Download and install a miniapp bundle from a URL. The URL must serve a
   * zip whose root contains `miniapp.json` plus the bundle entry files.
   * The bundle goes through the same validated transaction as every other
   * install source; see {@link InstallBundleOptions}.
   */
  public installFromUrl(url: string, opts?: InstallBundleOptions): AsyncResult<void, Error> {
    return Res.try_async(async () => {
      if (opts?.expectedPackageName) this.assertNoReplacementInProgress(opts.expectedPackageName, opts.versionOverride)
      const bytes = await downloadMiniAppZip(url, {
        expectedBundleSha256: opts?.expectedBundleSha256,
        bundleAuthorization: opts?.bundleAuthorization,
        onProgress: opts?.onProgress,
      })
      console.log("ZIP: done downloading, starting unzip")
      await this.installArchive(bytes, opts, false)
      console.log("APP_REGISTRY: Downloaded and installed mini app")
    })
  }

  /**
   * Install a miniapp from a zip already on local disk (e.g. a bundled asset
   * copied into cache). Skips the HTTP download path that `installFromUrl`
   * uses; otherwise identical, including every installation check.
   *
   * @param zipPath  file:// URI of the local zip.
   */
  public installFromLocalZip(
    zipPath: string,
    opts?: LocalZipInstallOptions,
  ): AsyncResult<{packageName: string; version: string}, Error> {
    return Res.try_async(async () => {
      if (opts?.expectedPackageName) this.assertNoReplacementInProgress(opts.expectedPackageName, opts.versionOverride)
      if (
        opts?.adoptIdenticalInstalledVersion &&
        (opts.releaseIdentity?.source !== "deployment_manifest" ||
          !opts.expectedPackageName ||
          !opts.expectedVersion ||
          opts.versionOverride ||
          !opts.rejectExistingVersion)
      )
        throw new Error("Bundle adoption requires a verified deployment release with an exact identity")
      // Read the caller's file once. Validation and extraction both use this
      // snapshot, so replacing the file afterwards cannot change what installs.
      const bytes = await new File(zipPath).bytes()
      if (opts?.expectedBundleSha256 !== undefined) {
        const expected = opts.expectedBundleSha256.toLowerCase()
        const actual = await sha256Hex(bytes)
        if (actual !== expected) throw new Error(`bundle SHA-256 mismatch: expected ${expected}, got ${actual}`)
      }
      const installed = await this.installArchive(
        bytes,
        opts,
        true,
        opts?.adoptIdenticalInstalledVersion
          ? async (pkg, ver, extracted, installedDir) => {
              const identity = this.getReleaseIdentity(pkg, ver)
              return identity?.source !== "deployment_manifest" && (await sameMiniappBundle(extracted, installedDir))
            }
          : undefined,
      )
      console.log("APP_REGISTRY: Installed mini app from local zip")
      return installed
    })
  }

  /**
   * A release may not land while a dev build replacement of the same package
   * (retainDevVersions) is settling; dev snapshots belong to that replacement.
   * Checked before download, inside the serialized install, and at commit.
   */
  private assertNoReplacementInProgress(packageName: string, version: string | undefined): void {
    if (!version?.startsWith("dev-") && this.retainedDevVersions.has(packageName))
      throw new Error("Cannot install a release during miniapp replacement")
  }

  /**
   * The one installer. Validates the archive bytes, then extracts and
   * activates them in the serialized filesystem transaction. The signer and
   * version rules are checked before extraction and again inside the queue
   * immediately before any installed file changes, so a competing install
   * that commits first cannot make this one's earlier decision valid.
   */
  private async installArchive(
    bytes: Uint8Array,
    opts: InstallBundleOptions | undefined,
    localZip: boolean,
    adoptExisting?: AdoptExistingBundle,
  ): Promise<InstalledBundle> {
    const expected = {packageName: opts?.expectedPackageName, version: opts?.expectedVersion}
    opts?.onProgress?.("verifying")
    const manifest = await validateInstallBundleArchive(bytes, expected)
    // The artifact must be the package and version its source selected.
    const identityError = miniappInstallIdentityError(manifest, expected)
    if (identityError) throw new Error(identityError)
    // The bundle's own manifest decides compatibility, not the catalog that offered it.
    if (opts?.compatibilityPolicy) assertInstallCompatibility(manifest, opts.compatibilityPolicy)
    const version = opts?.versionOverride ?? manifest.version
    // The publisher fingerprint only ever comes from signature verification.
    const {publisherKeyFingerprint: _callerFingerprint, ...callerIdentity} = opts?.releaseIdentity ?? {
      source: version.startsWith("dev-") ? "dev_snapshot" : localZip ? "bundled_asset" : "direct_download",
    }
    const releaseIdentity: MiniappReleaseIdentity = {
      ...callerIdentity,
      ...(manifest.publisherKeyFingerprint ? {publisherKeyFingerprint: manifest.publisherKeyFingerprint} : {}),
    }
    const validateTrust = () => {
      this.assertNoReplacementInProgress(manifest.packageName, version)
      assertPublisherContinuity(manifest.packageName, manifest.publisherKeyFingerprint)
      this.assertCanInstallVersion(manifest.packageName, version)
    }
    // Fail fast before extraction; the transaction checks again under the queue.
    validateTrust()
    // Extract exactly the bytes that were validated.
    const archive = writePrivateArchive(bytes)
    try {
      return await unpackMiniApp(
        archive.uri,
        opts?.versionOverride,
        {
          packageName: manifest.packageName,
          version: manifest.version,
          rejectExistingVersion: opts?.rejectExistingVersion,
        },
        ({packageName, version: installedVersion}, activation) =>
          this.finalizeInstall(packageName, installedVersion, releaseIdentity, (state) =>
            activation.recordRecoveryState(state),
          ),
        () => {
          validateTrust()
          opts?.beforeActivate?.()
        },
        validateTrust,
        adoptExisting,
        {onProgress: opts?.onProgress, whenStaged: opts?.whenStaged},
      )
    } finally {
      try {
        if (archive.exists) archive.delete()
      } catch (error) {
        console.warn("ZIP: Error removing the private archive copy", error)
      }
    }
  }

  /**
   * Registry metadata for an activation, applied before the atomic commit:
   * the verified publisher (recorded the first time a signed bundle installs),
   * the release identity, the active-version pointer, and — for a release —
   * the removal of the package's live-dev routing. A rollback journal is
   * written first so a crash before commit restores all of it.
   */
  private finalizeInstall(
    packageName: string,
    version: string,
    releaseIdentity: MiniappReleaseIdentity,
    recordRecoveryState: (serializedState: string) => void,
  ): InstallFinalization {
    const publisherKey = publisherIdentityKey(packageName)
    const releaseKey = releaseIdentityKey(packageName, version)
    const activeKey = activeVersionKey(packageName)
    const releaseInstall = !version.startsWith("dev-")
    const publisherBefore = snapshotInstallationMetadata<string>(publisherKey)
    const previousRelease = this.getReleaseIdentity(packageName, version)
    const releaseBefore: StorageSnapshot<MiniappReleaseIdentity> = previousRelease
      ? {present: true, value: previousRelease}
      : {present: false}
    const activeBefore = snapshotStorage<string>(activeKey)
    const devRoutingBefore = releaseInstall
      ? (Object.fromEntries(
          DEV_ROUTING_FIELDS.map((field) => [field, snapshotStorage(`${packageName}_dev_${field}`)]),
        ) as DevRoutingSnapshot)
      : undefined

    const rollbackJournal: InstallMetadataRollbackJournal = {
      schemaVersion: 1,
      packageName,
      version,
      publisher: publisherBefore,
      release: releaseBefore,
      active: activeBefore,
      ...(devRoutingBefore ? {devRouting: devRoutingBefore} : {}),
    }
    recordRecoveryState(JSON.stringify(rollbackJournal))

    const rollbackMetadata = () => {
      let firstError: unknown
      for (const restore of [
        () => {
          if (devRoutingBefore) restoreDevRouting(packageName, devRoutingBefore)
        },
        () => restoreStorage(activeKey, activeBefore),
        () => restoreInstallationMetadata(releaseKey, releaseBefore),
        () => restoreInstallationMetadata(publisherKey, publisherBefore),
      ]) {
        try {
          restore()
        } catch (rollbackError) {
          console.error("APP_REGISTRY: failed to restore install metadata after finalization error", rollbackError)
          firstError ??= rollbackError
        }
      }
      if (firstError !== undefined) throw firstError
    }

    return {
      apply: () => {
        // The commit point: apply and the commit rename run without yielding,
        // so a replacement that began after the queue's checks still wins.
        this.assertNoReplacementInProgress(packageName, version)
        if (releaseInstall) {
          // A dev probe or snapshot download started earlier must not
          // reactivate development code over this release.
          invalidateDevSnapshotRequests(packageName)
          for (const field of DEV_ROUTING_FIELDS) restoreStorage(`${packageName}_dev_${field}`, {present: false})
        }
        // Every signed install records its publisher, development snapshots
        // included: from here on only bundles signed with the same key replace
        // this package, until an uninstall clears the record.
        if (releaseIdentity.publisherKeyFingerprint) {
          getInstallationMetadata().set(publisherKey, JSON.stringify(releaseIdentity.publisherKeyFingerprint))
        }
        getInstallationMetadata().set(releaseKey, JSON.stringify(releaseIdentity))
        // Do not notify until the pending filesystem marker has committed.
        // A subscriber scanning here would exclude the pending version and
        // could replace this pointer with the previous installed release.
        const activated = storage.save(activeKey, version)
        if (activated.is_error()) throw activated.error
      },
      rollback: rollbackMetadata,
      afterCommit: () => {
        if (releaseInstall) {
          // Routing already committed with the active release. Only disposable
          // snapshot files, the dev index entry and the cached dev icon remain,
          // so an interruption here cannot select old dev code.
          try {
            this.gcDevVersions(packageName, 0)
            if (getDevAppIndex().includes(packageName)) {
              storage.save(DEV_APPS_INDEX_KEY, JSON.stringify(getDevAppIndex().filter((pkg) => pkg !== packageName)))
            }
            const devMeta = devRoutingBefore?.meta
            if (devMeta?.present && typeof devMeta.value === "string") deleteCachedDevIcon(devMeta.value, packageName)
          } catch (error) {
            console.warn(`APP_REGISTRY: failed to clean obsolete dev artifacts for ${packageName}`, error)
          }
        }
        this.refreshNeeded = true
        this.notify()
      },
    }
  }

  public getReleaseIdentity(packageName: string, version: string): MiniappReleaseIdentity | null {
    if (!version) return null
    try {
      const snapshot = snapshotInstallationMetadata<MiniappReleaseIdentity>(releaseIdentityKey(packageName, version))
      return snapshot.present ? snapshot.value! : null
    } catch {
      return null
    }
  }

  /** The publisher key a package is pinned to, or null when it is unsigned or not installed. */
  public getPublisherKeyFingerprint(packageName: string): string | null {
    try {
      const snapshot = snapshotInstallationMetadata<string>(publisherIdentityKey(packageName))
      return snapshot.present ? snapshot.value! : null
    } catch {
      return null
    }
  }

  /** Enumerate installed releases carrying deployment ownership metadata. */
  public getDeploymentOwnedReleases(): Array<{
    packageName: string
    version: string
    identity: MiniappReleaseIdentity
  }> {
    const releases: Array<{packageName: string; version: string; identity: MiniappReleaseIdentity}> = []
    for (const packageName of this.getPackageNames()) {
      for (const version of this.getInstalledVersions(packageName)) {
        const identity = this.getReleaseIdentity(packageName, version)
        if (identity?.source === "deployment_manifest") releases.push({packageName, version, identity})
      }
    }
    return releases
  }

  /**
   * Drop every dev-* version directory for a package plus ALL dev MMKV keys
   * (URL/port/reachability + the home-tile metadata record). Called on
   * uninstall, so a dev package leaves nothing behind that `projectDevApps`
   * could re-surface. A release install clears the same routing inside its
   * install transaction instead (see finalizeInstall).
   */
  private clearDevArtifacts(packageName: string): void {
    if (this.retainedDevVersions.has(packageName)) throw new Error("Cannot clear a miniapp during replacement")
    try {
      const pkgDir = new Directory(Paths.document, "lmas", packageName)
      if (pkgDir.exists) {
        for (const item of pkgDir.list()) {
          if (item instanceof Directory && item.name.startsWith("dev-")) {
            try {
              this.removeReleaseIdentity(packageName, item.name)
              item.delete()
            } catch (e) {
              console.warn(`APP_REGISTRY: failed to delete ${item.name}:`, e)
            }
          }
        }
      }
    } catch (e) {
      console.warn(`APP_REGISTRY: clearDevArtifacts dir scan failed for ${packageName}:`, e)
    }
    storage.remove(`${packageName}_dev_selected_snapshot`)
    storage.remove(`${packageName}_dev_url`)
    storage.remove(`${packageName}_dev_port`)
    storage.remove(`${packageName}_dev_mdns`)
    storage.remove(`${packageName}_dev_last_reachable`)
    // HTTP-direct dev miniapps are indexed by their real package name. A
    // release install/uninstall of that same package should remove only its
    // dev tile; unrelated dev miniapps must remain available.
    if (readDevAppRecord(packageName)) unregisterDevApp(packageName)
  }

  /**
   * Garbage-collect older `dev-*` version directories for this package,
   * keeping the latest `keep` (by lexicographic sort, which matches
   * timestamp ordering since dev-<ms> is zero-padded).
   *
   * Only touches `dev-*` versions; semver-installed versions are left alone.
   */
  public gcDevVersions(packageName: string, keep: number): void {
    try {
      const pkgDir = new Directory(Paths.document, "lmas", packageName)
      if (!pkgDir.exists) return
      const dirs = pkgDir
        .list()
        .filter((d): d is Directory => d instanceof Directory && d.name.startsWith("dev-"))
        .sort((a, b) => (a.name < b.name ? 1 : -1))
      const protectedVersions = this.protectedDevVersions(packageName)
      for (let i = keep; i < dirs.length; i++) {
        if (protectedVersions.has(dirs[i].name)) continue
        try {
          dirs[i].delete()
          this.removeReleaseIdentity(packageName, dirs[i].name)
        } catch (e) {
          console.warn(`APP_REGISTRY: failed to delete ${dirs[i].name}:`, e)
        }
      }
      if (dirs.length > keep) this.refreshNeeded = true
    } catch (e) {
      console.warn(`APP_REGISTRY: gcDevVersions error for ${packageName}:`, e)
    }
  }

  /**
   * Remove obsolete release directories after a Store update committed. Keeps
   * the given versions (the new release and the one it replaced), the active
   * selection, organization-owned releases and every dev snapshot. Runs in the
   * install queue so it never touches a version another install is activating.
   */
  public gcReleaseVersions(packageName: string, keepVersions: readonly string[]): Promise<void> {
    return runInstallFilesystemTransaction(async () => {
      const keep = new Set(keepVersions.filter(Boolean))
      const active = storage.load<string>(activeVersionKey(packageName))
      if (active.is_ok()) keep.add(active.value)
      for (const version of this.getInstalledVersions(packageName)) {
        if (this.getReleaseIdentity(packageName, version)?.source === "deployment_manifest") keep.add(version)
      }
      const obsolete = selectReleaseVersionsForGarbageCollection(this.getInstalledVersions(packageName), keep)
      for (const version of obsolete) {
        try {
          const directory = new Directory(Paths.document, "lmas", packageName, version)
          if (directory.exists) directory.delete()
          this.removeReleaseIdentity(packageName, version)
        } catch (error) {
          console.warn(`APP_REGISTRY: failed to garbage-collect ${packageName}@${version}:`, error)
        }
      }
      if (obsolete.length > 0) {
        this.refreshNeeded = true
        this.notify()
      }
    }).catch((error) => {
      console.warn(`APP_REGISTRY: release garbage collection failed for ${packageName}:`, error)
    })
  }

  /** An explicitly selected packed snapshot takes precedence over scanned live URLs. */
  public getSelectedDevSnapshot(packageName: string): string | null {
    const selected = storage.load<string>(`${packageName}_dev_selected_snapshot`)
    return selected.is_ok() && selected.value.startsWith("dev-") && this.getInstalledVersions(packageName).includes(selected.value)
      ? selected.value : null
  }

  public selectDevSnapshot(packageName: string, version: string | null): void {
    if (version !== null && (!version.startsWith("dev-") || !this.getInstalledVersions(packageName).includes(version)))
      throw new Error("Selected dev snapshot is not installed")
    if (version === null) storage.remove(`${packageName}_dev_selected_snapshot`)
    else storage.save(`${packageName}_dev_selected_snapshot`, version)
    this.markRefreshNeeded()
  }

  /** Remove one failed staged dev replacement without clearing other dev files or settings. */
  public discardDevSnapshot(packageName: string, version: string): void {
    if (!/^dev-[0-9a-f-]+$/.test(version)) throw new Error("Expected an owned dev snapshot version")
    const directory = new Directory(Paths.document, "lmas", packageName, version)
    if (directory.exists) directory.delete()
    this.removeReleaseIdentity(packageName, version)
    this.refreshNeeded = true
    this.notify()
  }

  public uninstall(packageName: string, version?: string): AsyncResult<void, Error> {
    // Serialize with installs: an uninstall must not delete a package tree
    // while another operation is staging or activating inside it.
    return Res.try_async(() =>
      runInstallFilesystemTransaction(async () => {
        if (this.retainedDevVersions.has(packageName)) throw new Error("Cannot uninstall a miniapp during replacement")
        if (version) {
          const lmaDir = new Directory(Paths.document, "lmas", packageName, version)
          // Guard exists: a dev miniapp loads over HTTP and has no on-disk dir,
          // so an unconditional delete() would throw and abort the cleanup below.
          if (lmaDir.exists) lmaDir.delete()
          this.removeReleaseIdentity(packageName, version)
          console.log("APP_REGISTRY: Uninstalled mini app version", version)
          const packageDir = new Directory(Paths.document, "lmas", packageName)
          if (packageDir.exists && packageDir.list().length === 0) {
            packageDir.delete()
          }
        } else {
          for (const installedVersion of this.getInstalledVersions(packageName)) {
            this.removeReleaseIdentity(packageName, installedVersion)
          }
          const packageDir = new Directory(Paths.document, "lmas", packageName)
          if (packageDir.exists) {
            packageDir.delete()
          }
          console.log("APP_REGISTRY: Uninstalled all versions of mini app", packageName)
        }
        // Always clear dev artifacts: for HTTP-direct dev miniapps the tile is
        // backed by storage records (_dev_meta + dev_apps_index), not the disk
        // dir, so without this the projected tile reappears on the next refresh.
        this.clearDevArtifacts(packageName)
        // Removing the last installed version clears the recorded signer, so
        // any build of the package (an unsigned or dev build included) may
        // install again. Android's uninstall-then-install, for the same reason.
        if (this.getInstalledVersions(packageName).length === 0) {
          restoreInstallationMetadata(publisherIdentityKey(packageName), {present: false})
        }
        this.refreshNeeded = true
        this.notify()
      }),
    )
  }

  public getPackageNames(): string[] {
    try {
      const lmasDir = new Directory(Paths.document, "lmas")
      if (!lmasDir.exists) return []
      return lmasDir
        .list()
        .filter(
          (lma): lma is Directory =>
            lma instanceof Directory && installedVersionDirectoryNames(directoryNames(lma)).length > 0,
        )
        .map((lma) => lma.name)
    } catch (error) {
      console.error("APP_REGISTRY: Error getting locally installed package names", error)
      return []
    }
  }

  /**
   * Committed version directories of a package. Install transaction artifacts
   * (staging, backup and journal directories) and a candidate whose pending
   * activation has not committed are never versions.
   */
  public getInstalledVersions(packageName: string): string[] {
    try {
      const lmaDir = new Directory(Paths.document, "lmas", packageName)
      // Not installed yet is an expected state (e.g. preinstall sync probing
      // versions before first install) — return [] without the error noise.
      if (!lmaDir.exists) {
        return []
      }
      return installedVersionDirectoryNames(directoryNames(lmaDir))
    } catch (error) {
      console.error("APP_REGISTRY: Error getting local applet versions", error)
      return []
    }
  }

  /** A `dev-*` snapshot or a release a developer installed from a release QR. */
  private isDeveloperVersion(packageName: string, version: string): boolean {
    return version.startsWith("dev-") || this.getReleaseIdentity(packageName, version)?.source === "direct_download"
  }

  public async getActiveVersion(packageName: string): Promise<string | undefined> {
    let versions = this.getInstalledVersions(packageName)
    // A developer build only stands in while the deployment allows development.
    // A stored dev snapshot pointer is left alone so re-allowing it brings that
    // scan back; until then a released version stays on screen.
    const devAllowed = isDevMiniappAllowed(packageName)
    const selectedSnapshot = devAllowed ? this.getSelectedDevSnapshot(packageName) : null
    if (selectedSnapshot) return selectedSnapshot
    // Treat MMKV as a hint, not authority. A stored version may have been
    // GC'd off disk without this pointer being updated.
    const res = storage.load<string>(`${packageName}_active_version`)
    if (
      res.is_ok() &&
      versions.includes(res.value) &&
      (devAllowed || !this.isDeveloperVersion(packageName, res.value))
    ) {
      return res.value
    }
    // Dev versions take precedence over semver-installed versions.
    if (devAllowed) {
      const devVersions = versions
        .filter((v) => v.startsWith("dev-"))
        .sort()
        .reverse()
      if (devVersions.length > 0) {
        this.setActiveVersion(packageName, devVersions[0])
        return devVersions[0]
      }
    }
    versions = versions.filter((v) => semver.valid(v))
    versions.sort((a, b) => semver.rcompare(a, b))
    if (!versions.length) return undefined
    // The newest release the deployment allows, e.g. a workspace's managed
    // release over a newer release-QR or Store install that it does not.
    const active =
      versions.find((v) => isInstalledMiniappAllowed(packageName, v, this.getReleaseIdentity(packageName, v))) ??
      versions[0]
    if (!(res.is_ok() && res.value.startsWith("dev-"))) this.setActiveVersion(packageName, active)
    return active
  }

  public setActiveVersion(packageName: string, version: string): Result<void, Error> {
    const key = `${packageName}_active_version`
    const previous = storage.load<string>(key)
    const result = storage.save(key, version)
    if (result.is_ok() && (previous.is_error() || previous.value !== version)) {
      // Selecting an already-installed workspace pin must update cached app
      // metadata and subscribers just like a new installation does.
      this.refreshNeeded = true
      this.notify()
    }
    return result
  }

  /**
   * Newest `dev-*` snapshot that still has a resolvable UI or background
   * entry. Semver store installs are ignored — a live-dev tile must not
   * silently fall back to a released store bundle when the laptop drops.
   */
  public getLatestDevSnapshotVersion(packageName: string): string | null {
    const versions = this.getInstalledVersions(packageName)
      .filter((v) => v.startsWith("dev-"))
      .sort()
      .reverse()
    for (const version of versions) {
      const paths = this.getMiniappEntryPaths(packageName, version)
      if (paths?.background || paths?.ui) return version
    }
    return null
  }

  /** True iff {@link getLatestDevSnapshotVersion} finds a usable snapshot. */
  public hasDevSnapshot(packageName: string): boolean {
    return this.getLatestDevSnapshotVersion(packageName) != null
  }

  public getMetadata(packageName: string, version: string): InstalledInfo {
    try {
      const lmaDir = new Directory(Paths.document, "lmas", packageName, version)
      const miniappJsonFile = new File(lmaDir, "miniapp.json")
      const manifest = JSON.parse(miniappJsonFile.textSync())
      const iconPath = typeof manifest.icon === "string" && manifest.icon.trim() ? manifest.icon : "icon.png"
      const safeRelativeIcon =
        !/^[a-z]+:/i.test(iconPath) && !iconPath.startsWith("/") && !iconPath.split("/").includes("..")
      const declaredIcon = safeRelativeIcon ? new File(lmaDir, iconPath) : null
      const logoUrl = declaredIcon?.exists ? declaredIcon.uri : new File(lmaDir, "icon.png").uri
      return {name: manifest.name, logoUrl: logoUrl}
    } catch (error) {
      console.error("APP_REGISTRY: Error getting local miniapp metadata", error)
      return {name: "error", logoUrl: ""}
    }
  }

  public getInstalledInfo(): InstalledLma[] {
    const packageNames = this.getPackageNames()
    const out: InstalledLma[] = []
    for (const packageName of packageNames) {
      const versionStrings = this.getInstalledVersions(packageName)
      const installedVersion: InstalledLma = {packageName, versions: {}}
      for (const versionString of versionStrings) {
        installedVersion.versions[versionString] = this.getMetadata(packageName, versionString)
      }
      out.push(installedVersion)
    }
    return out
  }

  /**
   * Merge disk-derived apps with the projected dev + offline layers,
   * de-duping by packageName. An active dev registration wins over an older
   * disk install of the same package; installing a release clears that dev
   * registration in finalizeInstall. Native offline apps keep top priority.
   */
  private mergeProjectedApps(diskApps: ClientApp[], includeBackgroundOnly = false): ClientApp[] {
    const offline = this.projectOfflineApps().filter((app) => isOfflineSystemMiniappAllowed(app.packageName))
    const offlinePackages = new Set(offline.map((app) => app.packageName))
    const dev = this.projectDevApps().filter(
      (app) =>
        isDevMiniappAllowed(app.packageName) &&
        !offlinePackages.has(app.packageName) &&
        !this.getSelectedDevSnapshot(app.packageName),
    )
    const devPackages = new Set(dev.map((app) => app.packageName))
    const installed = diskApps.filter(
      (app) =>
        (app.version?.startsWith("dev-")
          ? isDevMiniappAllowed(app.packageName)
          : isInstalledMiniappAllowed(
              app.packageName,
              app.version,
              app.version ? this.getReleaseIdentity(app.packageName, app.version) : null,
            )) &&
        !offlinePackages.has(app.packageName) &&
        !devPackages.has(app.packageName),
    )
    // A background-only miniapp (a Store) never appears in user-facing lists;
    // only the host's own maintenance asks for it.
    return [...installed, ...dev, ...offline].filter((app) =>
      isMiniappAvailable(app.packageName, includeBackgroundOnly ? "background" : "interactive"),
    )
  }

  public async getInstalledMiniapps({includeBackgroundOnly = false}: {includeBackgroundOnly?: boolean} = {}): Promise<
    ClientApp[]
  > {
    if (!this.refreshNeeded && this.cachedApps.length > 0) {
      // Cache hit: re-project running from the registry. The cached array
      // IS the disk-derived truth; running comes from the mount registry.
      return this.mergeProjectedApps(
        this.cachedApps.map((a) => ({
          ...a,
          running: miniappRunningRegistry.has(a.packageName),
        })),
        includeBackgroundOnly,
      )
    }

    try {
      const installedInfo = this.getInstalledInfo()
      const out: ClientApp[] = []
      for (const lmaInfo of installedInfo) {
        const versionString = await this.getActiveVersion(lmaInfo.packageName)
        if (!versionString) continue
        const versionInfo = lmaInfo.versions[versionString]

        const manifest = this.getMiniappManifest(lmaInfo.packageName, versionString) as {
          permissions?: Array<string | {type: string; required?: boolean; description?: string}>
          hardwareRequirements?: Array<{type: string; level: string; description?: string}>
          type?: string
          actions?: Array<{
            id?: unknown
            description?: unknown
            parameters?: unknown
            outputSchema?: unknown
            lifecycle?: unknown
            audience?: unknown
          }>
        } | null

        const permissions = normalizeManifestPermissions(manifest?.permissions)
        const hardwareRequirements = buildHardwareRequirements(manifest?.hardwareRequirements, lmaInfo.packageName)
        const appType = normalizeManifestType(manifest?.type)

        // Declared actions (for session.miniapps.list + invoke gating).
        const actions = normalizeManifestActions(manifest?.actions)

        // Dev miniapps live in the same lmas/ tree as installed ones, but
        // their version directory name starts with "dev-".
        const isMiniappDev = versionString.startsWith("dev-")
        let devUrl: string | undefined
        if (isMiniappDev && !this.getSelectedDevSnapshot(lmaInfo.packageName)) {
          const devUrlRes = storage.load<string>(`${lmaInfo.packageName}_dev_url`)
          if (devUrlRes.is_ok()) devUrl = devUrlRes.value
        }

        out.push({
          packageName: lmaInfo.packageName,
          version: versionString,
          running: miniappRunningRegistry.has(lmaInfo.packageName),
          local: true,
          healthy: true,
          loading: false,
          offline: false,
          hidden: false,
          offlineRoute: "",
          name: versionInfo.name,
          webviewUrl: "",
          logoUrl: versionInfo.logoUrl,
          type: appType,
          permissions,
          hardwareRequirements,
          // Always project actions (even []) so the invoke gate can enforce
          // declared-action membership unconditionally — an app with no declared
          // actions must reject every invoke, not bypass the check.
          actions,
          ...(isMiniappDev ? {isMiniappDev: true} : {}),
          ...(devUrl ? {devUrl} : {}),
          onStart: () => saveLocalAppRunningState(lmaInfo.packageName, true),
          onStop: () => saveLocalAppRunningState(lmaInfo.packageName, false),
        })
      }

      this.cachedApps = out
      this.refreshNeeded = false
      return this.mergeProjectedApps(this.cachedApps, includeBackgroundOnly)
    } catch (error) {
      console.error("APP_REGISTRY: Error getting local applets", error)
      return this.mergeProjectedApps(
        this.cachedApps.map((a) => ({
          ...a,
          running: miniappRunningRegistry.has(a.packageName),
        })),
        includeBackgroundOnly,
      )
    }
  }

  /** Force the next getInstalledMiniapps() to re-derive from disk + records. */
  public markRefreshNeeded(): void {
    this.refreshNeeded = true
    this.notify()
  }

  /**
   * Project persisted dev-app metadata records into ClientApp tiles. Dev
   * miniapps aren't installed to disk (they load over HTTP), so they don't
   * appear in the `lmas/` scan — this surfaces them on the home screen so
   * they're re-launchable without re-scanning the QR.
   */
  private projectDevApps(): ClientApp[] {
    return getDevAppRecords().map((rec) => {
      // Every dev rebuild has a unique snapshot directory. Prefer its manifest
      // icon so home tiles update with the bundle instead of retaining the
      // separately cached, stable-path QR preview (and its decoded image cache).
      const snapshotVersion = this.getLatestDevSnapshotVersion(rec.packageName)
      const snapshotIcon = snapshotVersion ? this.getMetadata(rec.packageName, snapshotVersion).logoUrl : undefined
      const permissions = normalizeManifestPermissions(rec.permissions)
      const hardwareRequirements = buildHardwareRequirements(rec.hardwareRequirements, rec.packageName)
      return {
        packageName: rec.packageName,
        version: undefined,
        running: miniappRunningRegistry.has(rec.packageName),
        local: true,
        healthy: true,
        loading: false,
        offline: false,
        hidden: false,
        offlineRoute: "",
        name: rec.name,
        webviewUrl: "",
        logoUrl: snapshotIcon || rec.iconUrl,
        type: normalizeManifestType(rec.type),
        permissions,
        hardwareRequirements,
        actions: normalizeManifestActions(rec.actions),
        isMiniappDev: true,
        devUrl: rec.devUrl,
        devPort: rec.devPort,
        onStart: () => saveLocalAppRunningState(rec.packageName, true),
        onStop: () => saveLocalAppRunningState(rec.packageName, false),
      }
    })
  }

  private projectOfflineApps(): ClientApp[] {
    // Offline apps don't go through miniappRunningRegistry (that's for
    // MiniappHost-mounted webviews). Their running flag is persisted to
    // MMKV by saveLocalAppRunningState — read it back here so refreshes
    // don't blow away the active flag.
    return this.offlineApps.map((a) => {
      const running = getLocalAppRunningState(a.packageName)
      const screenshot = getLocalAppScreenshot(a.packageName)

      return {...a, running, screenshot}
    })
  }

  // Register an offline (locally-routed) app. Survives disk rebuilds.
  public installOfflineApp(app: ClientApp, opts?: {requiresLocalSttModel?: boolean}): void {
    if (opts?.requiresLocalSttModel) {
      this.sttModelRequired.add(app.packageName)
    }
    this.offlineApps.push({
      ...app,
      onStart: () => saveLocalAppRunningState(app.packageName, true),
      onStop: () => saveLocalAppRunningState(app.packageName, false),
    })
    this.refreshNeeded = true
    this.notify()
  }

  /**
   * Update whether a registered offline app is projected into launcher UIs.
   *
   * Offline apps are registered once at host startup, so settings-backed
   * visibility changes need to update the projection without reinstalling or
   * duplicating the app. No-op when the app is missing or already matches.
   */
  public setOfflineAppHidden(packageName: string, hidden: boolean): void {
    const app = this.offlineApps.find((candidate) => candidate.packageName === packageName)
    if (!app || app.hidden === hidden) return

    app.hidden = hidden
    this.refreshNeeded = true
    this.notify()
  }

  /**
   * Registered as needing the on-device STT model before it can start (the
   * host declares this per offline app; the apps store gates start() on it).
   */
  public requiresLocalSttModel(packageName: string): boolean {
    return this.sttModelRequired.has(packageName)
  }

  public getMiniappHtml(packageName: string, version: string): Result<string, Error> {
    return Res.try(() => {
      const lmaDir = new Directory(Paths.document, "lmas", packageName, version)
      const htmlFile = new File(lmaDir, "index.html")
      return htmlFile.textSync()
    })
  }
}

/**
 * Persist the running flag for a local miniapp (read on next cold boot so
 * autostart picks the right set of apps). Exported for hosts that want to
 * track running state independently.
 */
export function saveLocalAppRunningState(packageName: string, status: boolean): void {
  storage.save(`${packageName}_running`, status)
}

export function getLocalAppRunningState(packageName: string): boolean {
  const res = storage.load<boolean>(`${packageName}_running`)
  if (res.is_ok()) return res.value
  return false
}

export function getLocalAppScreenshot(packageName: string): string | undefined {
  const key = `${packageName}_screenshot`
  const res = storage.load<string>(key)
  if (res.is_error()) return undefined

  const uri = res.value
  if (uri.startsWith("file://")) {
    try {
      if (!new File(uri).exists) {
        storage.remove(key)
        return undefined
      }
    } catch {
      storage.remove(key)
      return undefined
    }
  }

  return uri
}

/**
 * Persisted metadata for a dev miniapp's home tile.
 *
 * Dev miniapps load directly off the dev server over HTTP and are NOT
 * installed into `lmas/`, so the disk scan in `getInstalledMiniapps` can't
 * see them. We persist a tiny record at scan / dev-URL-entry time so the
 * tile survives across app launches and is re-launchable without re-scanning.
 * `permissions` / `hardwareRequirements` are snapshotted from the manifest so
 * the home-screen permission gate has data without a disk bundle.
 */
export interface DevAppRecord {
  packageName: string
  name: string
  iconUrl: string
  devUrl: string
  devPort?: number
  /**
   * Bonjour / mDNS hostname from the QR (`ComputerName.local`). Used as a
   * failover host when the raw LAN IP in `devUrl` goes stale after a Wi-Fi
   * change — phones that resolve `.local` can relaunch without re-scanning.
   */
  mdnsHost?: string
  type?: AppletType
  permissions?: Array<string | {type: string; required?: boolean; description?: string}>
  hardwareRequirements?: Array<{type: string; level: string; description?: string}>
  /** Manifest-declared actions — so dev-sideloaded miniapps can be invoked too. */
  actions?: Array<{
    id?: unknown
    description?: unknown
    parameters?: unknown
    outputSchema?: unknown
    lifecycle?: unknown
    audience?: unknown
  }>
  /** Legacy single-slot migration field. New records use the real packageName directly. */
  sourcePackageName?: string
}

const DEV_APPS_INDEX_KEY = "dev_apps_index"
const DEV_APP_ICONS_DIR = "dev-miniapp-icons"

function isPrivateLanHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname.startsWith("192.168.") ||
    hostname.startsWith("10.") ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname)
  )
}

function rewriteStaleDevUrl(value: string): string {
  if (!__DEV__) return value
  const host = configuredDevHost()
  if (!host) return value

  try {
    const url = new URL(value)
    if (url.hostname === host || !isPrivateLanHost(url.hostname)) return value
    url.hostname = host
    return url.toString().replace(/\/$/, "")
  } catch {
    return value
  }
}

function normalizeDevAppRecord(record: DevAppRecord): DevAppRecord {
  const devUrl = rewriteStaleDevUrl(record.devUrl)
  const iconUrl = rewriteStaleDevUrl(record.iconUrl)
  return devUrl === record.devUrl && iconUrl === record.iconUrl ? record : {...record, devUrl, iconUrl}
}

/** Legacy package used by builds that supported only one dev miniapp. */
export const DEV_APP_PACKAGE_NAME = "com.dev"
export const DEV_APP_NAME = "Dev"

/**
 * Copy a dev-server icon into Documents so the tile remains branded after the
 * laptop/server disappears. A failed download is non-fatal: the remote URL is
 * retained and can still render while the server is reachable.
 */
async function cacheDevAppIcon(packageName: string, iconUrl: string): Promise<string> {
  if (!/^https?:\/\//.test(iconUrl)) return iconUrl

  try {
    const dir = new Directory(Paths.document, DEV_APP_ICONS_DIR)
    if (!dir.exists) dir.create({intermediates: true})

    const safePackageName = packageName.replace(/[^a-zA-Z0-9._-]/g, "_")
    let extension = ".png"
    try {
      const match = new URL(iconUrl).pathname.match(/\.(png|jpe?g|webp|gif|svg)$/i)
      if (match) extension = `.${match[1].toLowerCase()}`
    } catch {
      // Keep the decoder-friendly .png fallback; image loaders sniff content.
    }

    const target = new File(dir, `${safePackageName}${extension}`)
    const downloaded = await File.downloadFileAsync(iconUrl, target, {idempotent: true})

    // Only remove older extensions AFTER the replacement is safely on disk;
    // a broken icon URL must not destroy the last known-good cached logo.
    for (const item of dir.list()) {
      if (item instanceof File && item.uri !== downloaded.uri && item.name.startsWith(`${safePackageName}.`)) {
        try {
          item.delete()
        } catch {
          // Best effort; the current icon has already been persisted.
        }
      }
    }
    return downloaded.uri
  } catch (error) {
    console.warn(`APP_REGISTRY: failed to cache dev icon for ${packageName}:`, error)
    return readDevAppRecord(packageName)?.iconUrl ?? iconUrl
  }
}

function removeDevRecordKeys(packageName: string): void {
  const existing = readDevAppRecord(packageName)
  if (existing?.iconUrl.startsWith("file://")) {
    try {
      const icon = new File(existing.iconUrl)
      if (icon.exists) icon.delete()
    } catch (error) {
      console.warn(`APP_REGISTRY: failed to delete dev icon for ${packageName}:`, error)
    }
  }
  storage.remove(`${packageName}_dev_meta`)
  storage.remove(`${packageName}_dev_url`)
  storage.remove(`${packageName}_dev_port`)
  storage.remove(`${packageName}_dev_mdns`)
  storage.remove(`${packageName}_dev_last_reachable`)
}

function readDevAppRecord(packageName: string): DevAppRecord | null {
  const res = storage.load<string>(`${packageName}_dev_meta`)
  if (!res.is_ok()) return null
  try {
    return JSON.parse(res.value) as DevAppRecord
  } catch {
    return null
  }
}

/** Move the historical `com.dev` record onto its real manifest package key. */
function migrateLegacyDevSlot(): void {
  const legacy = readDevAppRecord(DEV_APP_PACKAGE_NAME)
  const targetPackage = legacy?.sourcePackageName?.trim()
  if (!legacy || !targetPackage || targetPackage === DEV_APP_PACKAGE_NAME) return

  const existingTarget = readDevAppRecord(targetPackage)
  const migrated: DevAppRecord = existingTarget ?? {
    ...legacy,
    packageName: targetPackage,
    sourcePackageName: targetPackage,
  }
  if (!existingTarget) storage.save(`${targetPackage}_dev_meta`, JSON.stringify(migrated))

  const legacyUrl = storage.load<string>(`${DEV_APP_PACKAGE_NAME}_dev_url`)
  const targetUrl = storage.load<string>(`${targetPackage}_dev_url`)
  if (!targetUrl.is_ok()) {
    storage.save(`${targetPackage}_dev_url`, legacyUrl.is_ok() ? legacyUrl.value : migrated.devUrl)
  }
  const legacyPort = storage.load<number>(`${DEV_APP_PACKAGE_NAME}_dev_port`)
  const targetPort = storage.load<number>(`${targetPackage}_dev_port`)
  if (!targetPort.is_ok()) {
    const port = migrated.devPort ?? (legacyPort.is_ok() ? legacyPort.value : undefined)
    if (typeof port === "number" && Number.isFinite(port)) storage.save(`${targetPackage}_dev_port`, port)
  }
  const legacyMdns = storage.load<string>(`${DEV_APP_PACKAGE_NAME}_dev_mdns`)
  const targetMdns = storage.load<string>(`${targetPackage}_dev_mdns`)
  if (!targetMdns.is_ok() && legacyMdns.is_ok() && legacyMdns.value.trim()) {
    storage.save(`${targetPackage}_dev_mdns`, legacyMdns.value.trim())
  }

  storage.remove(`${DEV_APP_PACKAGE_NAME}_dev_meta`)
  storage.remove(`${DEV_APP_PACKAGE_NAME}_dev_url`)
  storage.remove(`${DEV_APP_PACKAGE_NAME}_dev_port`)
  storage.remove(`${DEV_APP_PACKAGE_NAME}_dev_mdns`)
  storage.remove(`${DEV_APP_PACKAGE_NAME}_dev_last_reachable`)

  const index = Array.from(new Set(getDevAppIndex().map((pkg) => (pkg === DEV_APP_PACKAGE_NAME ? targetPackage : pkg))))
  storage.save(DEV_APPS_INDEX_KEY, JSON.stringify(index))
}

function readStoredMdnsHost(packageName: string): string | undefined {
  const res = storage.load<string>(`${packageName}_dev_mdns`)
  if (!res.is_ok()) return undefined
  return res.value.trim() || undefined
}

/**
 * Whether live development code may run under `packageName`. The deployment
 * must allow miniapp development. A dev build is the package itself, served
 * unsigned, so it is also refused while the installed package carries a
 * publisher signature (throwing {@link SignedMiniappDevBuildError});
 * uninstalling clears that signature.
 */
export function assertDevBuildAllowed(packageName: string): void {
  assertMiniappDevelopmentAllowed()
  assertUnsignedDevBuildAllowed({
    packageName,
    installedFingerprint: appRegistry.getPublisherKeyFingerprint(packageName),
  })
}

/**
 * Register or update one dev miniapp under its real manifest package. Different
 * package names coexist; rescanning the same package updates that package only.
 * The phone keeps the record, its `${packageName}_dev_*` routing keys, and the
 * dev-build marking until a release install or uninstall replaces them.
 */
export async function registerDevApp(record: DevAppRecord): Promise<void> {
  migrateLegacyDevSlot()
  const packageName = record.packageName.trim()
  if (!packageName) throw new Error("Dev miniapp manifest is missing packageName")
  assertDevBuildAllowed(packageName)

  const iconUrl = await cacheDevAppIcon(packageName, record.iconUrl)
  // Relaunch paths (developer-URL screen, loadDevMiniapp) omit mdnsHost, so an
  // omitted field keeps whatever the QR scan stored instead of wiping the
  // `.local` failover host.
  const mdnsHost = record.mdnsHost !== undefined ? record.mdnsHost.trim() || undefined : readStoredMdnsHost(packageName)
  const devRecord: DevAppRecord = {
    ...record,
    packageName,
    sourcePackageName: packageName,
    name: record.name || DEV_APP_NAME,
    iconUrl,
    mdnsHost,
  }
  storage.save(`${packageName}_dev_meta`, JSON.stringify(devRecord))
  storage.remove(`${packageName}_dev_selected_snapshot`)
  storage.save(`${packageName}_dev_url`, record.devUrl)
  if (typeof record.devPort === "number" && Number.isFinite(record.devPort)) {
    storage.save(`${packageName}_dev_port`, record.devPort)
  } else {
    storage.remove(`${packageName}_dev_port`)
  }
  if (mdnsHost) {
    storage.save(`${packageName}_dev_mdns`, mdnsHost)
  } else {
    storage.remove(`${packageName}_dev_mdns`)
  }
  const idx = getDevAppIndex()
  if (!idx.includes(packageName)) {
    idx.push(packageName)
    storage.save(DEV_APPS_INDEX_KEY, JSON.stringify(idx))
  }
  appRegistry.markRefreshNeeded()
}

/** Drop one dev miniapp's metadata, routing keys, and cached icon. */
export function unregisterDevApp(packageName = DEV_APP_PACKAGE_NAME): void {
  removeDevRecordKeys(packageName)
  const idx = getDevAppIndex().filter((p) => p !== packageName)
  storage.save(DEV_APPS_INDEX_KEY, JSON.stringify(idx))
  appRegistry.markRefreshNeeded()
}

function getDevAppIndex(): string[] {
  const res = storage.load<string>(DEV_APPS_INDEX_KEY)
  if (!res.is_ok()) return []
  try {
    const parsed = JSON.parse(res.value)
    return Array.isArray(parsed) ? (parsed as string[]) : []
  } catch {
    return []
  }
}

/** Resolve the manifest package for a dev runtime (including the legacy slot). */
export function getDevAppSourcePackage(packageName = DEV_APP_PACKAGE_NAME): string | null {
  migrateLegacyDevSlot()
  const rec = readDevAppRecord(packageName)
  return rec?.sourcePackageName ?? rec?.packageName ?? null
}

export function getDevAppRecords(): DevAppRecord[] {
  migrateLegacyDevSlot()
  const out: DevAppRecord[] = []
  for (const pkg of getDevAppIndex()) {
    const res = storage.load<string>(`${pkg}_dev_meta`)
    if (!res.is_ok()) continue
    try {
      const record = JSON.parse(res.value) as DevAppRecord
      const normalized = normalizeDevAppRecord(record)
      if (normalized !== record) {
        storage.save(`${pkg}_dev_meta`, JSON.stringify(normalized))
        storage.save(`${pkg}_dev_url`, normalized.devUrl)
      }
      out.push(normalized)
    } catch {
      /* corrupt record — skip */
    }
  }
  return out
}

const appRegistry = AppRegistry.getInstance()
export default appRegistry

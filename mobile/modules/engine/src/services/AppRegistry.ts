/**
 * AppRegistry — on-disk install/uninstall registry for local miniapps.
 *
 * Owns the `Documents/lmas/<packageName>/<version>/` filesystem layout, the
 * download/unzip pipeline, and the active-version pointer in MMKV. It does
 * NOT touch the apps store directly — instead it notifies subscribers when
 * the install set changes, so the host (mobile manager, OEM app) can refresh
 * its own state.
 *
 * Public surface:
 *   - installFromUrl(url, opts?)            install/replace a miniapp from a URL
 *   - installFromLocalZip(path, opts?)      install/replace from a local zip
 *   - uninstall(packageName, version?)      remove one or all versions
 *   - getInstalledMiniapps()                ClientApp[] derived from disk
 *   - getActiveVersion(packageName)         active version string for a package
 *   - getBundleDir / getMiniappManifest     filesystem helpers used by hosts
 *   - subscribe(fn)                         register a refresh listener
 */

import {Directory, Paths, File} from "expo-file-system"
import {unzip} from "react-native-zip-archive"
import semver from "semver"
import {AsyncResult, Result, result as Res} from "typesafe-ts"

import type {AppletPermission, AppPermissionType, AppletType, ClientApp} from "../types/applet"
import {HardwareRequirement, HardwareRequirementLevel, HardwareType} from "../types"
import {configuredDevHost} from "../utils/configuredDevHost"
import {storage} from "../utils/storage/storage"
import {printDirectory} from "../utils/storage/zip"
import {isLocalMiniappAllowed} from "../runtime/bootstrap"
import {checkManifestVersions} from "./manifestVersionGate"
import {normalizeManifestActions} from "./manifestActions"
import {miniappRunningRegistry} from "./MiniappRunningRegistry"

export {normalizeManifestActions} from "./manifestActions"

const ALLOWED_PERMISSION_TYPES: ReadonlySet<AppPermissionType> = new Set<AppPermissionType>([
  "MICROPHONE",
  "CAMERA",
  "CALENDAR",
  "LOCATION",
  "BACKGROUND_LOCATION",
  "READ_NOTIFICATIONS",
  "POST_NOTIFICATIONS",
])

/**
 * Normalize the `permissions` field from a miniapp.json manifest.
 *
 * New miniapps ship `[{type, required?, description?}]` objects. A few older
 * installed bundles may have `["MICROPHONE", ...]` plain strings. Accept both.
 */
export function normalizeManifestPermissions(
  raw: Array<string | {type: string; required?: boolean; description?: string}> | undefined,
): AppletPermission[] {
  if (!Array.isArray(raw)) return []
  const out: AppletPermission[] = []
  for (const p of raw) {
    if (typeof p === "string") {
      if (ALLOWED_PERMISSION_TYPES.has(p as AppPermissionType)) {
        out.push({type: p as AppPermissionType, required: true})
      }
    } else if (p && typeof p === "object" && typeof p.type === "string") {
      if (ALLOWED_PERMISSION_TYPES.has(p.type as AppPermissionType)) {
        out.push({
          type: p.type as AppPermissionType,
          ...(typeof p.required === "boolean" ? {required: p.required} : {}),
          ...(typeof p.description === "string" ? {description: p.description} : {}),
        })
      }
    }
  }
  return out
}

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

  // Always require glasses to be connected for any local miniapp.
  out.push({type: HardwareType.EXIST, level: HardwareRequirementLevel.REQUIRED})
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
  source: "direct_download" | "bundled_asset" | "preinstalled_registry" | "dev_snapshot"
  releaseId?: string
  bundleSha256?: string
  channel?: string
}

function releaseIdentityKey(packageName: string, version: string): string {
  return `miniapp_release_identity:${packageName}:${version}`
}

/**
 * Download a miniapp zip from `url` into the cache and return its local path.
 *
 * `File.downloadFileAsync` is HTTP(S)-only, so this path is for remote bundles
 * (dev server, store). Bundled-asset installs already have a local zip and
 * should call {@link unpackMiniApp} directly.
 */
async function downloadMiniAppZip(url: string): Promise<string> {
  const downloadDir = new Directory(Paths.cache, "lma_downloads")
  try {
    if (!downloadDir.exists) {
      downloadDir.create()
    }
  } catch (error) {
    console.error("ZIP: Error creating download directory", error)
    throw "CREATE_DOWNLOAD_DIR_FAILED"
  }

  // Pre-delete any cached file with the same name. Both `mentra-miniapp dev`
  // and `mentra-miniapp release` serve their zip at /bundle.zip, so URLs
  // collide on the cache filename. Without this delete, a stale dev-snapshot
  // (containing the project source tree) gets unzipped instead of the
  // release build → white screen because index.html points at TSX files.
  const targetFileName = url.split("/").pop() ?? "bundle.zip"
  const existingFile = new File(downloadDir, targetFileName)
  if (existingFile.exists) {
    try {
      existingFile.delete()
    } catch (e) {
      console.warn("ZIP: failed to delete stale cached download:", e)
    }
  }

  try {
    const output = await File.downloadFileAsync(url, downloadDir)
    return output.uri
  } catch (error) {
    console.error("ZIP: Error downloading zip file", error)
    throw "DOWNLOAD_FAILED"
  }
}

/**
 * Unpack a local miniapp zip and install it under
 * `lmas/<packageName>/<version>/`.
 *
 * Zip layout: flat — files at root, `miniapp.json` at the top level. We're
 * strict on shape so we fail loudly on malformed bundles.
 *
 * @param zipPath          file:// URI of the zip on local disk.
 * @param versionOverride  override the manifest's version field. Used by the
 *                         dev miniapp caching path which stamps `dev-<ms>`
 *                         so multiple snapshots can coexist alongside
 *                         semver-installed versions.
 */
async function unpackMiniApp(
  zipPath: string,
  versionOverride?: string,
): Promise<{packageName: string; version: string}> {
  const unzipDir = new Directory(Paths.cache, "lma_unzip")
  try {
    if (unzipDir.exists) unzipDir.delete()
    unzipDir.create()
  } catch (error) {
    console.error("ZIP: Error creating or deleting the unzip directory", error)
    throw "CREATE_CACHE_DIR_FAILED"
  }

  try {
    console.log("ZIP: unzipping", zipPath)
    await unzip(zipPath, unzipDir.uri)
  } catch (error) {
    console.error("Error unzipping zip file", error)
    throw "UNZIP_FAILED"
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
    throw "READ_MANIFEST_FAILED"
  }
  const version = versionOverride ?? manifestVersion
  console.log(`ZIP: installing ${packageName} as version ${version}`)

  const basePackageDir = new Directory(Paths.document, "lmas", packageName)
  try {
    if (!basePackageDir.exists) {
      basePackageDir.create({intermediates: true})
    }
  } catch (error) {
    console.error("Error creating the base package directory", error)
    throw "CREATE_PACKAGE_DIR_FAILED"
  }

  const versionDir = new Directory(basePackageDir, version)
  try {
    if (!versionDir.exists) {
      versionDir.create()
    } else {
      versionDir.delete()
      versionDir.create()
    }
  } catch (error) {
    console.error("Error creating the version directory", error)
    throw "CREATE_VERSION_DIR_FAILED"
  }

  try {
    const contents = appDir.list()
    for (const item of contents) {
      item.move(versionDir)
    }
  } catch (error) {
    console.error("Error moving the contents of the folder to the destination directory", error)
    throw "INSTALL_CONTENTS_FAILED"
  }

  console.log("ZIP: local mini app installed at", versionDir.uri)
  printDirectory(versionDir, 2)
  return {packageName, version}
}

/**
 * Download a miniapp zip from `url`, unpack it, and install it under
 * `lmas/<packageName>/<version>/`. Thin composition of
 * {@link downloadMiniAppZip} + {@link unpackMiniApp} for remote bundles.
 *
 * @param versionOverride  override the manifest's version field. Used by the
 *                         dev miniapp caching path which stamps `dev-<ms>`
 *                         so multiple snapshots can coexist alongside
 *                         semver-installed versions.
 */
async function downloadAndInstallMiniApp(
  url: string,
  versionOverride?: string,
): Promise<{packageName: string; version: string}> {
  const downloadedZipPath = await downloadMiniAppZip(url)
  console.log("ZIP: done downloading, starting unzip")
  return unpackMiniApp(downloadedZipPath, versionOverride)
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

  private static instance: AppRegistry | null = null

  private constructor() {}

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
   * Download and install a miniapp bundle from a URL. The URL must serve a
   * zip whose root contains `miniapp.json` plus the bundle entry files.
   *
   * @param opts.versionOverride  if set, install under this version instead
   *   of `manifest.version`. The dev caching path uses `dev-<ms>` so multiple
   *   snapshots can coexist alongside semver-installed versions.
   */
  public installFromUrl(
    url: string,
    opts?: {versionOverride?: string; releaseIdentity?: MiniappReleaseIdentity},
  ): AsyncResult<void, Error> {
    return Res.try_async(async () => {
      const {packageName, version} = await downloadAndInstallMiniApp(url, opts?.versionOverride)
      console.log("APP_REGISTRY: Downloaded and installed mini app")
      this.finalizeInstall(
        packageName,
        version,
        opts?.releaseIdentity ?? {source: version.startsWith("dev-") ? "dev_snapshot" : "direct_download"},
      )
    })
  }

  /**
   * Install a miniapp from a zip already on local disk (e.g. a bundled asset
   * copied into cache). Skips the HTTP download path that `installFromUrl`
   * uses — `File.downloadFileAsync` is HTTP(S)-only and rejects file:// URIs.
   *
   * @param zipPath  file:// URI of the local zip.
   */
  public installFromLocalZip(
    zipPath: string,
    opts?: {versionOverride?: string; releaseIdentity?: MiniappReleaseIdentity},
  ): AsyncResult<{packageName: string; version: string}, Error> {
    return Res.try_async(async () => {
      const {packageName, version} = await unpackMiniApp(zipPath, opts?.versionOverride)
      console.log("APP_REGISTRY: Installed mini app from local zip")
      this.finalizeInstall(packageName, version, opts?.releaseIdentity ?? {source: "bundled_asset"})
      return {packageName, version}
    })
  }

  /**
   * Post-install bookkeeping shared by every install path: clear stale dev
   * artifacts on release installs, point the active-version at the just-
   * installed bundle, and notify subscribers to refresh.
   */
  private finalizeInstall(packageName: string, version: string, releaseIdentity: MiniappReleaseIdentity): void {
    // If this is a release install (semver, not dev-*) of a package that
    // currently has dev-* snapshots, clear the dev state so the swap to
    // "released" is clean. Otherwise the dev version would keep winning
    // getActiveVersion's dev-precedence rule and the just-installed
    // release wouldn't run.
    const isDevInstall = version.startsWith("dev-")
    if (!isDevInstall) {
      this.clearDevArtifacts(packageName)
    }

    this.setActiveVersion(packageName, version)
    storage.save(releaseIdentityKey(packageName, version), releaseIdentity)
    this.refreshNeeded = true
    this.notify()
  }

  public getReleaseIdentity(packageName: string, version: string): MiniappReleaseIdentity | null {
    const result = storage.load<MiniappReleaseIdentity>(releaseIdentityKey(packageName, version))
    return result.is_ok() ? result.value : null
  }

  public installFromJsonUrl(baseUrl: string): AsyncResult<{packageName: string; version: string; name: string}, Error> {
    return Res.try_async(async () => {
      const trimmed = baseUrl.replace(/\/$/, "")

      const manifestRes = await fetch(`${trimmed}/miniapp.json`)
      if (!manifestRes.ok) {
        throw new Error(`Failed to fetch miniapp.json: ${manifestRes.status}`)
      }
      const manifest = (await manifestRes.json()) as Record<string, unknown>
      const packageName = manifest.packageName as string | undefined
      const version = manifest.version as string | undefined
      const name = (manifest.name as string | undefined) ?? packageName ?? "Mini app"
      if (!packageName) throw new Error("miniapp.json missing packageName")
      if (!version) throw new Error("miniapp.json missing version")

      const installRes = await appRegistry.installFromUrl(`${trimmed}/bundle.zip`)
      if (installRes.is_error()) throw installRes.error

      return {packageName, version, name}
    })
  }

  /**
   * Drop every dev-* version directory for a package plus ALL dev MMKV keys
   * (URL/port/reachability + the home-tile metadata record). Called on a
   * release install (dev → released transition) and on uninstall, so a dev
   * package leaves nothing behind that `projectDevApps` could re-surface.
   */
  private clearDevArtifacts(packageName: string): void {
    try {
      const pkgDir = new Directory(Paths.document, "lmas", packageName)
      if (pkgDir.exists) {
        for (const item of pkgDir.list()) {
          if (item instanceof Directory && item.name.startsWith("dev-")) {
            try {
              storage.remove(releaseIdentityKey(packageName, item.name))
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
      for (let i = keep; i < dirs.length; i++) {
        try {
          dirs[i].delete()
        } catch (e) {
          console.warn(`APP_REGISTRY: failed to delete ${dirs[i].name}:`, e)
        }
      }
      if (dirs.length > keep) this.refreshNeeded = true
    } catch (e) {
      console.warn(`APP_REGISTRY: gcDevVersions error for ${packageName}:`, e)
    }
  }

  public uninstall(packageName: string, version?: string): AsyncResult<void, Error> {
    return Res.try_async(async () => {
      if (version) {
        const lmaDir = new Directory(Paths.document, "lmas", packageName, version)
        // Guard exists: a dev miniapp loads over HTTP and has no on-disk dir,
        // so an unconditional delete() would throw and abort the cleanup below.
        if (lmaDir.exists) lmaDir.delete()
        storage.remove(releaseIdentityKey(packageName, version))
        console.log("APP_REGISTRY: Uninstalled mini app version", version)
        const packageDir = new Directory(Paths.document, "lmas", packageName)
        if (packageDir.exists && packageDir.list().length === 0) {
          packageDir.delete()
        }
      } else {
        for (const installedVersion of this.getInstalledVersions(packageName)) {
          storage.remove(releaseIdentityKey(packageName, installedVersion))
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
      this.refreshNeeded = true
      this.notify()
    })
  }

  public getPackageNames(): string[] {
    try {
      const lmasDir = new Directory(Paths.document, "lmas")
      if (!lmasDir.exists) return []
      let lmas = lmasDir.list()
      lmas = lmas.filter((lma): lma is Directory => lma instanceof Directory && lma.list().length > 0)
      return lmas.map((lma) => lma.name)
    } catch (error) {
      console.error("APP_REGISTRY: Error getting locally installed package names", error)
      return []
    }
  }

  public getInstalledVersions(packageName: string): string[] {
    try {
      const lmaDir = new Directory(Paths.document, "lmas", packageName)
      // Not installed yet is an expected state (e.g. preinstall sync probing
      // versions before first install) — return [] without the error noise.
      if (!lmaDir.exists) {
        return []
      }
      const lma = lmaDir.list()
      return lma.map((lma) => lma.name)
    } catch (error) {
      console.error("APP_REGISTRY: Error getting local applet versions", error)
      return []
    }
  }

  public async getActiveVersion(packageName: string): Promise<string> {
    let versions = this.getInstalledVersions(packageName)
    // Treat MMKV as a hint, not authority. A stored version may have been
    // GC'd off disk without this pointer being updated.
    let res = storage.load<string>(`${packageName}_active_version`)
    if (res.is_ok() && versions.includes(res.value)) {
      return res.value
    }
    // Dev versions take precedence over semver-installed versions.
    const devVersions = versions
      .filter((v) => v.startsWith("dev-"))
      .sort()
      .reverse()
    if (devVersions.length > 0) {
      this.setActiveVersion(packageName, devVersions[0])
      return devVersions[0]
    }
    versions = versions.filter((v) => semver.valid(v))
    versions.sort((a, b) => semver.rcompare(a, b))
    this.setActiveVersion(packageName, versions[0])
    return versions[0]
  }

  public setActiveVersion(packageName: string, version: string): Result<void, Error> {
    return storage.save(`${packageName}_active_version`, version)
  }

  public getMetadata(packageName: string, version: string): InstalledInfo {
    try {
      const lmaDir = new Directory(Paths.document, "lmas", packageName, version)
      const miniappJsonFile = new File(lmaDir, "miniapp.json")
      const manifest = JSON.parse(miniappJsonFile.textSync())
      const logoUrl = new File(lmaDir, "icon.png").uri
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
  private mergeProjectedApps(diskApps: ClientApp[]): ClientApp[] {
    const offline = this.projectOfflineApps().filter((app) => isLocalMiniappAllowed(app.packageName))
    const offlinePackages = new Set(offline.map((app) => app.packageName))
    const dev = this.projectDevApps().filter(
      (app) => isLocalMiniappAllowed(app.packageName) && !offlinePackages.has(app.packageName),
    )
    const devPackages = new Set(dev.map((app) => app.packageName))
    const installed = diskApps.filter(
      (app) =>
        isLocalMiniappAllowed(app.packageName) &&
        !offlinePackages.has(app.packageName) &&
        !devPackages.has(app.packageName),
    )
    return [...installed, ...dev, ...offline]
  }

  public async getInstalledMiniapps(): Promise<ClientApp[]> {
    if (!this.refreshNeeded && this.cachedApps.length > 0) {
      // Cache hit: re-project running from the registry. The cached array
      // IS the disk-derived truth; running comes from the mount registry.
      return this.mergeProjectedApps(
        this.cachedApps.map((a) => ({
          ...a,
          running: miniappRunningRegistry.has(a.packageName),
        })),
      )
    }

    try {
      const installedInfo = this.getInstalledInfo()
      const out: ClientApp[] = []
      for (const lmaInfo of installedInfo) {
        const versionString = await this.getActiveVersion(lmaInfo.packageName)
        const versionInfo = lmaInfo.versions[versionString]

        const manifest = this.getMiniappManifest(lmaInfo.packageName, versionString) as {
          permissions?: Array<string | {type: string; required?: boolean; description?: string}>
          hardwareRequirements?: Array<{type: string; level: string; description?: string}>
          type?: string
          actions?: Array<{id?: unknown; description?: unknown; parameters?: unknown; outputSchema?: unknown}>
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
        if (isMiniappDev) {
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
      return this.mergeProjectedApps(this.cachedApps)
    } catch (error) {
      console.error("APP_REGISTRY: Error getting local applets", error)
      return this.mergeProjectedApps(
        this.cachedApps.map((a) => ({
          ...a,
          running: miniappRunningRegistry.has(a.packageName),
        })),
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
        logoUrl: rec.iconUrl,
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
  actions?: Array<{id?: unknown; description?: unknown; parameters?: unknown; outputSchema?: unknown}>
  /** Legacy single-slot migration field. New records use the real packageName directly. */
  sourcePackageName?: string
  /**
   * Short-lived Core-verifiable proof emitted by `mentra dev`. This lets the
   * dev runtime request auto-auth for the manifest package without letting
   * arbitrary dev URLs claim any package name.
   */
  devAttestation?: string
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
 * Register or update one dev miniapp under its real manifest package. Different
 * package names coexist; rescanning the same package updates that package only.
 */
export async function registerDevApp(record: DevAppRecord): Promise<void> {
  migrateLegacyDevSlot()
  const packageName = record.packageName.trim()
  if (!packageName) throw new Error("Dev miniapp manifest is missing packageName")

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

export function getDevAppAttestation(packageName = DEV_APP_PACKAGE_NAME): string | null {
  migrateLegacyDevSlot()
  return readDevAppRecord(packageName)?.devAttestation ?? null
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

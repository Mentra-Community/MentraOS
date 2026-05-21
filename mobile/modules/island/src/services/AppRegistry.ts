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

import type {AppletPermission, AppPermissionType, ClientApp} from "../types/applet"
import {HardwareRequirement, HardwareRequirementLevel, HardwareType} from "../types"
import {storage} from "../utils/storage/storage"
import {printDirectory} from "../utils/storage/zip"
import {miniappRunningRegistry} from "./MiniappRunningRegistry"

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

/**
 * Download a miniapp zip from `url`, unpack it, and install it under
 * `lmas/<packageName>/<version>/`.
 *
 * Zip layout: flat — files at root, `miniapp.json` at the top level. We're
 * strict on shape so we fail loudly on malformed bundles.
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
  let downloadedZipPath: string = ""

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
    downloadedZipPath = output.uri
  } catch (error) {
    console.error("ZIP: Error downloading zip file", error)
    throw "DOWNLOAD_FAILED"
  }

  console.log("ZIP: done downloading, starting unzip")

  const unzipDir = new Directory(Paths.cache, "lma_unzip")
  try {
    if (unzipDir.exists) unzipDir.delete()
    unzipDir.create()
  } catch (error) {
    console.error("ZIP: Error creating or deleting the unzip directory", error)
    throw "CREATE_CACHE_DIR_FAILED"
  }

  try {
    console.log("ZIP: unzipping", downloadedZipPath)
    await unzip(downloadedZipPath, unzipDir.uri)
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

type Listener = () => void

class AppRegistry {
  private cachedApps: ClientApp[] = []
  // Offline apps live in a separate layer so they survive the disk-rebuild
  // path in getInstalledMiniapps (which reassigns cachedApps).
  private offlineApps: ClientApp[] = []
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
    return `${Paths.document.uri}/lmas/${packageName}/${version}`
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
  public installFromUrl(url: string, opts?: {versionOverride?: string}): AsyncResult<void, Error> {
    return Res.try_async(async () => {
      const {packageName, version} = await downloadAndInstallMiniApp(url, opts?.versionOverride)
      console.log("APP_REGISTRY: Downloaded and installed mini app")

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
      this.refreshNeeded = true
      this.notify()
    })
  }

  public installFromJsonUrl(baseUrl: string): AsyncResult<{packageName: string, version: string, name: string}, Error> {
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
   * Drop every dev-* version directory for a package plus the dev MMKV keys.
   * Called on a release install so the package transitions cleanly from
   * "dev mode" to "released mode."
   */
  private clearDevArtifacts(packageName: string): void {
    try {
      const pkgDir = new Directory(Paths.document, "lmas", packageName)
      if (pkgDir.exists) {
        for (const item of pkgDir.list()) {
          if (item instanceof Directory && item.name.startsWith("dev-")) {
            try {
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
    storage.remove(`${packageName}_dev_last_reachable`)
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
        lmaDir.delete()
        console.log("APP_REGISTRY: Uninstalled mini app version", version)
        const packageDir = new Directory(Paths.document, "lmas", packageName)
        if (packageDir.exists && packageDir.list().length === 0) {
          packageDir.delete()
        }
      } else {
        const packageDir = new Directory(Paths.document, "lmas", packageName)
        if (packageDir.exists) {
          packageDir.delete()
        }
        console.log("APP_REGISTRY: Uninstalled all versions of mini app", packageName)
      }
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
   * Read the lmas/ tree and return one ClientApp per installed package,
   * picking each package's active version. The store/host overlays runtime
   * state (loading, hidden, compatibility) on top of these.
   *
   * `running` reflects MiniappHost mount state via miniappRunningRegistry.
   */
  public async getInstalledMiniapps(): Promise<ClientApp[]> {
    if (!this.refreshNeeded && this.cachedApps.length > 0) {
      // Cache hit: re-project running from the registry. The cached array
      // IS the disk-derived truth; running comes from the mount registry.
      return [
        ...this.cachedApps.map((a) => ({
          ...a,
          running: miniappRunningRegistry.has(a.packageName),
        })),
        ...this.projectOfflineApps(),
      ]
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
        } | null

        const permissions = normalizeManifestPermissions(manifest?.permissions)
        const hardwareRequirements = buildHardwareRequirements(manifest?.hardwareRequirements, lmaInfo.packageName)

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
          type: "standard",
          permissions,
          hardwareRequirements,
          ...(isMiniappDev ? {isMiniappDev: true} : {}),
          ...(devUrl ? {devUrl} : {}),
          onStart: () => saveLocalAppRunningState(lmaInfo.packageName, true),
          onStop: () => saveLocalAppRunningState(lmaInfo.packageName, false),
        })
      }

      this.cachedApps = out
      this.refreshNeeded = false
      return [...this.cachedApps, ...this.projectOfflineApps()]
    } catch (error) {
      console.error("APP_REGISTRY: Error getting local applets", error)
      return [
        ...this.cachedApps.map((a) => ({
          ...a,
          running: miniappRunningRegistry.has(a.packageName),
        })),
        ...this.projectOfflineApps(),
      ]
    }
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
  public installOfflineApp(app: ClientApp): void {
    this.offlineApps.push({
      ...app,
      onStart: () => saveLocalAppRunningState(app.packageName, true),
      onStop: () => saveLocalAppRunningState(app.packageName, false),
    })
    this.refreshNeeded = true
    this.notify()
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
  const res = storage.load<string>(`${packageName}_screenshot`)
  if (res.is_ok()) return res.value
  return undefined
}

const appRegistry = AppRegistry.getInstance()
export default appRegistry

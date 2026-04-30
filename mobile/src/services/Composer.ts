import {ClientAppletInterface, saveLocalAppRunningState, useAppletStatusStore} from "@/stores/applets"
import {miniappRunningRegistry} from "@/services/miniapp/MiniappRunningRegistry"
import {storage} from "@/utils/storage/storage"
import {printDirectory} from "@/utils/storage/zip"
import {Directory, Paths, File} from "expo-file-system"
import {unzip} from "react-native-zip-archive"
import {AsyncResult, Result, result as Res} from "typesafe-ts"
import semver from "semver"
import type {AppletPermission, AppPermissionType} from "@/../../cloud/packages/types/src"
import {HardwareRequirement, HardwareRequirementLevel, HardwareType} from "@/../../cloud/packages/types/src"

const ALLOWED_PERMISSION_TYPES: ReadonlySet<AppPermissionType> = new Set<AppPermissionType>([
  "MICROPHONE",
  "CAMERA",
  "CALENDAR",
  "LOCATION",
  "BACKGROUND_LOCATION",
  "READ_NOTIFICATIONS",
  "POST_NOTIFICATIONS",
])
export interface LmaPermission {
  type: string
  description: string
}

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
 * Convert declared hardwareRequirements from a miniapp.json manifest into the
 * runtime `HardwareRequirement[]` shape, and always append `{EXIST, REQUIRED}`
 * so the launcher shows "Glasses Required" for local miniapps when no glasses
 * are connected (matches cloud behavior at refreshApplets for remote apps).
 *
 * Malformed entries are dropped with a single warning per package so the rest
 * of the manifest still works.
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
      console.warn(
        `COMPOSER: ${packageName} has invalid hardwareRequirements (not an array); treating as []`,
      )
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
            `COMPOSER: ${packageName} has malformed hardwareRequirements entry; skipping invalid entries`,
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
  // version: string
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
 * The zip is expected to be flat (files at root, no enclosing folder)
 * with `miniapp.json` at the top level. We're strict on shape so we
 * fail loudly on malformed bundles instead of silently installing
 * something broken.
 *
 * @param versionOverride  override the manifest's version field. Used by
 *                         the dev miniapp caching path which stamps
 *                         `dev-<timestamp>` so multiple snapshots can
 *                         coexist alongside semver-installed versions.
 */
async function downloadAndInstallMiniApp(
  url: string,
  versionOverride?: string,
): Promise<{packageName: string; version: string}> {
  let downloadedZipPath: string = ""

  // create the download directory if it doesn't exist
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
  // The download is fast (LAN), no benefit to caching by filename.
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

  // Strict zip shape: miniapp.json must be at the unzip root. No tolerance
  // for an enclosing folder or app.json fallback — we own the dev-server
  // emit format (flat zip, miniapp.json at root) so any deviation indicates
  // a corrupt bundle that we should refuse rather than half-install.
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

  // move the contents of this folder to Documents/lmas/<version>/<packageName>

  const basePackageDir = new Directory(Paths.document, "lmas", packageName)
  try {
    if (!basePackageDir.exists) {
      basePackageDir.create({intermediates: true})
    }
  } catch (error) {
    console.error("Error creating the base package directory", error)
    throw "CREATE_PACKAGE_DIR_FAILED"
  }

  // create the version directory
  const versionDir = new Directory(basePackageDir, version)
  try {
    if (!versionDir.exists) {
      versionDir.create()
    } else {
      // delete the directory, then create it
      versionDir.delete()
      versionDir.create()
    }
  } catch (error) {
    console.error("Error creating the version directory", error)
    throw "CREATE_VERSION_DIR_FAILED"
  }

  // move the contents of the folder to the destination directory
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

class Composer {
  private installedLmas: ClientAppletInterface[] = []
  private refreshNeeded: boolean = false
  private pcmSub: any = null

  private static instance: Composer | null = null
  private constructor() {
    this.initialize()
  }

  public static getInstance(): Composer {
    if (!Composer.instance) {
      Composer.instance = new Composer()
    }
    return Composer.instance
  }

  // read local storage to find which mini apps are installed and running
  // if any mini app needs online or offlline transcriptions, we need to feed them the necessary data
  public async initialize() {
    // Scan Paths.document/lmas/ and populate appletStatusStore with installed miniapps.
    // Called explicitly from MantleManager.init() on every app launch.
    try {
      const applets = await this.getLocalApplets()
      console.log(`COMPOSER: initialize() found ${applets.length} installed miniapps`)
    } catch (error) {
      console.error("COMPOSER: initialize() error:", error)
    }
  }

  /**
   * Returns the on-disk path for a given miniapp bundle version.
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
      console.warn("COMPOSER: Error reading miniapp.json, trying app.json fallback", e)
    }
    try {
      const appJsonFile = new File(bundleDir, "app.json")
      if (appJsonFile.exists) {
        return JSON.parse(appJsonFile.textSync())
      }
    } catch (e) {
      console.warn("COMPOSER: Error reading app.json fallback", e)
    }
    return null
  }

  /**
   * Alias for installMiniApp — download and install a miniapp bundle from a URL.
   */
  public installFromUrl(url: string): AsyncResult<void, Error> {
    return this.installMiniApp(url)
  }

  // download the mini app from the url and unzip it to the app's cache directory/lma/<packageName>
  public installMiniApp(
    url: string,
    opts?: {versionOverride?: string},
  ): AsyncResult<void, Error> {
    return Res.try_async(async () => {
      const {packageName, version} = await downloadAndInstallMiniApp(url, opts?.versionOverride)
      console.log("COMPOSER: Downloaded and installed mini app")

      // If this is a release install (semver, not dev-*) of a package that
      // currently has dev-* snapshots from `mentra-miniapp dev`, clear the
      // dev state so the swap to "released" is clean. Otherwise the dev
      // version would keep winning getActiveAppletVersion's dev-precedence
      // rule and the user's just-installed release wouldn't run.
      const isDevInstall = version.startsWith("dev-")
      if (!isDevInstall) {
        this.clearDevArtifacts(packageName)
      }

      // Point the active-version MMKV at what we just installed. Without
      // this, getActiveAppletVersion would keep returning whatever first
      // ever got cached — and after gcDevVersions deletes that older dir,
      // metadata reads (line 547) would crash on undefined.
      this.setActiveAppletVersion(packageName, version)
      this.refreshNeeded = true
      await useAppletStatusStore.getState().refreshApplets()
    })
  }

  /**
   * Drop every dev-* version directory for a package plus the dev MMKV
   * keys. Called on a release install (sideloaded via `mentra-miniapp
   * install` or store) so the package transitions cleanly from "dev mode"
   * to "released mode."
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
              console.warn(`COMPOSER: failed to delete ${item.name}:`, e)
            }
          }
        }
      }
    } catch (e) {
      console.warn(`COMPOSER: clearDevArtifacts dir scan failed for ${packageName}:`, e)
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
          console.warn(`COMPOSER: failed to delete ${dirs[i].name}:`, e)
        }
      }
      if (dirs.length > keep) this.refreshNeeded = true
    } catch (e) {
      console.warn(`COMPOSER: gcDevVersions error for ${packageName}:`, e)
    }
  }

  public uninstallMiniApp(packageName: string, version?: string): AsyncResult<void, Error> {
    return Res.try_async(async () => {
      if (version) {
        const lmaDir = new Directory(Paths.document, "lmas", packageName, version)
        lmaDir.delete()
        console.log("COMPOSER: Uninstalled mini app version", version)
        // when uninstalling a version, if we have no versions left, delete the package directory:
        const packageDir = new Directory(Paths.document, "lmas", packageName)
        if (packageDir.exists && packageDir.list().length === 0) {
          packageDir.delete()
        }
      } else {
        // No version specified — remove all versions (entire package directory)
        const packageDir = new Directory(Paths.document, "lmas", packageName)
        if (packageDir.exists) {
          packageDir.delete()
        }
        console.log("COMPOSER: Uninstalled all versions of mini app", packageName)
      }
      this.refreshNeeded = true
      await useAppletStatusStore.getState().refreshApplets()
    })
  }

  public getPackageNames(): string[] {
    try {
      const lmasDir = new Directory(Paths.document, "lmas")
      if (!lmasDir.exists) {
        // console.log("COMPOSER: No lmas directory found, returning empty array")
        return []
      }
      let lmas = lmasDir.list()
      // keep only package directories that contain at least one version directory/file
      lmas = lmas.filter((lma): lma is Directory => lma instanceof Directory && lma.list().length > 0)
      return lmas.map((lma) => lma.name)
    } catch (error) {
      console.error("COMPOSER: Error getting locally installed package names", error)
      return []
    }
  }

  public getAppletInstalledVersions(packageName: string): string[] {
    try {
      const lmaDir = new Directory(Paths.document, "lmas", packageName)
      const lma = lmaDir.list()
      console.log("COMPOSER: Local applet", lma)
      return lma.map((lma) => lma.name)
    } catch (error) {
      console.error("COMPOSER: Error getting local applet versions", error)
      return []
    }
  }

  public async getActiveAppletVersion(packageName: string): Promise<string> {
    let versions = this.getAppletInstalledVersions(packageName)
    // Treat MMKV as a hint, not authority. A stored version may have been
    // GC'd off disk (gcDevVersions) without this pointer being updated, in
    // which case `installedVersions` no longer contains it. Fall through and
    // re-pick instead of letting downstream code crash on `undefined`
    // metadata when the directory has been pruned.
    let res = storage.load<string>(`${packageName}_active_version`)
    if (res.is_ok() && versions.includes(res.value)) {
      return res.value
    }
    // if no valid active version is set, set it to the latest version:
    // Dev versions take precedence over semver-installed versions — re-scanning
    // a dev miniapp replaces the package directory entirely in practice, so
    // having both side-by-side is unusual, but if it happens dev wins. Pick
    // the newest dev-* by lexicographic sort (timestamp suffix).
    const devVersions = versions
      .filter((v) => v.startsWith("dev-"))
      .sort()
      .reverse()
    if (devVersions.length > 0) {
      await this.setActiveAppletVersion(packageName, devVersions[0])
      return devVersions[0]
    }
    // No dev versions — semver path. Filter out any non-semver entries to be safe.
    versions = versions.filter((v) => semver.valid(v))
    versions.sort((a, b) => semver.rcompare(a, b))
    await this.setActiveAppletVersion(packageName, versions[0])
    return versions[0]
  }

  public setActiveAppletVersion(packageName: string, version: string): Result<void, Error> {
    return storage.save(`${packageName}_active_version`, version)
  }

  public getAppletMetadata(packageName: string, version: string): InstalledInfo {
    try {
      const lmaDir = new Directory(Paths.document, "lmas", packageName, version)
      // Read miniapp.json (the new manifest filename). app.json was the old
      // name; greenfield, no need to fall back.
      const miniappJsonFile = new File(lmaDir, "miniapp.json")
      const manifest = JSON.parse(miniappJsonFile.textSync())
      const logoUrl = new File(lmaDir, "icon.png").uri
      return {name: manifest.name, logoUrl: logoUrl}
    } catch (error) {
      console.error("COMPOSER: Error getting local miniapp metadata", error)
      return {name: "error", logoUrl: ""}
    }
  }

  // return {packageName: string, versions: string[]}
  public getInstalledAppletsInfo(): InstalledLma[] {
    const packageNames = this.getPackageNames()
    const appletsInfo: InstalledLma[] = []
    for (const packageName of packageNames) {
      const versionStrings = this.getAppletInstalledVersions(packageName)
      const installedVersion: InstalledLma = {packageName, versions: {}}

      for (const versionString of versionStrings) {
        const info: InstalledInfo = this.getAppletMetadata(packageName, versionString)
        installedVersion.versions[versionString] = info
      }
      appletsInfo.push(installedVersion)
    }
    // console.log("COMPOSER: Applets info", appletsInfo)
    return appletsInfo
  }

  public async getLocalApplets(): Promise<ClientAppletInterface[]> {
    if (!this.refreshNeeded && this.installedLmas.length > 0) {
      // Cache hit: re-project running from the registry. The store is NOT
      // the source of truth here — on cold boot Composer.initialize() builds
      // installedLmas before refreshApplets has populated the store, so
      // querying the store would return [] and lose every local applet.
      // installedLmas IS the disk-derived truth; running comes from the
      // mount registry overlay.
      return this.installedLmas.map((a) => ({
        ...a,
        running: miniappRunningRegistry.has(a.packageName),
      }))
    }

    try {
      const installedLmasInfo = await this.getInstalledAppletsInfo()
      // console.log("COMPOSER: Installed Lmas Info", installedLmasInfo)
      // use the latest version for now (will be overriddable later via <packageName>_version_key)
      // build the installedLmas array:
      const lmas: ClientAppletInterface[] = []
      for (const lmaInfo of installedLmasInfo) {
        let versionString = await this.getActiveAppletVersion(lmaInfo.packageName)
        let versionInfo = lmaInfo.versions[versionString]

        // Read manifest (miniapp.json with app.json fallback, via the shared
        // helper). Extract permissions + hardwareRequirements.
        const manifest = this.getMiniappManifest(lmaInfo.packageName, versionString) as
          | {
              permissions?: Array<string | {type: string; required?: boolean; description?: string}>
              hardwareRequirements?: Array<{type: string; level: string; description?: string}>
            }
          | null

        const permissions = normalizeManifestPermissions(manifest?.permissions)
        const hardwareRequirements = buildHardwareRequirements(
          manifest?.hardwareRequirements,
          lmaInfo.packageName,
        )

        // Dev miniapps live in the same lmas/ tree as installed ones, but
        // their version directory name starts with "dev-". Surface them via
        // the existing applet store with isMiniappDev=true so UI code that
        // already reads the flag (badge, lifecycle, bug-report skip) works.
        const isMiniappDev = versionString.startsWith("dev-")
        let devUrl: string | undefined
        let devPort: number | undefined
        if (isMiniappDev) {
          const devUrlRes = storage.load<string>(`${lmaInfo.packageName}_dev_url`)
          if (devUrlRes.is_ok()) devUrl = devUrlRes.value
          const devPortRes = storage.load<number>(`${lmaInfo.packageName}_dev_port`)
          if (devPortRes.is_ok()) devPort = devPortRes.value
        }

        // `running` reflects MiniappHost mount state — a local miniapp is
        // running iff its WebView is mounted in MiniappHost (foreground OR
        // backgrounded). This is the single source of truth; do not write
        // `running` from any other path.
        lmas.push({
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
          ...(devPort ? {devPort} : {}),
          onStart: () => saveLocalAppRunningState(lmaInfo.packageName, true),
          onStop: () => saveLocalAppRunningState(lmaInfo.packageName, false),
        })
      }

      this.installedLmas = lmas
      this.refreshNeeded = false

      // console.log("COMPOSER: Installed Lmas", this.installedLmas)
      return this.installedLmas
    } catch (error) {
      console.error("Error getting local applets", error)
      // Re-project running from the registry on the cached fallback so the
      // switcher still reflects current mount state even if the rebuild failed.
      return this.installedLmas.map((a) => ({
        ...a,
        running: miniappRunningRegistry.has(a.packageName),
      }))
    }
  }

  public getLocalMiniAppHtml(packageName: string, version: string): Result<string, Error> {
    return Res.try(() => {
      const lmaDir = new Directory(Paths.document, "lmas", packageName, version)
      const htmlFile = new File(lmaDir, "index.html")
      return htmlFile.textSync()
    })
  }

  // public startStop(applet: ClientAppletInterface, status: boolean): AsyncResult<void, Error> {
  //   return Res.try_async(async () => {})
  // }

  // manage global state for apps and mic data / transcriptions:
  public async updateOfflineSTT() {
    // const offlineCaptionsRunning = await useSettingsStore.getState().getSetting(SETTINGS.offline_captions_running.key)
    // const offlineTranslationRunning = await useSettingsStore
    //   .getState()
    //   .getSetting(SETTINGS.offline_translation_running.key)
    // if (offlineCaptionsRunning) {
    // }
  }
}

const composer = Composer.getInstance()
export default composer

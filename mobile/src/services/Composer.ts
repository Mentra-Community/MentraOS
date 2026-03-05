import {
  ClientAppletInterface,
  lmaInstallerPackageName,
  saveLocalAppRunningState,
  useAppletStatusStore,
} from "@/stores/applets"
import {storage} from "@/utils/storage/storage"
import {printDirectory} from "@/utils/storage/zip"
import {Directory, Paths, File} from "expo-file-system"
import {unzip} from "react-native-zip-archive"
import {AsyncResult, Result} from "typesafe-ts"
import {result as Res} from "typesafe-ts"
import semver from "semver"
export interface LmaPermission {
  type: string
  description: string
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

async function downloadAndInstallMiniApp(url: string) {
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

  try {
    const output = await File.downloadFileAsync(url, downloadDir)
    downloadedZipPath = output.uri
  } catch (error) {
    let errorMessage = error + ""
    if (errorMessage.includes("already exists")) {
      console.log("ZIP: File already exists, skipping download")
      downloadedZipPath = `${Paths.cache.uri}/lma_downloads/${url.split("/").pop()}`
    } else {
      console.error("ZIP: Error downloading zip file", error)
      throw "DOWNLOAD_FAILED"
    }
  }

  console.log("ZIP: done downloading, starting unzip")

  const unzipDir = new Directory(Paths.cache, "lma_unzip")
  try {
    if (!unzipDir.exists) {
      unzipDir.create()
    } else {
      // delete the directory, then create it
      unzipDir.delete()
      unzipDir.create()
    }
  } catch (error) {
    console.error("ZIP: Error creating or deleting the unzip directory", error)
    throw "CREATE_CACHE_DIR_FAILED"
  }

  let res = null
  try {
    console.log("ZIP: unzipping", downloadedZipPath)
    console.log("ZIP: unzip directory", unzipDir.uri)
    res = await unzip(downloadedZipPath, unzipDir.uri)
    // console.log(unzipOutput.exists) // true
    // console.log(unzipOutput.uri) // path to the unzipped file, e.g., '${cacheDirectory}/pdfs/sample.pdf'
  } catch (error) {
    console.error("Error unzipping zip file", error)
    throw "UNZIP_FAILED"
  }

  console.log("ZIP: done unzipping", res)

  // get the package name and info from the app.json file:
  let packageName = null
  let version = null
  let folderName = null
  try {
    const firstFile = unzipDir.list()[0] // this should be the folder containing the app.json file
    folderName = firstFile.name
    // read firstFile/app.json:
    const appJsonFile = new File(firstFile as Directory, "app.json")
    const appJson = JSON.parse(appJsonFile.textSync())
    packageName = appJson.packageName
    version = appJson.version

    console.log("ZIP: package name", packageName)
    console.log("ZIP: version", version)
  } catch (error) {
    console.error("Error reading the app.json file", error)
    throw "READ_APP_JSON_FAILED"
  }

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
    const folder = new Directory(unzipDir, folderName)
    const contents = folder.list()
    for (const item of contents) {
      item.move(versionDir)
    }
  } catch (error) {
    console.error("Error moving the contents of the folder to the destination directory", error)
    throw "INSTALL_CONTENTS_FAILED"
  }

  console.log("ZIP: local mini app installed at", versionDir.uri)
  printDirectory(versionDir, 2)
}

class Composer {
  private onlineTranscriptions: boolean = false
  private offlineTranscriptions: boolean = false
  private pcmData: boolean = false
  private installedLmas: ClientAppletInterface[] = []
  private refreshNeeded: boolean = false

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
  private initialize() {
    // update the applets store with the installed mini apps:
    // useAppletStatusStore.getState().setInstalledLmas(this.installedLmas)
    // useAppletStatusStore.getState().refreshApplets()
  }

  // download the mini app from the url and unzip it to the app's cache directory/lma/<packageName>
  public installMiniApp(url: string): AsyncResult<void, Error> {
    return Res.try_async(async () => {
      await downloadAndInstallMiniApp(url)
      console.log("COMPOSER: Downloaded and installed mini app")
      this.refreshNeeded = true
      await useAppletStatusStore.getState().refreshApplets()
    })
  }

  public uninstallMiniApp(packageName: string, version: string): AsyncResult<void, Error> {
    return Res.try_async(async () => {
      const lmaDir = new Directory(Paths.document, "lmas", packageName, version)
      lmaDir.delete()
      console.log("COMPOSER: Uninstalled mini app")
      this.refreshNeeded = true
      await useAppletStatusStore.getState().refreshApplets()
    })
  }

  public getPackageNames(): string[] {
    try {
      const lmasDir = new Directory(Paths.document, "lmas")
      const lmas = lmasDir.list()
      console.log("COMPOSER: Local applets", lmas)
      return lmas.map((lma) => lma.name)
    } catch (error) {
      // console.error("COMPOSER: Error getting local package names", error)
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
    let res = storage.load<string>(`${packageName}_active_version`)
    if (res.is_ok()) {
      return res.value
    }
    // if no active version is set, set it to the latest version:
    // get the versions:
    let versions = this.getAppletInstalledVersions(packageName)
    // make sure they are sorted, newest first
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
      const appJsonFile = new File(lmaDir, "app.json")
      const appJson = JSON.parse(appJsonFile.textSync())
      const logoUrl = new File(lmaDir, "icon.png").uri
      return {name: appJson.name, logoUrl: logoUrl}
    } catch (error) {
      console.error("COMPOSER: Error getting local applet metadata", error)
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
      // return this.installedLmas
      // this is the source of truth for running state:
      return useAppletStatusStore.getState().apps.filter((a) => a.local)
    }

    const installedLmasInfo = await this.getInstalledAppletsInfo()
    // console.log("COMPOSER: Installed Lmas Info", installedLmasInfo)
    // use the latest version for now (will be overriddable later via <packageName>_version_key)
    // build the installedLmas array:
    const lmas: ClientAppletInterface[] = []
    for (const lmaInfo of installedLmasInfo) {
      let versionString = await this.getActiveAppletVersion(lmaInfo.packageName)
      let versionInfo = lmaInfo.versions[versionString]
      lmas.push({
        packageName: lmaInfo.packageName,
        version: versionString,
        running: false,
        local: true,
        healthy: true,
        loading: false,
        offline: false,
        offlineRoute: "",
        name: versionInfo.name,
        webviewUrl: "",
        logoUrl: versionInfo.logoUrl,
        type: "standard",
        permissions: [],
        hardwareRequirements: [],
        onStart: () => saveLocalAppRunningState(lmaInfo.packageName, true),
        onStop: () => saveLocalAppRunningState(lmaInfo.packageName, false),
      })
    }

    this.installedLmas = lmas
    this.refreshNeeded = false

    console.log("COMPOSER: Installed Lmas", this.installedLmas)

    return this.installedLmas
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
}

const composer = Composer.getInstance()
export default composer

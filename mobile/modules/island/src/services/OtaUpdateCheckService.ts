import BluetoothSdk from "../../../bluetooth-sdk/build/_internal"
import type {OtaUpdateInfo} from "../../../bluetooth-sdk/build/_internal"
import {getGlassesSystemTimeMs, isGlassesConnected, useGlassesStore, waitForGlassesState} from "../stores/glasses"
import {maybeFixGlassesClockFromVersionInfo} from "./glassesClockSync"
import {getAsgOtaVersionUrl} from "./asgOtaVersionUrl"

export interface VersionInfo {
  versionCode: number
  versionName: string
  downloadUrl: string
  apkSize: number
  sha256: string
  releaseNotes: string
  isRequired?: boolean
}

export interface MtkPatch {
  start_firmware: string
  end_firmware: string
  url: string
}

export interface BesFirmware {
  version: string
  url: string
}

export interface VersionJson {
  apps?: {
    [packageName: string]: VersionInfo
  }
  mtk_patches?: MtkPatch[]
  bes_firmware?: BesFirmware
  versionCode?: number
  versionName?: string
  downloadUrl?: string
  apkSize?: number
  sha256?: string
  releaseNotes?: string
}

export interface OtaCheckResult {
  hasCheckCompleted: boolean
  updateAvailable: boolean
  latestVersionInfo: VersionInfo | null
  updates: string[]
  mtkPatch: MtkPatch | null
  besVersion: string | null
}

export type OtaCheckSkippedReason = "disconnected" | "missing_build"

export interface OtaCheckCurrentGlassesResult extends OtaCheckResult {
  updateInfo: OtaUpdateInfo | null
  isRequired: boolean
  skippedReason?: OtaCheckSkippedReason
  manifestUrl?: string
  buildNumber?: string
  mtkFirmwareVersion?: string
  besFirmwareVersion?: string
}

export interface OtaCheckCurrentGlassesOptions {
  waitForBuildNumberMs?: number
  waitForBesVersionMs?: number
  waitForMtkVersionMs?: number
  refreshVersionInfo?: boolean
  fixClockBeforeCheck?: boolean
}

function emptyCheckResult(skippedReason?: OtaCheckSkippedReason): OtaCheckCurrentGlassesResult {
  return {
    hasCheckCompleted: false,
    updateAvailable: false,
    latestVersionInfo: null,
    updates: [],
    mtkPatch: null,
    besVersion: null,
    updateInfo: null,
    isRequired: true,
    skippedReason,
  }
}

function glassesConnectedNow(): boolean {
  return isGlassesConnected(useGlassesStore.getState().connection)
}

export async function fetchVersionInfo(url: string): Promise<VersionJson | null> {
  try {
    const response = await fetch(url)
    if (!response.ok) {
      console.error("Failed to fetch version info:", response.status)
      return null
    }
    return await response.json()
  } catch (error) {
    console.error("OTA: Error fetching version info:", error)
    return null
  }
}

export function checkVersionUpdateAvailable(
  currentBuildNumber: string | undefined,
  versionJson: VersionJson | null,
): boolean {
  if (!currentBuildNumber || !versionJson) {
    return false
  }

  const currentVersion = parseInt(currentBuildNumber, 10)
  if (isNaN(currentVersion)) {
    return false
  }

  let serverVersion: number | undefined

  if (versionJson.apps?.["com.mentra.asg_client"]) {
    serverVersion = versionJson.apps["com.mentra.asg_client"].versionCode
  } else if (versionJson.versionCode) {
    serverVersion = versionJson.versionCode
  }

  if (!serverVersion || isNaN(serverVersion)) {
    return false
  }

  return serverVersion > currentVersion
}

export function getLatestVersionInfo(versionJson: VersionJson | null): VersionInfo | null {
  if (!versionJson) {
    return null
  }

  if (versionJson.apps?.["com.mentra.asg_client"]) {
    return versionJson.apps["com.mentra.asg_client"]
  }

  if (versionJson.versionCode) {
    return {
      versionCode: versionJson.versionCode,
      versionName: versionJson.versionName || "",
      downloadUrl: versionJson.downloadUrl || "",
      apkSize: versionJson.apkSize || 0,
      sha256: versionJson.sha256 || "",
      releaseNotes: versionJson.releaseNotes || "",
    }
  }

  return null
}

export function findMatchingMtkPatch(
  patches: MtkPatch[] | undefined,
  currentVersion: string | undefined,
): MtkPatch | null {
  if (!patches || !currentVersion) {
    return null
  }

  return (
    patches.find((patch) => {
      if (patch.start_firmware === currentVersion) {
        return true
      }
      const serverDate = patch.start_firmware.includes("_")
        ? patch.start_firmware.split("_").pop()
        : patch.start_firmware
      return serverDate === currentVersion
    }) || null
  )
}

export function checkBesUpdate(besFirmware: BesFirmware | undefined, currentVersion: string | undefined): boolean {
  if (!besFirmware) {
    return false
  }

  if (!currentVersion) {
    console.log(`📱 BES current version unknown - assuming update needed (server: ${besFirmware.version})`)
    return true
  }
  return compareVersions(besFirmware.version, currentVersion) > 0
}

function compareVersions(version1: string, version2: string): number {
  if (version1.includes(".") && version2.includes(".")) {
    const parts1 = version1.split(".")
    const parts2 = version2.split(".")
    const maxLen = Math.max(parts1.length, parts2.length)

    for (let i = 0; i < maxLen; i++) {
      const v1 = i < parts1.length ? parseInt(parts1[i], 10) : 0
      const v2 = i < parts2.length ? parseInt(parts2[i], 10) : 0
      if (v1 !== v2) {
        return v1 - v2
      }
    }
    return 0
  }

  return version1.localeCompare(version2)
}

export async function checkForOtaUpdate(
  otaVersionUrl: string,
  currentBuildNumber: string,
  currentMtkVersion?: string,
  currentBesVersion?: string,
): Promise<OtaCheckResult> {
  try {
    console.log("OTA: Checking for OTA update - URL: " + otaVersionUrl + ", current build: " + currentBuildNumber)
    const versionJson = await fetchVersionInfo(otaVersionUrl)
    const latestVersionInfo = getLatestVersionInfo(versionJson)

    const apkUpdateAvailable = checkVersionUpdateAvailable(currentBuildNumber, versionJson)
    console.log(`OTA: APK update available: ${apkUpdateAvailable} (current: ${currentBuildNumber})`)

    const mtkPatch = findMatchingMtkPatch(versionJson?.mtk_patches, currentMtkVersion)
    const mtkUpdateAvailable = mtkPatch !== null
    if (!currentMtkVersion && versionJson?.mtk_patches?.length) {
      console.log(`OTA: MTK current version unknown - skipping MTK patch check`)
    }
    console.log(
      `OTA: MTK patch available: ${mtkUpdateAvailable ? "yes" : "no"} (current MTK: ${currentMtkVersion || "unknown"})`,
    )

    const besUpdateAvailable = checkBesUpdate(versionJson?.bes_firmware, currentBesVersion)
    console.log(`OTA: BES update available: ${besUpdateAvailable} (current BES: ${currentBesVersion || "unknown"})`)

    const updates: string[] = []
    if (apkUpdateAvailable) updates.push("apk")
    if (mtkUpdateAvailable) updates.push("mtk")
    if (besUpdateAvailable) updates.push("bes")

    console.log(`OTA: OTA check result - updates available: ${updates.length > 0}, updates: [${updates.join(", ")}]`)

    return {
      hasCheckCompleted: true,
      updateAvailable: updates.length > 0,
      latestVersionInfo,
      updates,
      mtkPatch,
      besVersion: versionJson?.bes_firmware?.version || null,
    }
  } catch (error) {
    console.error("Error checking for OTA update:", error)
    return {
      hasCheckCompleted: false,
      updateAvailable: false,
      latestVersionInfo: null,
      updates: [],
      mtkPatch: null,
      besVersion: null,
    }
  }
}

export async function checkCurrentGlassesForUpdate(
  options: OtaCheckCurrentGlassesOptions = {},
): Promise<OtaCheckCurrentGlassesResult> {
  const {
    waitForBuildNumberMs = 0,
    waitForBesVersionMs = 5000,
    waitForMtkVersionMs = 2000,
    refreshVersionInfo = true,
    fixClockBeforeCheck = true,
  } = options

  if (!glassesConnectedNow()) {
    return emptyCheckResult("disconnected")
  }

  if (refreshVersionInfo) {
    void BluetoothSdk.requestVersionInfo().catch((error) => {
      console.warn("OTA: Failed to request version_info from glasses:", error)
    })
  }

  let buildNumber = useGlassesStore.getState().buildNumber
  if (!buildNumber && waitForBuildNumberMs > 0) {
    await waitForGlassesState("buildNumber", (value) => !!value, waitForBuildNumberMs)
    buildNumber = useGlassesStore.getState().buildNumber
  }

  if (!buildNumber) {
    return emptyCheckResult("missing_build")
  }

  if (!glassesConnectedNow()) {
    return emptyCheckResult("disconnected")
  }

  let besFirmwareVersion = useGlassesStore.getState().besFirmwareVersion
  if (!besFirmwareVersion && waitForBesVersionMs > 0) {
    console.log("OTA: BES version still unknown - waiting up to 5s for it to arrive...")
    await waitForGlassesState("besFirmwareVersion", (value) => !!value, waitForBesVersionMs)
    besFirmwareVersion = useGlassesStore.getState().besFirmwareVersion
    if (besFirmwareVersion) {
      console.log(`OTA: BES version arrived: ${besFirmwareVersion}`)
    } else {
      console.log("OTA: BES version still unknown after extended wait - will assume BES update if published")
    }
  }

  if (!glassesConnectedNow()) {
    return emptyCheckResult("disconnected")
  }

  let mtkFirmwareVersion = useGlassesStore.getState().mtkFirmwareVersion
  if (!mtkFirmwareVersion && waitForMtkVersionMs > 0) {
    await waitForGlassesState("mtkFirmwareVersion", (value) => !!value, waitForMtkVersionMs)
    mtkFirmwareVersion = useGlassesStore.getState().mtkFirmwareVersion
  }

  if (!glassesConnectedNow()) {
    return emptyCheckResult("disconnected")
  }

  if (fixClockBeforeCheck) {
    const systemTimeMs = getGlassesSystemTimeMs()
    await maybeFixGlassesClockFromVersionInfo(systemTimeMs > 0 ? systemTimeMs : undefined).catch((error) => {
      console.warn("OTA: clock fix attempt failed; continuing OTA check", error)
    })
  }

  const manifestUrl = getAsgOtaVersionUrl(useGlassesStore.getState().otaVersionUrl, buildNumber)
  const result = await checkForOtaUpdate(manifestUrl, buildNumber, mtkFirmwareVersion, besFirmwareVersion)

  if (!result.hasCheckCompleted) {
    return {
      ...result,
      updateInfo: null,
      isRequired: true,
      manifestUrl,
      buildNumber,
      mtkFirmwareVersion,
      besFirmwareVersion,
    }
  }

  const mtkUpdatedThisSession = useGlassesStore.getState().mtkUpdatedThisSession
  let filteredUpdates = result.updates
  if (mtkUpdatedThisSession && filteredUpdates.includes("mtk")) {
    console.log("OTA: Filtering out MTK - already updated this session (pending reboot)")
    filteredUpdates = filteredUpdates.filter((update) => update !== "mtk")
  }

  const updateAvailable = filteredUpdates.length > 0 && !!result.latestVersionInfo
  const updateInfo = updateAvailable
    ? {
        available: true,
        versionCode: result.latestVersionInfo?.versionCode || 0,
        versionName: result.latestVersionInfo?.versionName || "",
        updates: filteredUpdates,
        totalSize: 0,
      }
    : null

  useGlassesStore.getState().setOtaUpdateAvailable(updateInfo)

  return {
    ...result,
    updateAvailable,
    updates: filteredUpdates,
    updateInfo,
    isRequired: result.latestVersionInfo?.isRequired !== false,
    manifestUrl,
    buildNumber,
    mtkFirmwareVersion,
    besFirmwareVersion,
  }
}

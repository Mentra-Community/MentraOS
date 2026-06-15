import PrivateBluetoothSdkModule from "./_private/BluetoothSdkModule"
import {isConnectedGlassesConnectionStatus} from "./BluetoothSdk.types"
import type {GlassesStatus, OtaStartAckEvent, VersionInfoResult} from "./BluetoothSdk.types"

const DEFAULT_OTA_VERSION_URL = "https://staging.ota.mentraglass.com/staging_live_version.json"
const PROD_OTA_VERSION_URL = "https://ota.mentraglass.com/prod_live_version.json"
const ASG_CLIENT_PACKAGE = "com.mentra.asg_client"

type OtaManifestApp = {
  versionCode?: number
  versionName?: string
  apkSize?: number
  sha256?: string
}

type MtkPatch = {
  start_firmware: string
}

type BesFirmware = {
  version: string
}

type OtaManifest = {
  apps?: Record<string, OtaManifestApp | undefined>
  mtk_patches?: MtkPatch[]
  bes_firmware?: BesFirmware
  versionCode?: number
  versionName?: string
  apkSize?: number
  sha256?: string
}

let configuredOtaVersionUrl = DEFAULT_OTA_VERSION_URL

function normalizeHttpUrl(value: string | null): string | null {
  if (value == null) {
    return null
  }
  const trimmed = value.trim()
  if (!trimmed) {
    return null
  }
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new Error("OTA version URL must be a valid http(s) URL.")
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("OTA version URL must be an http(s) URL.")
  }
  return url.toString()
}

export function setOtaVersionUrl(otaVersionUrl: string | null): void {
  configuredOtaVersionUrl = normalizeHttpUrl(otaVersionUrl) ?? DEFAULT_OTA_VERSION_URL
}

export function getOtaVersionUrl(): string {
  return configuredOtaVersionUrl
}

function isLegacyAsgOtaStartBuild(buildNumber?: string | null): boolean {
  const parsed = Number.parseInt(buildNumber ?? "", 10)
  return Number.isFinite(parsed) && parsed < 100000
}

function resolveOtaVersionUrl(status: Pick<GlassesStatus, "buildNumber" | "otaVersionUrl">): string {
  const deviceUrl = status.otaVersionUrl?.trim()
  if (isLegacyAsgOtaStartBuild(status.buildNumber)) {
    return deviceUrl || PROD_OTA_VERSION_URL
  }
  return configuredOtaVersionUrl || deviceUrl || PROD_OTA_VERSION_URL
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function latestAppInfo(manifest: OtaManifest | null): OtaManifestApp | null {
  if (!manifest) {
    return null
  }
  const app = manifest.apps?.[ASG_CLIENT_PACKAGE]
  if (app?.versionCode) {
    return app
  }
  if (manifest.versionCode) {
    return {
      versionCode: manifest.versionCode,
      versionName: manifest.versionName ?? "",
      apkSize: manifest.apkSize ?? 0,
      sha256: manifest.sha256 ?? "",
    }
  }
  return null
}

function hasApkUpdate(currentBuildNumber: string | undefined, manifest: OtaManifest | null): boolean {
  const currentVersion = Number.parseInt(currentBuildNumber ?? "", 10)
  const serverVersion = numberValue(latestAppInfo(manifest)?.versionCode)
  return Number.isFinite(currentVersion) && serverVersion != null && serverVersion > currentVersion
}

function hasMtkUpdate(patches: MtkPatch[] | undefined, currentVersion: string | undefined): boolean {
  if (!patches?.length || !currentVersion) {
    return false
  }
  return patches.some((patch) => {
    if (patch.start_firmware === currentVersion) {
      return true
    }
    const serverDate = patch.start_firmware.includes("_") ? patch.start_firmware.split("_").pop() : patch.start_firmware
    return serverDate === currentVersion
  })
}

function compareVersions(version1: string, version2: string): number {
  if (version1.includes(".") && version2.includes(".")) {
    const parts1 = version1.split(".")
    const parts2 = version2.split(".")
    const maxLen = Math.max(parts1.length, parts2.length)
    for (let i = 0; i < maxLen; i++) {
      const v1 = i < parts1.length ? Number.parseInt(parts1[i], 10) : 0
      const v2 = i < parts2.length ? Number.parseInt(parts2[i], 10) : 0
      if (v1 !== v2) {
        return v1 - v2
      }
    }
    return 0
  }
  return version1.localeCompare(version2)
}

function hasBesUpdate(besFirmware: BesFirmware | undefined, currentVersion: string | undefined): boolean {
  if (!besFirmware) {
    return false
  }
  if (!currentVersion) {
    return true
  }
  return compareVersions(besFirmware.version, currentVersion) > 0
}

async function getFreshGlassesStatus(): Promise<GlassesStatus> {
  const status = await PrivateBluetoothSdkModule.getGlassesStatus()
  if (!isConnectedGlassesConnectionStatus(status.connection) || status.buildNumber) {
    return status
  }
  let versionInfo: VersionInfoResult
  try {
    versionInfo = await PrivateBluetoothSdkModule.requestVersionInfo()
  } catch {
    return status
  }
  return {
    ...status,
    appVersion: versionInfo.appVersion || status.appVersion,
    androidVersion: versionInfo.androidVersion || status.androidVersion,
    besFirmwareVersion: versionInfo.besFirmwareVersion || status.besFirmwareVersion,
    buildNumber: versionInfo.buildNumber || status.buildNumber,
    firmwareVersion: versionInfo.firmwareVersion || status.firmwareVersion,
    mtkFirmwareVersion: versionInfo.mtkFirmwareVersion || status.mtkFirmwareVersion,
    otaVersionUrl: versionInfo.otaVersionUrl || status.otaVersionUrl,
    systemTimeMs: versionInfo.systemTimeMs ?? status.systemTimeMs,
  }
}

async function fetchOtaManifest(otaVersionUrl: string): Promise<OtaManifest | null> {
  const response = await fetch(otaVersionUrl)
  if (!response.ok) {
    return null
  }
  return (await response.json()) as OtaManifest
}

export async function checkForOtaUpdate(): Promise<boolean> {
  const status = await getFreshGlassesStatus()
  if (!isConnectedGlassesConnectionStatus(status.connection) || !status.buildNumber) {
    return false
  }

  const otaVersionUrl = resolveOtaVersionUrl(status)
  const manifest = await fetchOtaManifest(otaVersionUrl)
  if (!manifest) {
    return false
  }

  return (
    hasApkUpdate(status.buildNumber, manifest) ||
    hasMtkUpdate(manifest.mtk_patches, status.mtkFirmwareVersion) ||
    hasBesUpdate(manifest.bes_firmware, status.besFirmwareVersion)
  )
}

export async function startOtaUpdate(): Promise<OtaStartAckEvent> {
  const status = await getFreshGlassesStatus()
  const otaVersionUrl = resolveOtaVersionUrl(status)
  return PrivateBluetoothSdkModule.sendOtaStart(otaVersionUrl)
}

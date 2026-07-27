import * as RNFS from "@dr.pogodin/react-native-fs"

import BluetoothSdk from "@mentra/bluetooth-sdk"
import {getAr99ApiConfig} from "@/services/ar99ApiConfig"

const AR99_OTA_APP_NAME = "AR99"
const AR99_OTA_APP_TYPE = "juxinOTA"
const AR99_OTA_DIR = `${RNFS.CachesDirectoryPath}/ar99_ota`
const AR99_OTA_HEADERS = {"Accept-Language": "en-US"}

export interface Ar99VersionInfo {
  changeLog: string
  currentVersion: string
  fileMd5: string
  firmwareUrl: string
  forceUpdate: boolean
  hasUpdate: boolean
}

interface VersionResponseData {
  change_log?: string
  current_version?: string
  force_update?: boolean
  md5?: string
  url?: string
}

interface ApiResponse {
  code?: number
  msg?: string
  message?: string
  success?: boolean
  error?: {
    code?: number
    detail?: string
    status?: string
  }
  data?: VersionResponseData | null
}

export function getAr99OtaDir(): string {
  return AR99_OTA_DIR
}

export async function clearAr99OtaFiles(): Promise<void> {
  if (await RNFS.exists(AR99_OTA_DIR)) {
    await RNFS.unlink(AR99_OTA_DIR).catch(() => {})
  }
  await RNFS.mkdir(AR99_OTA_DIR)
}

export async function checkAr99OtaVersion(currentVersion: string, serialNumber: string, appName: string): Promise<Ar99VersionInfo> {
  const version = currentVersion.trim()
  const scope = serialNumber.trim()
  const nonce = Math.floor(Math.random() * 2147483647).toString()
  const config = getAr99ApiConfig()
  const otaAppName = appName.trim() || AR99_OTA_APP_NAME
  const versionUrl = `${config.baseUrl}api/v2/applications/public/getVersionURL`
  const md5 = BluetoothSdk.buildAr99OtaSignature(config.clientKey, otaAppName, version, scope, nonce)

  const body = {
    app_name: otaAppName,
    app_type: AR99_OTA_APP_TYPE,
    current_version: version,
    developerId: config.developerId,
    target_scope: scope,
    nonce,
    md5,
  }

  const response = await fetch(versionUrl, {
    method: "POST",
    headers: {...AR99_OTA_HEADERS, "Content-Type": "application/json"},
    body: JSON.stringify(body),
  })

  const payload = (await response.json().catch(() => null)) as ApiResponse | null
  if (response.status === 553 || payload?.code === 553 || payload?.error?.code === 553) {
    return emptyVersionInfo(version)
  }

  const success = payload?.success === true || payload?.code === 0 || payload?.code === 200
  if (!response.ok || !payload || !success) {
    const message = payload?.error?.detail || payload?.msg || payload?.message || `Version check failed: ${response.status}`
    throw new Error(message)
  }

  const data = payload.data ?? {}
  const latest = data.current_version?.trim() ?? ""
  const url = data.url?.trim() ?? ""
  return {
    changeLog: data.change_log ?? "",
    currentVersion: latest,
    fileMd5: data.md5?.trim().toLowerCase() ?? "",
    firmwareUrl: resolveFirmwareUrl(url),
    forceUpdate: data.force_update === true,
    hasUpdate: url.length > 0 && latest.length > 0 && latest !== version,
  }
}

export async function downloadAr99Firmware(
  firmwareUrl: string,
  latestVersion: string,
  expectedMd5: string,
  onProgress: (progress: number) => void,
): Promise<string> {
  await clearAr99OtaFiles()
  const safeVersion = latestVersion.replace(/[^a-zA-Z0-9._-]/g, "_") || "latest"
  const filePath = `${AR99_OTA_DIR}/ar99_juxin_${safeVersion}_${Date.now()}.bin`
  const {promise} = RNFS.downloadFile({
    fromUrl: firmwareUrl,
    toFile: filePath,
    headers: AR99_OTA_HEADERS,
    progressDivider: 1,
    progress: (event) => {
      if (event.contentLength > 0) {
        onProgress(Math.max(0, Math.min(100, Math.floor((event.bytesWritten * 100) / event.contentLength))))
      }
    },
  })

  const result = await promise
  if (result.statusCode < 200 || result.statusCode >= 300) {
    throw new Error(`Firmware download failed: ${result.statusCode}`)
  }

  if (expectedMd5) {
    const actualMd5 = (await RNFS.hash(filePath, "md5")).toLowerCase()
    if (actualMd5 !== expectedMd5.toLowerCase()) {
      await RNFS.unlink(filePath).catch(() => {})
      throw new Error("Firmware md5 check failed")
    }
  }

  return filePath
}

function emptyVersionInfo(currentVersion: string): Ar99VersionInfo {
  return {
    changeLog: "",
    currentVersion,
    fileMd5: "",
    firmwareUrl: "",
    forceUpdate: false,
    hasUpdate: false,
  }
}

function resolveFirmwareUrl(url: string): string {
  if (!url) return ""
  if (/^https?:\/\//i.test(url)) return url
  return new URL(url.replace(/^\/+/, ""), getAr99ApiConfig().baseUrl).toString()
}
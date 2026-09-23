import * as RNFS from "@dr.pogodin/react-native-fs"
import {otaServer} from "@mentra/bluetooth-sdk/ota-transport"

import {validateFirmwarePin, type FirmwareManifestPin} from "./sourcePolicy"

export interface FirmwareArtifactDescriptor {
  readonly url: string
  readonly size?: number
  readonly sha256?: string
  readonly md5?: string
}

export interface StagedFirmwareArtifact {
  readonly path: string
  /** Releases only this caller's staging directory; never another transaction's cache. */
  release(): Promise<void>
}

let nextStagingId = 0

/** Native background download, scoped staging, then verification before exposing the immutable descriptor. */
export async function stageFirmwareArtifact(
  descriptor: FirmwareArtifactDescriptor,
  progress: (percent: number | null) => void = () => {},
): Promise<StagedFirmwareArtifact> {
  const url = new URL(descriptor.url)
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.hash)
    throw new Error("Invalid firmware artifact URL")
  // AR99's existing vendor service may omit integrity/size. NIMO's parser always requires both.
  if (descriptor.sha256 && !/^[0-9a-f]{64}$/.test(descriptor.sha256)) throw new Error("Invalid SHA-256 digest")
  if (descriptor.md5 && !/^[0-9a-fA-F]{32}$/.test(descriptor.md5)) throw new Error("Invalid MD5 digest")
  const directory = `${RNFS.DocumentDirectoryPath}/firmware_staging/${Date.now()}-${++nextStagingId}-${Math.random()
    .toString(36)
    .slice(2)}`
  const partial = `${directory}/image.part`
  const path = `${directory}/image.bin`
  await RNFS.mkdir(directory, {NSURLIsExcludedFromBackupKey: true})
  const release = async () => {
    if (await RNFS.exists(directory)) await RNFS.unlink(directory)
  }
  const subscription = otaServer.onArtifactDownloadProgress((event) => {
    if (event.destination !== partial) return
    progress(
      event.contentLength > 0 ? Math.min(100, Math.max(0, (event.bytesWritten / event.contentLength) * 100)) : null,
    )
  })
  try {
    const downloaded = await otaServer.downloadArtifact(url.toString(), partial)
    if (downloaded.statusCode < 200 || downloaded.statusCode >= 300) throw new Error("Firmware download failed")
    const stat = await RNFS.stat(partial)
    if (Number(stat.size) < 1 || (descriptor.size !== undefined && Number(stat.size) !== descriptor.size))
      throw new Error("Firmware download size does not match the approved artifact")
    if (descriptor.sha256 && (await RNFS.hash(partial, "sha256")).toLowerCase() !== descriptor.sha256)
      throw new Error("Firmware SHA-256 verification failed")
    if (descriptor.md5 && (await RNFS.hash(partial, "md5")).toLowerCase() !== descriptor.md5.toLowerCase())
      throw new Error("Firmware MD5 verification failed")
    await RNFS.moveFile(partial, path)
    return {path, release}
  } catch (error) {
    await release().catch(() => {})
    throw error
  } finally {
    subscription.remove()
  }
}

/** Verify raw downloaded bytes before JSON parsing; never authenticate a re-serialized manifest. */
export async function fetchPinnedFirmwareManifest(pin: FirmwareManifestPin): Promise<unknown> {
  const selected = validateFirmwarePin(pin)
  const file = await stageFirmwareArtifact(selected)
  try {
    const stat = await RNFS.stat(file.path)
    if (Number(stat.size) > 256 * 1024) throw new Error("Firmware manifest is too large")
    return JSON.parse(await RNFS.readFile(file.path, "utf8")) as unknown
  } finally {
    await file.release()
  }
}

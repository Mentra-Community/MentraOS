import {holdGlassesWifiIfUp} from "./GlassesWifi"
import {localNetworkTransport} from "./asg/localNetworkTransport"

/** The glasses' file server: the camera server gallery sync uses. */
const GLASSES_FILE_SERVER_PORT = 8089

/**
 * A file the glasses keep for the phone (a deferred photo), as a file in this app's cache folder.
 * It comes over the glasses Wi-Fi link when that link is up, held for the fetch's duration so it
 * isn't taken down underneath it; else, or when that fails, `overBluetooth` gets it.
 */
export async function fetchGlassesFile(fileId: string, overBluetooth: () => Promise<string>): Promise<string> {
  const hold = await holdGlassesWifiIfUp(`file ${fileId}`)
  if (!hold) return overBluetooth()
  try {
    const {File, Paths} = require("expo-file-system") as typeof import("expo-file-system")
    const file = new File(Paths.cache, `glasses-file-${fileId}`)
    const {statusCode} = await localNetworkTransport.downloadFile({
      fromUrl: `http://${hold.binding.gateway}:${GLASSES_FILE_SERVER_PORT}/api/deferred?id=${encodeURIComponent(fileId)}`,
      toFile: decodeURIComponent(new URL(file.uri).pathname),
      connectionTimeout: 10_000,
      readTimeout: 30_000,
    }).promise
    if (statusCode === 200) return file.uri
    if (file.exists) file.delete()
    throw new Error(`the glasses answered ${statusCode}`)
  } catch (err) {
    console.warn(`[GlassesFiles] ${fileId} over Wi-Fi failed; using Bluetooth:`, err)
    return overBluetooth()
  } finally {
    await hold.release()
  }
}

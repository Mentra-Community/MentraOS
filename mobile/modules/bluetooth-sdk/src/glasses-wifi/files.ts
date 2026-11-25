import {downloadToCache} from "./native"
import {holdGlassesWifiIfUp} from "./service"

/** The glasses' file server: the camera server gallery sync uses. */
const GLASSES_FILE_SERVER_PORT = 8089

/**
 * A file the glasses keep for the phone (a deferred photo), fetched over the glasses Wi-Fi link
 * into this app's cache folder when that link is up, held for the fetch's duration so it isn't
 * taken down underneath it. Null when the link is down or the fetch failed: the caller then asks
 * for it over Bluetooth.
 */
export async function fetchGlassesFileOverWifi(fileId: string): Promise<{uri: string; bytes: number} | null> {
  const hold = await holdGlassesWifiIfUp(`file ${fileId}`)
  if (!hold) return null
  try {
    const url = `http://${hold.binding.gateway}:${GLASSES_FILE_SERVER_PORT}/api/deferred?id=${encodeURIComponent(
      fileId,
    )}`
    const {statusCode, uri, bytes} = await downloadToCache(url, `glasses-file-${fileId.replace(/[^\w.-]/g, "_")}`, {
      connectionMs: 10_000,
      readMs: 30_000,
    })
    if (statusCode === 200) return {uri, bytes}
    throw new Error(`the glasses answered ${statusCode}`)
  } catch (err) {
    console.warn(`[GlassesFiles] ${fileId} over Wi-Fi failed; using Bluetooth:`, err)
    return null
  } finally {
    await hold.release()
  }
}

import {Platform} from "react-native"

// The service is this module's only caller; it reaches the native joins through it.
// eslint-disable-next-line no-restricted-imports
import MentraLocalNetwork from "../_private/MentraLocalNetworkModule"

/**
 * The phone's native joins to the glasses' Wi-Fi, under the glasses Wi-Fi service: one link at a
 * time. Android joins the hotspot or the Wi-Fi Direct group through `ScopedSoftApNetwork` and
 * sends requests over the `Network` it gets; iOS joins the hotspot through `GlassesHotspotNetwork`
 * and its requests take the system's route to it.
 */

export type JoinPurpose = "outgoing-client" | "incoming-server"

let generation = 0
/** Android: requests go over the joined `Network`, not the default one. */
let scoped = false
/** iOS: the native join's owner id, while joined or joining. */
let iosOwner: string | null = null

const native = () => {
  if (!MentraLocalNetwork) throw new Error("The glasses Wi-Fi link is not available in this native build")
  return MentraLocalNetwork
}

const requestId = (prefix: string) => `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2)}`

/** Android: whether the phone and the connected glasses can use the Wi-Fi Direct link now. Right after a connection
 * it waits for the glasses to say what they support. */
export async function wifiDirectAvailable(): Promise<boolean> {
  return Platform.OS === "android" && (await MentraLocalNetwork?.wifiDirectAvailable?.()) === true
}

/** Join the glasses' hotspot. Resolves with the phone's address on it, when the platform reports it. */
export async function joinHotspot(
  ssid: string,
  password: string,
  options: {
    gateway?: string
    /** The hotspot's channel in MHz, when the glasses report it: a Mac then scans only that channel. */
    frequency?: number
    purpose: JoinPurpose
    /** iOS: the join has waited a few seconds for Local Network access, which may have been denied. */
    onPermissionRequired?: (systemAnswer: string) => void
  },
): Promise<string | undefined> {
  const current = ++generation
  scoped = false
  if (Platform.OS === "ios") {
    if (iosOwner) throw new Error("Previous hotspot session has not been released")
    const owner = requestId("ios_hotspot")
    iosOwner = owner
    const permission = native().addListener("hotspotPermissionRequired", (event) => {
      if (event.id === owner) options.onPermissionRequired?.(event.systemAnswer ?? "unknown")
    })
    try {
      const address = await native().joinHotspot(
        owner,
        ssid,
        password,
        options.gateway ?? null,
        options.purpose,
        options.frequency ?? null,
      )
      if (current !== generation) throw new Error("Local network connection was superseded")
      return address
    } catch (error) {
      try {
        await native().leaveHotspot(owner)
      } catch (cleanupError) {
        // The owner stays recorded: the next join must not start over a session still being left.
        console.warn("[GlassesWifi] Leaving a failed hotspot join failed", cleanupError)
        throw error
      }
      if (iosOwner === owner) iosOwner = null
      throw error
    } finally {
      permission.remove()
    }
  }
  if (Platform.OS !== "android") throw new Error("The glasses hotspot cannot be joined on this platform")
  const result = await native().connect(ssid, password, options.purpose === "incoming-server")
  scoped = true
  return result.localAddress
}

/** Android: join the glasses' Wi-Fi Direct group; the native join asks the glasses for it over Bluetooth. */
export async function joinWifiDirect(
  purpose: JoinPurpose,
): Promise<{ssid: string; localAddress?: string; gateway?: string}> {
  generation += 1
  scoped = false
  const result = await native().connectWifiDirect(purpose === "incoming-server")
  scoped = true
  return result
}

/** Leave whatever the phone joined, or stop a join in progress. Leaving a group also removes it. */
export async function leave(): Promise<void> {
  generation += 1
  if (!MentraLocalNetwork) return
  if (Platform.OS === "ios") {
    const owner = iosOwner
    if (!owner) return
    await MentraLocalNetwork.leaveHotspot(owner)
    if (iosOwner === owner) iosOwner = null
    return
  }
  // A failed release keeps the network for the next leave.
  await MentraLocalNetwork.disconnect()
  scoped = false
}

/** The phone left the glasses' network without being asked to. */
export function onLost(listener: () => void): () => void {
  if (!MentraLocalNetwork) return () => {}
  const subscription =
    Platform.OS === "ios"
      ? MentraLocalNetwork.addListener("hotspotLost", (event) => {
          if (event.id === iosOwner) listener()
        })
      : MentraLocalNetwork.addListener("networkLost", () => {
          scoped = false
          listener()
        })
  return () => subscription.remove()
}

/** Android: requests to the glasses must go over the joined `Network` (`MentraLocalNetwork.request`). */
export function isScoped(): boolean {
  return scoped
}

/** Android: an HTTP request to the glasses over the joined `Network`; the body comes back as base64. */
export function request(
  requestId: string,
  url: string,
  method: string,
  headers: Record<string, string>,
  body: string | null,
  timeoutMs: number,
): Promise<{status: number; headers: Record<string, string>; bodyBase64: string}> {
  return native().request(requestId, url, method, headers, body, timeoutMs)
}

/** A download from the glasses over the link into `destination`, a path; progress comes by `onDownloadProgress`. */
export function download(
  requestId: string,
  url: string,
  destination: string,
  headers: Record<string, string>,
  connectionTimeoutMs: number,
  readTimeoutMs: number,
): Promise<{statusCode: number; bytesWritten: number; headers: Record<string, string>}> {
  return native().download(requestId, url, destination, headers, connectionTimeoutMs, readTimeoutMs)
}

/** Stop a request or download in progress. */
export async function cancel(requestId: string): Promise<void> {
  await MentraLocalNetwork?.cancel(requestId)
}

export function onDownloadProgress(
  listener: (event: {
    requestId: string
    bytesWritten: number
    contentLength: number
    statusCode?: number
    headers?: Record<string, string>
  }) => void,
): () => void {
  if (!MentraLocalNetwork) return () => {}
  const subscription = MentraLocalNetwork.addListener("downloadProgress", listener)
  return () => subscription.remove()
}

/** Download a file from the glasses over the link into this app's cache folder, as a `file://` URI. */
export async function downloadToCache(
  url: string,
  fileName: string,
  timeouts: {connectionMs: number; readMs: number},
): Promise<{statusCode: number; uri: string; bytes: number}> {
  const path = `${native().cacheDirectory().replace(/\/$/, "")}/${fileName}`
  const {statusCode, bytesWritten} = await download(requestId("file"), url, path, {}, timeouts.connectionMs, timeouts.readMs)
  return {statusCode, uri: `file://${path}`, bytes: bytesWritten}
}

/** A wait that keeps running while the app is in the background, unlike a JS timer on Android. */
export function delay(ms: number): Promise<void> {
  const nativeDelay = MentraLocalNetwork?.delay
  if (typeof nativeDelay === "function") return nativeDelay.call(MentraLocalNetwork, Math.max(0, Math.round(ms)))
  return new Promise((resolve) => setTimeout(resolve, ms))
}

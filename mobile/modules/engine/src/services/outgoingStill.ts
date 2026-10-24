import {Buffer} from "buffer"

import {isNetworkUrl, urlScheme} from "./miniappPaths"

/** A still shared into a meeting tile. Larger files are a download, not a video frame. */
const MAX_STILL_BYTES = 8 * 1024 * 1024

/**
 * Whether this package may put a card or still on the outgoing tile.
 * Idle, disconnected, and error are already over; a pause must not outlive them.
 */
export function meetingCanSharePhoto(input: {
  owner: string | null
  packageName: string
  released: boolean
  phase: string
}): boolean {
  if (input.released || input.owner !== input.packageName) return false
  return input.phase === "connecting" || input.phase === "lobby" || input.phase === "connected"
}

/**
 * Bytes of a photo URL, as base64 for the native frame sender. Data URLs are not
 * fetched. Anything else must be an http: or https: URL: the host's fetch reads
 * file: URLs on iOS, and these bytes go out to the meeting.
 */
export async function loadOutgoingStill(imageUrl: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  if (urlScheme(imageUrl) === "data") {
    const comma = imageUrl.indexOf(",")
    if (comma < 0 || comma === imageUrl.length - 1) throw new Error("The photo could not be read")
    return imageUrl.slice(comma + 1)
  }
  if (!isNetworkUrl(imageUrl)) throw new Error("The photo must be an http(s) or data: URL")
  const response = await fetchImpl(imageUrl, {signal: AbortSignal.timeout(15_000)})
  if (!response.ok) throw new Error(`The photo could not be loaded (${response.status})`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength === 0) throw new Error("The photo could not be read")
  if (bytes.byteLength > MAX_STILL_BYTES) throw new Error("The photo is too large to share")
  return Buffer.from(bytes).toString("base64")
}

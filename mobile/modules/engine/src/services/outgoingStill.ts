import {Buffer} from "buffer"

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

/** Bytes of a photo URL, as base64 for the native frame sender. Data URLs are not fetched. */
export async function loadOutgoingStill(imageUrl: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  if (imageUrl.startsWith("data:")) {
    const comma = imageUrl.indexOf(",")
    if (comma < 0 || comma === imageUrl.length - 1) throw new Error("The photo could not be read")
    return imageUrl.slice(comma + 1)
  }
  const response = await fetchImpl(imageUrl, {signal: AbortSignal.timeout(15_000)})
  if (!response.ok) throw new Error(`The photo could not be loaded (${response.status})`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength === 0) throw new Error("The photo could not be read")
  if (bytes.byteLength > MAX_STILL_BYTES) throw new Error("The photo is too large to share")
  return Buffer.from(bytes).toString("base64")
}

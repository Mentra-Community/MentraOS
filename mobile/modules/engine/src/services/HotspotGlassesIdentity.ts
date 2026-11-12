import {BgTimer} from "../utils/timers"
import {localNetworkTransport} from "./asg/localNetworkTransport"

/** What the glasses answering on the joined hotspot say about who they are. */
export type JoinedGlassesIdentity = "same_glasses" | "other_glasses" | "unknown"

/** How long the glasses get to answer: they answer in milliseconds once the hotspot carries traffic. */
const HEALTH_TIMEOUT_MS = 5_000

/**
 * Compare the serial the glasses on the joined hotspot report with the one the Bluetooth-connected
 * pair reported. Every pair's hotspot shares one gateway address, so only the serial tells them apart.
 * Glasses software from before `/api/health` carried `serial_number`, a pair whose serial is unknown,
 * or a probe that cannot complete all answer "unknown": the update then goes ahead as it always has,
 * since only the Bluetooth-connected glasses are told where to download it.
 */
export async function joinedGlassesIdentity(gateway: string, bluetoothSerial: string | null): Promise<JoinedGlassesIdentity> {
  if (!bluetoothSerial) return "unknown"
  const reported = await reportedSerial(gateway)
  if (reported === null) return "unknown"
  return reported === bluetoothSerial ? "same_glasses" : "other_glasses"
}

/**
 * The serial on the joined hotspot, or null. One deadline covers the request and its body on every
 * platform: iPhone and Mac use the system fetch, which has no deadline of its own, and an unanswered
 * probe must not hold up the update or its cleanup.
 */
async function reportedSerial(gateway: string): Promise<string | null> {
  const controller = new AbortController()
  let timer: number | undefined
  const deadline = new Promise<null>((resolve) => {
    timer = BgTimer.setTimeout(() => {
      controller.abort()
      resolve(null)
    }, HEALTH_TIMEOUT_MS)
  })
  const probe = (async () => {
    const url = `http://${gateway}:8089/api/health`
    const response = await localNetworkTransport.fetch(url, {signal: controller.signal}, HEALTH_TIMEOUT_MS)
    if (!response.ok) return null
    const serial = ((await response.json()) as {serial_number?: unknown})?.serial_number
    return typeof serial === "string" && serial.trim() ? serial.trim() : null
  })().catch((error) => {
    if (!controller.signal.aborted) console.warn("[OTA_PROGRESS] could not ask the joined glasses who they are", error)
    return null
  })
  try {
    return await Promise.race([probe, deadline])
  } finally {
    if (timer !== undefined) BgTimer.clearTimeout(timer)
  }
}

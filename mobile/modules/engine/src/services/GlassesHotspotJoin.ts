import BluetoothSdk from "@mentra/bluetooth-sdk"

import {BgTimer} from "../utils/timers"
import {hotspotAcquisitions, hotspotOwned} from "./GlassesHotspotLease"

/**
 * How often an enable is re-sent while a join waits. The glasses stop an AP that no client has
 * used for 120 s (ASG `HOTSPOT_INACTIVITY_TIMEOUT_MS`), counted from its start.
 */
export const JOIN_KEEPALIVE_MS = 30_000

/**
 * Keep the glasses hotspot up for as long as `join` waits: the join has no time limit, so a person
 * can take as long as they like to answer the phone's join prompt. A repeated enable restarts the
 * glasses' idle clock (ASG 3.3 and later).
 *
 * The join ends on what the phone can see: it joins, the person declines (native), the owner
 * cancels it, or `hotspot.cancel` runs here when the glasses leave BLE or answer an enable with
 * the AP off. Nothing is sent once the join settles or the AP has a new owner.
 */
export async function keepHotspotUpWhileJoining<T>(
  join: Promise<T>,
  hotspot: {enable: () => Promise<{state: string}>; cancel: () => unknown},
): Promise<T> {
  const holder = hotspotAcquisitions()
  let joining = true
  const current = () => joining && hotspotOwned() && hotspotAcquisitions() === holder
  const end = (reason: string) => {
    if (!current()) return
    joining = false
    console.warn(`[GlassesHotspot] Ending the hotspot join: ${reason}`)
    hotspot.cancel()
  }
  const unsubscribe = BluetoothSdk.subscribeGlassesStatus((changed) => {
    if (changed.connection?.state === "disconnected") end("the glasses disconnected")
  })
  const timer = BgTimer.setInterval(() => {
    if (!current()) return
    hotspot.enable().then(
      (status) => {
        if (status.state !== "enabled") end(`the glasses report their hotspot ${status.state}`)
      },
      (error) => console.warn("[GlassesHotspot] Keeping the hotspot up during the join failed", error),
    )
  }, JOIN_KEEPALIVE_MS)
  try {
    return await join
  } finally {
    joining = false
    BgTimer.clearInterval(timer)
    unsubscribe()
  }
}

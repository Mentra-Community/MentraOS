/**
 * GlassesReadiness — the canonical connection predicates plus a wait-for-booted
 * primitive.
 *
 * The predicates ("connected / booted / busy") are the single app-facing home
 * for connection readiness: the app, the Connection coordinator, and the
 * Pairing coordinator all read them through engine rather than re-deriving the
 * same checks in three places. They are defined here over the btsdk
 * `GlassesConnectionStatus` type through the public Bluetooth SDK package
 * boundary.
 *
 * waitForGlassesReady is the new primitive those coordinators build on:
 * "resolve once the glasses report fully booted, or false on timeout". It is
 * host-store-agnostic — callers inject a snapshot getter + a subscribe fn — so
 * it is unit-testable without a live device.
 */
import {
  isBusyGlassesConnectionStatus,
  isConnectedGlassesConnectionStatus,
  isReadyGlassesConnectionStatus,
  type GlassesConnectionStatus,
} from "@mentra/bluetooth-sdk/types"

import {BgTimer} from "../utils/timers"

export type {GlassesConnectionStatus}

/** True when the BLE link is established (regardless of boot state). */
export function isGlassesConnected(connection: GlassesConnectionStatus): boolean {
  return isConnectedGlassesConnectionStatus(connection)
}

/** True when connected AND the glasses OS has finished booting. */
export function isGlassesReady(connection: GlassesConnectionStatus): boolean {
  return isReadyGlassesConnectionStatus(connection)
}

/** True while the native link layer is mid scan / connect / bond. */
export function isGlassesLinkLayerBusy(connection: GlassesConnectionStatus): boolean {
  return isBusyGlassesConnectionStatus(connection)
}

export interface WaitForGlassesReadyOptions {
  /** Current connection snapshot. */
  getConnection: () => GlassesConnectionStatus
  /** Subscribe to connection changes; returns an unsubscribe fn. */
  subscribe: (listener: (connection: GlassesConnectionStatus) => void) => () => void
  /** Resolve false after this many ms if still not ready. Default 35s — the pairing boot budget. */
  timeoutMs?: number
  /** Abort the wait early (e.g. the screen unmounted). Tears down the subscription + timer; resolves false. */
  signal?: AbortSignal
}

/**
 * Resolves true once the glasses report fully booted, false on timeout, or
 * false if the optional signal aborts. Resolves immediately when already ready.
 * Always tears down its subscription, timer, and abort listener before resolving.
 */
export function waitForGlassesReady(options: WaitForGlassesReadyOptions): Promise<boolean> {
  const {getConnection, subscribe, timeoutMs = 35_000, signal} = options
  return new Promise<boolean>((resolve) => {
    if (signal?.aborted) {
      resolve(false)
      return
    }
    if (isGlassesReady(getConnection())) {
      resolve(true)
      return
    }

    let settled = false
    let timer: number | null = null
    let unsubscribe: (() => void) | null = null
    let onAbort: (() => void) | null = null

    const finish = (value: boolean) => {
      if (settled) return
      settled = true
      if (unsubscribe) unsubscribe()
      if (timer !== null) BgTimer.clearTimeout(timer)
      if (onAbort && signal) signal.removeEventListener("abort", onAbort)
      resolve(value)
    }

    if (signal) {
      onAbort = () => finish(false)
      signal.addEventListener("abort", onAbort)
    }

    unsubscribe = subscribe((connection) => {
      if (isGlassesReady(connection)) finish(true)
    })

    if (settled) {
      // subscribe() notified synchronously with a ready state, so finish() ran
      // before unsubscribe was assigned and couldn't tear the subscription down.
      // Do it now (and don't arm a timer).
      unsubscribe()
    } else {
      timer = BgTimer.setTimeout(() => finish(isGlassesReady(getConnection())), timeoutMs)
    }
  })
}

import {isConnectedGlassesConnectionStatus} from "../BluetoothSdk.types"
import {glassesConnection, onGlassesConnection, watchGlassesConnection} from "./connection"
import {glassesWifiUp, holdGlassesWifi, onGlassesWifiUp, type GlassesWifiHold} from "./service"

/**
 * The phone's links to the glasses, as the Bluetooth SDK's and the Miniapp SDK's `link` show them:
 * the glasses connected over Bluetooth or not, and the fast link (the glasses Wi-Fi) up or down.
 * Photos go over the fast link while it is up, whoever holds it, and over Bluetooth otherwise.
 */
export type LinkState = {glasses: "connected" | "disconnected"; fast: "up" | "down"}

export interface GlassesLink {
  /** The links as they are now. */
  readonly state: LinkState
  /** Hear the links change; the handler gets the new state. */
  onChange(handler: (state: LinkState) => void): () => void
  /**
   * Hold the fast link, so photos travel over it instead of Bluetooth, until {@link closeFast}.
   * The SDK picks the radio (Wi-Fi Direct on Android with glasses that support it, the glasses'
   * hotspot otherwise), shares the one link with its other users and brings it back after the
   * glasses restart. Resolves once it is up; rejects if it can't come up. Opening a link already
   * held waits for the same one.
   */
  openFast(): Promise<void>
  /** Give the fast link back; it goes down once nobody else holds it. Idempotent. */
  closeFast(): Promise<void>
}

export function linkState(): LinkState {
  return {
    glasses: isConnectedGlassesConnectionStatus(glassesConnection()) ? "connected" : "disconnected",
    fast: glassesWifiUp() ? "up" : "down",
  }
}

/** Hear either link change, with the new state; only real changes are heard. */
export function onLinkChange(handler: (state: LinkState) => void): () => void {
  let last = linkState()
  const check = () => {
    const next = linkState()
    if (next.glasses === last.glasses && next.fast === last.fast) return
    last = next
    handler(next)
  }
  const stopConnection = onGlassesConnection(check)
  const stopWifi = onGlassesWifiUp(check)
  return () => {
    stopConnection()
    stopWifi()
  }
}

/** One holder of the fast link: the app's own, or one per miniapp. */
export function createLink(consumer: string): GlassesLink {
  let current: {abort: AbortController; hold: Promise<GlassesWifiHold>} | null = null
  const closeFast = async () => {
    const entry = current
    if (!entry) return
    current = null
    entry.abort.abort()
    await entry.hold.then((hold) => hold.release()).catch(() => undefined)
  }
  return {
    get state() {
      // Watched from the first read on: until the glasses status arrives, they show as disconnected.
      void watchGlassesConnection()
      return linkState()
    },
    onChange: onLinkChange,
    async openFast() {
      let entry = current
      if (!entry) {
        const abort = new AbortController()
        const opened = {abort, hold: holdGlassesWifi({consumer, signal: abort.signal})}
        current = entry = opened
        // A link the glasses did not bring back is given back, so the next open asks again.
        void opened.hold
          .then((hold) =>
            hold.onChange((event) => {
              if (event.type === "ended" && current === opened) void closeFast()
            }),
          )
          .catch(() => undefined)
      }
      try {
        await (await entry.hold).ready()
      } catch (error) {
        if (current === entry) await closeFast()
        throw error
      }
    },
    closeFast,
  }
}

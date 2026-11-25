import {createLink} from "./link"
import {delay} from "./native"

/**
 * A camera session: the glasses camera opened for a stretch of work (documenting a job, a
 * walk-through), the same in the Bluetooth SDK (`BluetoothSdk.openCamera`) and the Mentra Miniapp
 * SDK (`camera.open`), which the Mentra App runs with this. From open to close the session holds
 * the glasses fast link, so full photos come over Wi-Fi, and keeps the camera warm, so each photo
 * is taken at once. Every photo goes through the session the same way, one at a time; the only
 * thing that differs is what asks for it:
 *
 * - `capture(options)`: one photo, for a person's tap or voice, taken in the session's turn.
 * - `continuous(options)`: photos back to back on their own, as fast as the camera takes them,
 *   until the trigger stops. An internal guard, which callers neither set nor see, holds it while
 *   the fast link is down or while {@link PENDING_GUARD} of the session's photos are still on the
 *   glasses (handed out and not released), so photos never pile up there behind Bluetooth.
 *
 * `close()` stops taking photos and gives the link and the camera back once every photo the
 * session handed out is released, so photos still on their way keep coming over Wi-Fi.
 */

/** How many of a session's photos may stay on the glasses before its continuous trigger waits. */
export const PENDING_GUARD = 12
/** How long a session waits before asking again for a fast link that could not come up. */
const LINK_RETRY_MS = 30_000

/** A session's continuous trigger: photos back to back until `stop()` or the session closes. */
export interface ContinuousCapture<C> {
  /** Each photo it takes, a capture like the session's `capture`; release it when done. */
  onPhoto(handler: (capture: C) => void): () => void
  /** Stop taking photos on their own. The session stays open: its link, camera and photos stay. Idempotent. */
  stop(): void
}

export interface CameraSession<C> {
  /** One photo with these options (over the session's), taken in the session's turn; resolves once it is started. */
  capture(options?: object): Promise<C>
  /**
   * Take photos back to back on their own, with these options (over the session's), until the
   * trigger is stopped or the session closes. One at a time: starting another stops this one.
   */
  continuous(options?: object): ContinuousCapture<C>
  /**
   * Stop taking photos. The fast link and the warm camera are given back once every photo the
   * session handed out is released; resolves then. Idempotent.
   */
  close(): Promise<void>
}

/** A warm camera the session holds while open, released at close. */
export type HoldWarm = () => Promise<{release(): Promise<void>}>

interface Trigger<O, C> {
  options: O
  stopped: boolean
  photoHandlers: Set<(capture: C) => void>
}

/**
 * A session over `take`, which starts one capture with the given options and calls `released`
 * once that capture is released (the caller's `release()`, or the miniapp closing). `defaults` are
 * every photo's options; `warm`, when given, holds the camera warm while the session is open.
 */
export function openCameraSession<O extends object, C extends {readonly captured: Promise<void>}>(
  take: (options: O, released: () => void) => C,
  defaults: O,
  consumer: string,
  warm?: HoldWarm,
): CameraSession<C> {
  const link = createLink(consumer)
  const asked: Array<{options: O; resolve: (capture: C) => void; reject: (error: Error) => void}> = []
  let trigger: Trigger<O, C> | null = null
  let pending = 0
  let closed = false
  let wake = () => {}
  const drained: Array<() => void> = []

  const notify = <T>(handlers: Set<(value: T) => void>, value: T) => {
    for (const handler of handlers) {
      try {
        handler(value)
      } catch (error) {
        console.warn(`[CameraSession] ${consumer} failed handling an event`, error)
      }
    }
  }
  /** Whether the fast link is up, as last heard. */
  let linkUp = false
  /** The guard: the trigger takes photos while the fast link is up and the glasses have room. */
  const triggerTakes = () => !!trigger && linkUp && pending < PENDING_GUARD
  const setLink = (up: boolean) => {
    linkUp = up
    wake()
  }

  // The fast link, held from open to close.
  let holding = false
  const hold = async () => {
    if (holding) return
    holding = true
    try {
      while (!closed) {
        try {
          await link.openFast()
          setLink(link.state.fast === "up")
          return
        } catch (error) {
          console.warn(`[CameraSession] ${consumer}: the fast link did not come up; photos go over Bluetooth`, error)
          setLink(false)
          await delay(LINK_RETRY_MS)
        }
      }
    } finally {
      holding = false
    }
  }

  // The warm camera, held from open to close. A camera that could not warm (the glasses away) is
  // asked again when the glasses come back; once held, the hold itself re-arms it.
  let warmHeld: Promise<{release(): Promise<void>} | null> | null = null
  const holdWarm = () => {
    if (!warm || closed || warmHeld) return
    const attempt: Promise<{release(): Promise<void>} | null> = warm().catch((error) => {
      console.warn(`[CameraSession] ${consumer}: the camera did not warm; photos start cold`, error)
      if (warmHeld === attempt) warmHeld = null
      return null
    })
    warmHeld = attempt
  }

  // Glasses that come back after the link ended get asked again; while it is held, opening waits on it.
  const stopWatching = link.onChange((links) => {
    setLink(links.fast === "up")
    if (links.glasses === "connected" && links.fast === "down") void hold()
    if (links.glasses === "connected") holdWarm()
  })

  const loop = async () => {
    while (!closed) {
      const next = asked.shift()
      if (!next && !triggerTakes()) {
        await new Promise<void>((resolve) => (wake = resolve))
        continue
      }
      const auto = next ? null : trigger
      let settled = false
      const capture = take(next?.options ?? auto!.options, () => {
        if (settled) return
        settled = true
        pending--
        wake()
        if (pending === 0) drained.splice(0).forEach((resolve) => resolve())
      })
      pending++
      if (next) next.resolve(capture)
      else notify(auto!.photoHandlers, capture)
      // A capture the glasses refused leaves the camera free at once: wait a little before the next.
      await capture.captured.catch(() => delay(500))
    }
  }

  holdWarm()
  void hold()
  void loop()

  const stopTrigger = (current: Trigger<O, C>) => {
    current.stopped = true
    current.photoHandlers.clear()
    if (trigger === current) trigger = null
  }

  return {
    capture(extra = {}) {
      if (closed) return Promise.reject(new Error("The camera session was closed"))
      return new Promise<C>((resolve, reject) => {
        asked.push({options: {...defaults, ...extra} as O, resolve, reject})
        wake()
      })
    },
    continuous(options = {}) {
      if (closed) throw new Error("The camera session was closed")
      if (trigger) stopTrigger(trigger)
      const current: Trigger<O, C> = {
        options: {...defaults, ...options} as O,
        stopped: false,
        photoHandlers: new Set(),
      }
      trigger = current
      wake()
      return {
        onPhoto(handler) {
          current.photoHandlers.add(handler)
          return () => {
            current.photoHandlers.delete(handler)
          }
        },
        stop() {
          if (!current.stopped) stopTrigger(current)
        },
      }
    },
    async close() {
      if (!closed) {
        closed = true
        stopWatching()
        if (trigger) stopTrigger(trigger)
        for (const waiting of asked.splice(0)) waiting.reject(new Error("The camera session was closed"))
        wake()
      }
      if (pending > 0) await new Promise<void>((resolve) => drained.push(resolve))
      const held = await warmHeld
      warmHeld = null
      await held?.release().catch(() => undefined)
      await link.closeFast()
    },
  }
}

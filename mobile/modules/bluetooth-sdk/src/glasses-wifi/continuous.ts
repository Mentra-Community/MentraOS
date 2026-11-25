import {createLink} from "./link"
import {delay} from "./native"

/**
 * Continuous capture: photos back to back for as long as the run lasts, the same in the Bluetooth
 * SDK (`BluetoothSdk.captureContinuous`) and the Mentra Miniapp SDK (`camera.captureContinuous`),
 * which the Mentra App runs with this. While a run is on, the SDK holds the glasses fast link for
 * it, so full photos come over Wi-Fi; stopping gives the link back.
 *
 * The run takes one photo at a time: the next starts once the camera took the previous one. It
 * takes photos on its own while it is `capturing`: the fast link is up and fewer than `maxPending`
 * of its photos are still on the glasses (handed out and not released). Otherwise it is `paused`:
 * photos would pile up on the glasses, behind Bluetooth or behind the ones not released yet. Its
 * first state is heard once known. Photos asked for with `capture()` are taken in its turn either way.
 */

export type ContinuousState = "capturing" | "paused"

/** How many of a run's photos may stay on the glasses before it waits. */
export const DEFAULT_MAX_PENDING = 12
/** How long a run waits before asking again for a fast link that could not come up. */
const LINK_RETRY_MS = 30_000

export interface ContinuousCapture<C> {
  /** `capturing` while the run takes photos on its own, `paused` while only Bluetooth is left. */
  readonly state: ContinuousState
  /** Each photo the run takes on its own, a capture like `capturePhoto`'s; release it when done. */
  onPhoto(handler: (capture: C) => void): () => void
  onState(handler: (state: ContinuousState) => void): () => void
  /** One more photo, with these options, taken in the run's turn even while it is paused. */
  capture(options?: object): Promise<C>
  /**
   * Stop taking photos. The fast link is given back once every photo the run handed out is
   * released, so photos still on their way keep coming over Wi-Fi; resolves then.
   */
  stop(): Promise<void>
}

/**
 * A run over `take`, which starts one capture with the given options and calls `released` once
 * that capture is released (the caller's `release()`, or the miniapp closing).
 */
export function runContinuousCapture<O extends object, C extends {readonly captured: Promise<void>}>(
  take: (options: O, released: () => void) => C,
  options: O & {maxPending?: number},
  consumer: string,
): ContinuousCapture<C> {
  const {maxPending = DEFAULT_MAX_PENDING, ...photoOptions} = options
  const link = createLink(consumer)
  const photoHandlers = new Set<(capture: C) => void>()
  const stateHandlers = new Set<(state: ContinuousState) => void>()
  const asked: Array<{options: O; resolve: (capture: C) => void; reject: (error: Error) => void}> = []
  let state: ContinuousState = "paused"
  let pending = 0
  let stopped = false
  let wake = () => {}
  const drained: Array<() => void> = []

  const notify = <T>(handlers: Set<(value: T) => void>, value: T) => {
    for (const handler of handlers) {
      try {
        handler(value)
      } catch (error) {
        console.warn(`[ContinuousCapture] ${consumer} failed handling an event`, error)
      }
    }
  }
  /** The fast link's last known state; null until the first open settles or the link reports. */
  let linkUp: boolean | null = null
  let announced = false
  /** Capturing while the fast link is up and the glasses have room; the first known state is always heard. */
  const update = () => {
    if (stopped || linkUp === null) return
    const next: ContinuousState = linkUp && pending < maxPending ? "capturing" : "paused"
    if (next === state && announced) return
    state = next
    announced = true
    notify(stateHandlers, next)
    wake()
  }
  const setLink = (up: boolean) => {
    linkUp = up
    update()
  }

  let holding = false
  const hold = async () => {
    if (holding) return
    holding = true
    try {
      await holdUntilUp()
    } finally {
      holding = false
    }
  }
  // Glasses that come back after the link ended get asked again; while it is held, opening waits on it.
  const stopWatching = link.onChange((links) => {
    setLink(links.fast === "up")
    if (links.glasses === "connected" && links.fast === "down") void hold()
  })
  const holdUntilUp = async () => {
    while (!stopped) {
      try {
        await link.openFast()
        setLink(link.state.fast === "up")
        return
      } catch (error) {
        console.warn(`[ContinuousCapture] ${consumer}: the fast link did not come up; photos wait`, error)
        setLink(false)
        await delay(LINK_RETRY_MS)
      }
    }
  }

  const loop = async () => {
    while (!stopped) {
      const next = asked.shift()
      if (!next && state !== "capturing") {
        await new Promise<void>((resolve) => (wake = resolve))
        continue
      }
      let settled = false
      const capture = take(next?.options ?? (photoOptions as O), () => {
        if (settled) return
        settled = true
        pending--
        update()
        wake()
        if (pending === 0) drained.splice(0).forEach((resolve) => resolve())
      })
      pending++
      update()
      if (next) next.resolve(capture)
      else notify(photoHandlers, capture)
      // A capture the glasses refused leaves the camera free at once: wait a little before the next.
      await capture.captured.catch(() => delay(500))
    }
  }

  void hold()
  void loop()

  return {
    get state() {
      return state
    },
    onPhoto(handler) {
      photoHandlers.add(handler)
      return () => {
        photoHandlers.delete(handler)
      }
    },
    onState(handler) {
      stateHandlers.add(handler)
      return () => {
        stateHandlers.delete(handler)
      }
    },
    capture(extra = {}) {
      if (stopped) return Promise.reject(new Error("The continuous capture was stopped"))
      return new Promise<C>((resolve, reject) => {
        asked.push({options: {...(photoOptions as O), ...extra}, resolve, reject})
        wake()
      })
    },
    async stop() {
      if (!stopped) {
        stopped = true
        stopWatching()
        for (const waiting of asked.splice(0)) waiting.reject(new Error("The continuous capture was stopped"))
        wake()
      }
      if (pending > 0) await new Promise<void>((resolve) => drained.push(resolve))
      await link.closeFast()
    },
  }
}

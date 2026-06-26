/**
 * HeadingService
 *
 * Thin singleton over the native compass stream exposed by `crust`.
 * Works on both Android and iOS via CLLocationManager (iOS) / SensorManager (Android).
 *
 * Reference-counted: the underlying SensorManager subscription starts on
 * the first listener and stops when the last one unsubscribes. Late
 * subscribers get the most recently emitted heading replayed
 * synchronously so the UI doesn't have to wait for the next sensor tick.
 */

import CrustModule from "@mentra/crust"

const LOG_TAG = "HEADING_SERVICE"

export type HeadingListener = (degrees: number) => void

class HeadingService {
  private static instance: HeadingService | null = null
  private listeners = new Set<HeadingListener>()
  private nativeSub: {remove: () => void} | null = null
  private lastDegrees: number | null = null
  private nativeStarted = false

  private constructor() {}

  public static getInstance(): HeadingService {
    if (!HeadingService.instance) {
      HeadingService.instance = new HeadingService()
    }
    return HeadingService.instance
  }

  public addListener(listener: HeadingListener): () => void {
    this.listeners.add(listener)
    if (!this.nativeStarted) {
      this.startNative()
    }
    if (this.lastDegrees != null) {
      try {
        listener(this.lastDegrees)
      } catch (err) {
        console.error(`${LOG_TAG}: listener threw on replay`, err)
      }
    }
    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size === 0) {
        this.stopNative()
      }
    }
  }

  private async startNative(): Promise<void> {
    if (this.nativeStarted) return
    this.nativeStarted = true
    this.nativeSub = CrustModule.addListener("onHeading", (data) => {
      const deg = Number(data.degrees)
      if (!Number.isFinite(deg)) return
      this.lastDegrees = deg
      this.listeners.forEach((l) => {
        try {
          l(deg)
        } catch (err) {
          console.error(`${LOG_TAG}: listener threw`, err)
        }
      })
    })
    try {
      const result = await CrustModule.startHeading()
      if (!result.ok) {
        console.warn(`${LOG_TAG}: startHeading failed — ${result.error}`)
      } else {
        console.log(`${LOG_TAG}: started`)
      }
    } catch (err) {
      console.error(`${LOG_TAG}: startHeading threw`, err)
    }
  }

  private async stopNative(): Promise<void> {
    if (!this.nativeStarted) return
    this.nativeStarted = false
    this.nativeSub?.remove()
    this.nativeSub = null
    this.lastDegrees = null
    try {
      await CrustModule.stopHeading()
      console.log(`${LOG_TAG}: stopped`)
    } catch (err) {
      console.error(`${LOG_TAG}: stopHeading threw`, err)
    }
  }
}

const headingService = HeadingService.getInstance()
export default headingService

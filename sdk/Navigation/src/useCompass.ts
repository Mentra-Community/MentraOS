import {useCallback, useEffect, useRef, useState} from "react"

export type CompassStatus =
  | "idle"
  | "requesting"
  | "active"
  | "denied"
  | "no_events"
  | "no_alpha"
  | "unsupported"

export type Compass = {
  heading: number | null
  status: CompassStatus
  /** True if Android — call requestPermission() once on a user tap if status is "no_events" or "idle". */
  start: () => Promise<void>
}

/**
 * Returns the phone's compass heading + a status field so the UI can
 * render a "calibrate" button when needed.
 *
 * Android WebView quirks:
 *  - Plain HTTP (not HTTPS) origins MAY fire `deviceorientation` with
 *    `alpha=null`. We detect that and report "no_alpha" so the UI can
 *    explain it.
 *  - Some Android Chromium builds wait for the `deviceorientationabsolute`
 *    event before delivering magnetometer-fused values.
 *  - iOS 13+ requires `DeviceOrientationEvent.requestPermission()` from a
 *    user gesture. We expose a `start()` that handles this.
 */
export function useCompass(): Compass {
  const [heading, setHeading] = useState<number | null>(null)
  const [status, setStatus] = useState<CompassStatus>("idle")

  const eventCountRef = useRef(0)
  const alphaSeenRef = useRef(false)
  const noEventsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const handler = useCallback((e: DeviceOrientationEvent) => {
    eventCountRef.current += 1
    const iosHeading = (e as any).webkitCompassHeading as number | undefined
    let h: number | null = null
    if (typeof iosHeading === "number" && !Number.isNaN(iosHeading)) {
      h = iosHeading
    } else if (typeof e.alpha === "number" && !Number.isNaN(e.alpha)) {
      alphaSeenRef.current = true
      h = (360 - e.alpha) % 360
    }
    if (h != null) {
      setHeading(h)
      setStatus("active")
    }
  }, [])

  const attach = useCallback(() => {
    window.addEventListener("deviceorientation", handler)
    window.addEventListener("deviceorientationabsolute", handler as EventListener)
    if (noEventsTimerRef.current) clearTimeout(noEventsTimerRef.current)
    noEventsTimerRef.current = setTimeout(() => {
      if (eventCountRef.current === 0) {
        setStatus("no_events")
      } else if (!alphaSeenRef.current && heading == null) {
        setStatus("no_alpha")
      }
    }, 1500)
  }, [handler, heading])

  const start = useCallback(async () => {
    if (typeof window === "undefined") return
    setStatus("requesting")

    const ctor = (window as any).DeviceOrientationEvent
    if (!ctor) {
      setStatus("unsupported")
      return
    }

    // iOS 13+: must request permission inside a user gesture
    if (typeof ctor.requestPermission === "function") {
      try {
        const result: "granted" | "denied" = await ctor.requestPermission()
        if (result !== "granted") {
          setStatus("denied")
          return
        }
      } catch {
        setStatus("denied")
        return
      }
    }

    eventCountRef.current = 0
    alphaSeenRef.current = false
    attach()
  }, [attach])

  // On mount, just attach passively. On Android this often works without
  // a user gesture; on iOS it'll do nothing until start() is tapped.
  useEffect(() => {
    if (typeof window === "undefined") return
    if (typeof (window as any).DeviceOrientationEvent === "undefined") {
      setStatus("unsupported")
      return
    }
    attach()
    return () => {
      window.removeEventListener("deviceorientation", handler)
      window.removeEventListener("deviceorientationabsolute", handler as EventListener)
      if (noEventsTimerRef.current) clearTimeout(noEventsTimerRef.current)
    }
  }, [attach, handler])

  return {heading, status, start}
}

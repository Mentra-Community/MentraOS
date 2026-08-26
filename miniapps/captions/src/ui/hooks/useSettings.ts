import {useEffect, useRef, useState} from "react"

import type {CaptionPosition, CaptionSettings, CaptionsDisplayCapabilities} from "../../shared/types"

export type {CaptionSettings} from "../../shared/types"

/**
 * useSettings — thin hook over the background channel bus.
 *
 * Replaces the cloud app's REST fetch/POST hook. Reads come from the
 * `captions:snapshot` (initial) and `captions:settings-update` (on change)
 * channels; writes go out as `captions:set-*` broadcasts. Each updater
 * optimistically updates local state and resolves true (the background is the
 * source of truth and echoes a settings-update for confirmation).
 */
export function useSettings() {
  const [settings, setSettings] = useState<CaptionSettings | null>(null)
  const [canPosition, setCanPosition] = useState(false)
  const [loading, setLoading] = useState(true)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    const offs: Array<() => void> = []
    const on = mentra.on as (c: string, cb: (p: unknown) => void) => () => void

    offs.push(
      on("captions:snapshot", (payload) => {
        if (!mountedRef.current) return
        const snapshot = payload as {
          settings: CaptionSettings
          displayCapabilities?: CaptionsDisplayCapabilities
        }
        setSettings(snapshot.settings)
        setCanPosition(snapshot.displayCapabilities?.canPosition === true)
        setLoading(false)
      }),
    )

    offs.push(
      on("captions:display-capabilities", (payload) => {
        if (!mountedRef.current) return
        setCanPosition((payload as CaptionsDisplayCapabilities).canPosition === true)
      }),
    )

    offs.push(
      on("captions:settings-update", (payload) => {
        if (!mountedRef.current) return
        setSettings(payload as CaptionSettings)
        setLoading(false)
      }),
    )

    return () => {
      mountedRef.current = false
      for (const off of offs) off()
    }
  }, [])

  const updateLanguage = async (language: string): Promise<boolean> => {
    setSettings((prev) => (prev ? {...prev, language} : prev))
    mentra.send("captions:set-language", {language})
    return true
  }

  const updateHints = async (hints: string[]): Promise<boolean> => {
    setSettings((prev) => (prev ? {...prev, languageHints: hints} : prev))
    mentra.send("captions:set-language-hints", {hints})
    return true
  }

  const updateUseOfflineStt = async (enabled: boolean): Promise<boolean> => {
    setSettings((prev) => (prev ? {...prev, useOfflineStt: enabled} : prev))
    mentra.send("captions:set-use-offline-stt", {enabled})
    return true
  }

  const updateDisplayLines = async (lines: number): Promise<boolean> => {
    setSettings((prev) => (prev ? {...prev, displayLines: lines} : prev))
    mentra.send("captions:set-display-lines", {lines})
    return true
  }

  const updateDisplayWidth = async (width: number): Promise<boolean> => {
    setSettings((prev) => (prev ? {...prev, displayWidth: width} : prev))
    mentra.send("captions:set-display-width", {width})
    return true
  }

  const updateCaptionPosition = async (position: CaptionPosition): Promise<boolean> => {
    setSettings((prev) => (prev ? {...prev, captionPosition: position} : prev))
    mentra.send("captions:set-caption-position", {position})
    return true
  }

  const updateWordBreaking = async (enabled: boolean): Promise<boolean> => {
    setSettings((prev) => (prev ? {...prev, wordBreaking: enabled} : prev))
    mentra.send("captions:set-word-breaking", {enabled})
    return true
  }

  const updateCaptionTimeoutSeconds = async (seconds: number): Promise<boolean> => {
    setSettings((prev) => (prev ? {...prev, captionTimeoutSeconds: seconds} : prev))
    mentra.send("captions:set-caption-timeout", {seconds})
    return true
  }

  return {
    settings,
    canPosition,
    loading,
    error: null as string | null,
    updateLanguage,
    updateHints,
    updateUseOfflineStt,
    updateDisplayLines,
    updateDisplayWidth,
    updateCaptionPosition,
    updateWordBreaking,
    updateCaptionTimeoutSeconds,
  }
}
